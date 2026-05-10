import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';
import type { PermissionMode } from '../permissions.js';

export type TaskStatus = 'active' | 'paused' | 'blocked' | 'verifying' | 'done';

export type ProposalStatus =
  | 'draft'
  | 'elaborating'
  | 'proposed'
  | 'approved'
  | 'executing'
  | 'verifying'
  | 'done'
  | 'rejected';

export interface Task {
  id: string;
  roomId: string;
  title: string;
  goal: string;
  repoPath: string;
  acceptanceCriteria: string;
  agents: AgentId[];
  status: TaskStatus;
  capabilityProfile: PermissionMode;
  summary: string;
  proposalStatus: ProposalStatus;
  verifierAgentId: string | null;
  proposedByAgentId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface TaskRow {
  id: string;
  room_id: string;
  title: string;
  goal: string;
  repo_path: string;
  acceptance_criteria: string;
  agents_json: string;
  status: TaskStatus;
  capability_profile: PermissionMode;
  summary: string;
  proposal_status: ProposalStatus;
  verifier_agent_id: string | null;
  proposed_by_agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateTaskInput {
  roomId: string;
  title: string;
  goal?: string;
  repoPath?: string;
  acceptanceCriteria?: string;
  agents?: AgentId[];
  status?: TaskStatus;
  capabilityProfile?: PermissionMode;
  summary?: string;
  proposalStatus?: ProposalStatus;
  verifierAgentId?: string | null;
  proposedByAgentId?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  goal?: string;
  repoPath?: string;
  acceptanceCriteria?: string;
  agents?: AgentId[];
  status?: TaskStatus;
  capabilityProfile?: PermissionMode;
  summary?: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    goal: row.goal,
    repoPath: row.repo_path,
    acceptanceCriteria: row.acceptance_criteria,
    agents: JSON.parse(row.agents_json) as AgentId[],
    status: row.status,
    capabilityProfile: row.capability_profile,
    summary: row.summary,
    proposalStatus: row.proposal_status,
    verifierAgentId: row.verifier_agent_id,
    proposedByAgentId: row.proposed_by_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pauseOtherActiveTasks(db: Database, roomId: string, exceptTaskId?: string): void {
  if (exceptTaskId) {
    db.prepare(
      `UPDATE tasks
       SET status = 'paused', updated_at = ?
       WHERE room_id = ? AND status IN ('active', 'blocked', 'verifying') AND id <> ?`,
    ).run(Date.now(), roomId, exceptTaskId);
    return;
  }
  db.prepare(
    `UPDATE tasks
     SET status = 'paused', updated_at = ?
     WHERE room_id = ? AND status IN ('active', 'blocked', 'verifying')`,
  ).run(Date.now(), roomId);
}

export function createTask(db: Database, input: CreateTaskInput): Task {
  const id = nanoid(14);
  const now = Date.now();
  const status = input.status ?? 'active';
  const agents = input.agents ?? [];
  const tx = db.transaction(() => {
    if (['active', 'blocked', 'verifying'].includes(status)) {
      pauseOtherActiveTasks(db, input.roomId);
    }
    db.prepare(
      `INSERT INTO tasks (
        id, room_id, title, goal, repo_path, acceptance_criteria, agents_json, status,
        capability_profile, summary, proposal_status, verifier_agent_id, proposed_by_agent_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.roomId,
      input.title,
      input.goal ?? '',
      input.repoPath ?? '',
      input.acceptanceCriteria ?? '',
      JSON.stringify(agents),
      status,
      input.capabilityProfile ?? 'plan',
      input.summary ?? '',
      input.proposalStatus ?? 'approved',
      input.verifierAgentId ?? null,
      input.proposedByAgentId ?? null,
      now,
      now,
    );
  });
  tx();
  return getTask(db, id)!;
}

export function getTask(db: Database, id: string): Task | null {
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function getActiveTask(db: Database, roomId: string): Task | null {
  const row = db
    .prepare(
      `SELECT * FROM tasks
       WHERE room_id = ? AND status IN ('active', 'blocked', 'verifying')
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'verifying' THEN 1 ELSE 2 END, updated_at DESC
       LIMIT 1`,
    )
    .get(roomId) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function listTasks(db: Database, roomId: string): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE room_id = ?
       ORDER BY
         CASE status WHEN 'active' THEN 0 WHEN 'verifying' THEN 1 WHEN 'blocked' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END,
         updated_at DESC`,
    )
    .all(roomId) as TaskRow[];
  return rows.map(rowToTask);
}

// Legal state-machine transitions for proposal_status. Same-state writes are
// tolerated by setProposalStatus for idempotency; only true edges are listed
// here.
const LEGAL_PROPOSAL_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
  draft: ['elaborating', 'proposed', 'rejected'],
  elaborating: ['proposed', 'rejected'],
  proposed: ['elaborating', 'approved', 'rejected'],
  approved: ['executing'],
  executing: ['verifying'],
  verifying: ['done'],
  done: [],
  rejected: [],
};

export function setProposalStatus(
  db: Database,
  taskId: string,
  next: ProposalStatus,
  byAgentId: string,
): Task | null {
  const existing = getTask(db, taskId);
  if (!existing) return null;
  if (existing.proposalStatus === next) return existing;
  const allowed = LEGAL_PROPOSAL_TRANSITIONS[existing.proposalStatus];
  if (!allowed.includes(next)) {
    throw new Error(
      `illegal transition: ${existing.proposalStatus} → ${next} (task ${taskId})`,
    );
  }
  const now = Date.now();
  if (next === 'proposed') {
    db.prepare(
      `UPDATE tasks
         SET proposal_status = ?, proposed_by_agent_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(next, byAgentId, now, taskId);
  } else {
    db.prepare(
      `UPDATE tasks
         SET proposal_status = ?, updated_at = ?
       WHERE id = ?`,
    ).run(next, now, taskId);
  }
  return getTask(db, taskId);
}

export function updateTask(db: Database, id: string, input: UpdateTaskInput): Task | null {
  const existing = getTask(db, id);
  if (!existing) return null;

  const updated: Task = {
    ...existing,
    ...('title' in input ? { title: input.title ?? '' } : {}),
    ...('goal' in input ? { goal: input.goal ?? '' } : {}),
    ...('repoPath' in input ? { repoPath: input.repoPath ?? '' } : {}),
    ...('acceptanceCriteria' in input
      ? { acceptanceCriteria: input.acceptanceCriteria ?? '' }
      : {}),
    ...('agents' in input ? { agents: input.agents ?? [] } : {}),
    ...('status' in input ? { status: input.status ?? existing.status } : {}),
    ...('capabilityProfile' in input
      ? { capabilityProfile: input.capabilityProfile ?? existing.capabilityProfile }
      : {}),
    ...('summary' in input ? { summary: input.summary ?? '' } : {}),
    updatedAt: Date.now(),
  };

  const tx = db.transaction(() => {
    if (['active', 'blocked', 'verifying'].includes(updated.status)) {
      pauseOtherActiveTasks(db, updated.roomId, updated.id);
    }
    db.prepare(
      `UPDATE tasks
       SET title = ?, goal = ?, repo_path = ?, acceptance_criteria = ?, agents_json = ?, status = ?,
           capability_profile = ?, summary = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      updated.title,
      updated.goal,
      updated.repoPath,
      updated.acceptanceCriteria,
      JSON.stringify(updated.agents),
      updated.status,
      updated.capabilityProfile,
      updated.summary,
      updated.updatedAt,
      id,
    );
  });
  tx();
  return getTask(db, id);
}
