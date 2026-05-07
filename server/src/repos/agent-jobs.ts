import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';

export type AgentJobStatus =
  | 'queued'
  | 'leased'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'superseded';

export interface AgentJob {
  id: string;
  roomId: string;
  taskId: string | null;
  checklistItemId: string | null;
  agentId: AgentId;
  triggerMessageId: string;
  runId: string | null;
  status: AgentJobStatus;
  workPacketJson: string;
  permissionJson: string;
  leaseOwner: string;
  leaseExpiresAt: number;
  attempt: number;
  maxAttempts: number;
  error: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface AgentJobRow {
  id: string;
  room_id: string;
  task_id: string | null;
  checklist_item_id: string | null;
  agent_id: AgentId;
  trigger_message_id: string;
  run_id: string | null;
  status: AgentJobStatus;
  work_packet_json: string;
  permission_json: string;
  lease_owner: string;
  lease_expires_at: number;
  attempt: number;
  max_attempts: number;
  error: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

type AgentJobLightRow = Omit<AgentJobRow, 'work_packet_json' | 'permission_json'> & {
  work_packet_json?: string;
  permission_json?: string;
};

const AGENT_JOB_LIGHT_COLUMNS = `
  id, room_id, task_id, checklist_item_id, agent_id, trigger_message_id, run_id, status,
  '' AS work_packet_json, '' AS permission_json, lease_owner, lease_expires_at, attempt,
  max_attempts, error, created_at, updated_at, completed_at
`;

export interface CreateAgentJobInput {
  roomId: string;
  taskId?: string | null;
  checklistItemId?: string | null;
  agentId: AgentId;
  triggerMessageId: string;
  workPacketJson?: string;
  permissionJson?: string;
  attempt?: number;
  maxAttempts?: number;
}

export interface CreateAgentJobIfAvailableResult {
  job: AgentJob;
  created: boolean;
}

export interface LeaseAgentJobInput {
  leaseOwner: string;
  leaseMs: number;
  now?: number;
}

function rowToAgentJob(row: AgentJobRow | AgentJobLightRow): AgentJob {
  return {
    id: row.id,
    roomId: row.room_id,
    taskId: row.task_id,
    checklistItemId: row.checklist_item_id,
    agentId: row.agent_id,
    triggerMessageId: row.trigger_message_id,
    runId: row.run_id,
    status: row.status,
    workPacketJson: row.work_packet_json ?? '',
    permissionJson: row.permission_json ?? '',
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function compactTerminalWorkPacketJson(json: string): string {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}';
    const packet = parsed as Record<string, unknown>;
    return JSON.stringify({
      mission: packet.mission ?? null,
      assignedItem: packet.assignedItem ?? null,
      permission: packet.permission ?? null,
      promptStats: packet.promptStats ?? null,
      retained: 'terminal-summary',
    });
  } catch {
    return '{}';
  }
}

function terminalWorkPacketJson(db: Database, id: string): string {
  const row = db
    .prepare(`SELECT work_packet_json FROM agent_jobs WHERE id = ?`)
    .get(id) as { work_packet_json: string } | undefined;
  return compactTerminalWorkPacketJson(row?.work_packet_json ?? '{}');
}

function normalizeAttempt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.trunc(value) : fallback;
}

function normalizeLeaseMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 5 * 60_000;
}

export function getActiveAgentJobForTrigger(
  db: Database,
  input: { roomId: string; agentId: AgentId; triggerMessageId: string },
): AgentJob | null {
  const row = db
    .prepare(
      `SELECT * FROM agent_jobs
       WHERE room_id = ?
         AND agent_id = ?
         AND trigger_message_id = ?
         AND status IN ('queued', 'leased', 'running')
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
    )
    .get(input.roomId, input.agentId, input.triggerMessageId) as AgentJobRow | undefined;
  return row ? rowToAgentJob(row) : null;
}

export function createAgentJob(db: Database, input: CreateAgentJobInput): AgentJob {
  const id = nanoid(16);
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_jobs (
      id, room_id, task_id, checklist_item_id, agent_id, trigger_message_id, run_id, status,
      work_packet_json, permission_json, lease_owner, lease_expires_at, attempt, max_attempts,
      error, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'queued', ?, ?, '', 0, ?, ?, '', ?, ?, NULL)`,
  ).run(
    id,
    input.roomId,
    input.taskId ?? null,
    input.checklistItemId ?? null,
    input.agentId,
    input.triggerMessageId,
    input.workPacketJson ?? '{}',
    input.permissionJson ?? '{}',
    normalizeAttempt(input.attempt, 1),
    normalizeAttempt(input.maxAttempts, 3),
    now,
    now,
  );
  return getAgentJob(db, id)!;
}

export function createAgentJobIfAvailable(
  db: Database,
  input: CreateAgentJobInput,
): CreateAgentJobIfAvailableResult {
  const tx = db.transaction((): CreateAgentJobIfAvailableResult => {
    const id = nanoid(16);
    const now = Date.now();
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO agent_jobs (
          id, room_id, task_id, checklist_item_id, agent_id, trigger_message_id, run_id, status,
          work_packet_json, permission_json, lease_owner, lease_expires_at, attempt, max_attempts,
          error, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'queued', ?, ?, '', 0, ?, ?, '', ?, ?, NULL)`,
      )
      .run(
        id,
        input.roomId,
        input.taskId ?? null,
        input.checklistItemId ?? null,
        input.agentId,
        input.triggerMessageId,
        input.workPacketJson ?? '{}',
        input.permissionJson ?? '{}',
        normalizeAttempt(input.attempt, 1),
        normalizeAttempt(input.maxAttempts, 3),
        now,
        now,
      );
    if (result.changes === 1) {
      return { job: getAgentJob(db, id)!, created: true };
    }
    const existing = getActiveAgentJobForTrigger(db, {
      roomId: input.roomId,
      agentId: input.agentId,
      triggerMessageId: input.triggerMessageId,
    });
    if (existing) return { job: existing, created: false };

    // A generated id collision is vanishingly unlikely, but retry once so callers
    // only see false when there is a real active single-flight job.
    const retry = createAgentJob(db, input);
    return { job: retry, created: true };
  });
  return tx();
}

export function getAgentJob(db: Database, id: string): AgentJob | null {
  const row = db.prepare(`SELECT * FROM agent_jobs WHERE id = ?`).get(id) as
    | AgentJobRow
    | undefined;
  return row ? rowToAgentJob(row) : null;
}

export function getAgentJobByRunId(db: Database, runId: string): AgentJob | null {
  const row = db.prepare(`SELECT * FROM agent_jobs WHERE run_id = ?`).get(runId) as
    | AgentJobRow
    | undefined;
  return row ? rowToAgentJob(row) : null;
}

export function leaseAgentJob(
  db: Database,
  id: string,
  input: LeaseAgentJobInput,
): AgentJob | null {
  const now = input.now ?? Date.now();
  db.prepare(
    `UPDATE agent_jobs
     SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
     WHERE id = ?
       AND status IN ('queued', 'leased')
       AND (status = 'queued' OR lease_expires_at <= ? OR lease_owner = ?)`,
  ).run(
    input.leaseOwner,
    now + normalizeLeaseMs(input.leaseMs),
    now,
    id,
    now,
    input.leaseOwner,
  );
  return getAgentJob(db, id);
}

export function attachAgentJobRun(
  db: Database,
  id: string,
  runId: string,
  input: LeaseAgentJobInput,
): AgentJob | null {
  const now = input.now ?? Date.now();
  db.prepare(
    `UPDATE agent_jobs
     SET status = 'running', run_id = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('queued', 'leased', 'running')`,
  ).run(runId, input.leaseOwner, now + normalizeLeaseMs(input.leaseMs), now, id);
  return getAgentJob(db, id);
}

export function renewAgentJobLease(
  db: Database,
  id: string,
  input: LeaseAgentJobInput,
): AgentJob | null {
  const now = input.now ?? Date.now();
  db.prepare(
    `UPDATE agent_jobs
     SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('leased', 'running')`,
  ).run(input.leaseOwner, now + normalizeLeaseMs(input.leaseMs), now, id);
  return getAgentJob(db, id);
}

export function completeAgentJob(db: Database, id: string, now = Date.now()): AgentJob | null {
  const workPacketJson = terminalWorkPacketJson(db, id);
  db.prepare(
    `UPDATE agent_jobs
     SET status = 'completed', work_packet_json = ?, permission_json = '{}',
         lease_expires_at = 0, error = '', updated_at = ?, completed_at = ?
     WHERE id = ?`,
  ).run(workPacketJson, now, now, id);
  return getAgentJob(db, id);
}

export function failAgentJob(
  db: Database,
  id: string,
  error: string,
  now = Date.now(),
): AgentJob | null {
  const workPacketJson = terminalWorkPacketJson(db, id);
  db.prepare(
    `UPDATE agent_jobs
     SET status = 'failed', work_packet_json = ?, permission_json = '{}',
         lease_expires_at = 0, error = ?, updated_at = ?, completed_at = ?
     WHERE id = ?`,
  ).run(workPacketJson, error, now, now, id);
  return getAgentJob(db, id);
}

export function cancelAgentJob(
  db: Database,
  id: string,
  reason: string,
  now = Date.now(),
): AgentJob | null {
  const workPacketJson = terminalWorkPacketJson(db, id);
  db.prepare(
    `UPDATE agent_jobs
     SET status = 'canceled', work_packet_json = ?, permission_json = '{}',
         lease_expires_at = 0, error = ?, updated_at = ?, completed_at = ?
     WHERE id = ?`,
  ).run(workPacketJson, reason, now, now, id);
  return getAgentJob(db, id);
}

export function listAgentJobsForRoom(
  db: Database,
  roomId: string,
  limit = 100,
): AgentJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_jobs
       WHERE room_id = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(roomId, limit) as AgentJobRow[];
  return rows.map(rowToAgentJob);
}

export function listActiveAgentJobsForRoom(db: Database, roomId: string): AgentJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_jobs
       WHERE room_id = ? AND status IN ('queued', 'leased', 'running')
       ORDER BY created_at ASC, id ASC`,
    )
    .all(roomId) as AgentJobRow[];
  return rows.map(rowToAgentJob);
}

export function listActiveAgentJobSummariesForRoom(db: Database, roomId: string): AgentJob[] {
  const rows = db
    .prepare(
      `SELECT ${AGENT_JOB_LIGHT_COLUMNS}
       FROM agent_jobs
       WHERE room_id = ? AND status IN ('queued', 'leased', 'running')
       ORDER BY created_at ASC, id ASC`,
    )
    .all(roomId) as AgentJobLightRow[];
  return rows.map(rowToAgentJob);
}

export function trimTerminalAgentJobPayloads(db: Database): number {
  const rows = db
    .prepare(
      `SELECT id, work_packet_json
       FROM agent_jobs
       WHERE status NOT IN ('queued', 'leased', 'running')
         AND (permission_json <> '{}' OR instr(work_packet_json, '"retained":"terminal-summary"') = 0)`,
    )
    .all() as Pick<AgentJobRow, 'id' | 'work_packet_json'>[];
  const update = db.prepare(
    `UPDATE agent_jobs
     SET work_packet_json = ?, permission_json = '{}'
     WHERE id = ?`,
  );
  const apply = db.transaction((jobs: Pick<AgentJobRow, 'id' | 'work_packet_json'>[]) => {
    for (const job of jobs) {
      update.run(compactTerminalWorkPacketJson(job.work_packet_json), job.id);
    }
  });
  apply(rows);
  return rows.length;
}

export function recoverInterruptedAgentJobs(
  db: Database,
  now = Date.now(),
): AgentJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_jobs
       WHERE status IN ('leased', 'running')
       ORDER BY updated_at ASC, id ASC`,
    )
    .all() as AgentJobRow[];
  const recovered: AgentJob[] = [];
  for (const row of rows) {
    const job = cancelAgentJob(
      db,
      row.id,
      'Fireside restarted before this durable agent job completed.',
      now,
    );
    if (job) recovered.push(job);
  }
  return recovered;
}
