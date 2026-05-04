import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';
import type { MissionWorkDispatch } from '../routing/mission-work-router.js';

export type AgentTurnOutcomeStatus =
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'empty'
  | 'permission-requested'
  | 'retry-scheduled';

export interface AgentTurnOutcome {
  id: string;
  roomId: string;
  taskId: string | null;
  runId: string;
  agentId: AgentId;
  visibleMessageId: string | null;
  visibleMessageEmitted: boolean;
  status: AgentTurnOutcomeStatus;
  progressed: boolean;
  failed: boolean;
  error: string;
  missionUpdates: number;
  missionReceipts: number;
  missionReconciliations: number;
  collaborationNotes: number;
  draftArtifacts: number;
  permissionRequestId: string | null;
  permissionAutoApproved: boolean;
  workDispatches: Array<{
    agentId: AgentId;
    itemId: string;
    title: string;
    reason: string;
  }>;
  nextAgents: AgentId[];
  summary: string;
  createdAt: number;
}

interface AgentTurnOutcomeRow {
  id: string;
  room_id: string;
  task_id: string | null;
  run_id: string;
  agent_id: AgentId;
  visible_message_id: string | null;
  visible_message_emitted: number;
  status: AgentTurnOutcomeStatus;
  progressed: number;
  failed: number;
  error: string;
  mission_updates: number;
  mission_receipts: number;
  mission_reconciliations: number;
  collaboration_notes: number;
  draft_artifacts: number;
  permission_request_id: string | null;
  permission_auto_approved: number;
  work_dispatches_json: string;
  next_agents_json: string;
  summary: string;
  created_at: number;
}

export interface RecordAgentTurnOutcomeInput {
  roomId: string;
  taskId?: string | null;
  runId: string;
  agentId: AgentId;
  visibleMessageId?: string | null;
  visibleMessageEmitted?: boolean;
  status: AgentTurnOutcomeStatus;
  progressed?: boolean;
  failed?: boolean;
  error?: string;
  missionUpdates?: number;
  missionReceipts?: number;
  missionReconciliations?: number;
  collaborationNotes?: number;
  draftArtifacts?: number;
  permissionRequestId?: string | null;
  permissionAutoApproved?: boolean;
  workDispatches?: MissionWorkDispatch[];
  nextAgents?: AgentId[];
  summary?: string;
}

function parseJsonArray<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function rowToAgentTurnOutcome(row: AgentTurnOutcomeRow): AgentTurnOutcome {
  return {
    id: row.id,
    roomId: row.room_id,
    taskId: row.task_id,
    runId: row.run_id,
    agentId: row.agent_id,
    visibleMessageId: row.visible_message_id,
    visibleMessageEmitted: row.visible_message_emitted === 1,
    status: row.status,
    progressed: row.progressed === 1,
    failed: row.failed === 1,
    error: row.error,
    missionUpdates: row.mission_updates,
    missionReceipts: row.mission_receipts,
    missionReconciliations: row.mission_reconciliations,
    collaborationNotes: row.collaboration_notes,
    draftArtifacts: row.draft_artifacts,
    permissionRequestId: row.permission_request_id,
    permissionAutoApproved: row.permission_auto_approved === 1,
    workDispatches: parseJsonArray<AgentTurnOutcome['workDispatches'][number]>(
      row.work_dispatches_json,
    ),
    nextAgents: parseJsonArray<AgentId>(row.next_agents_json),
    summary: row.summary,
    createdAt: row.created_at,
  };
}

export function recordAgentTurnOutcome(
  db: Database,
  input: RecordAgentTurnOutcomeInput,
): AgentTurnOutcome {
  const id = nanoid(16);
  const now = Date.now();
  const workDispatches = (input.workDispatches ?? []).map((dispatch) => ({
    agentId: dispatch.agentId,
    itemId: dispatch.item.id,
    title: dispatch.item.title,
    reason: dispatch.reason,
  }));
  const nextAgents =
    input.nextAgents ??
    workDispatches.map((dispatch) => dispatch.agentId).filter((agent, index, all) => all.indexOf(agent) === index);

  db.prepare(
    `INSERT INTO agent_turn_outcomes (
      id, room_id, task_id, run_id, agent_id, visible_message_id, visible_message_emitted,
      status, progressed, failed, error, mission_updates, mission_receipts, mission_reconciliations,
      collaboration_notes, draft_artifacts, permission_request_id, permission_auto_approved,
      work_dispatches_json, next_agents_json, summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      task_id = excluded.task_id,
      visible_message_id = excluded.visible_message_id,
      visible_message_emitted = excluded.visible_message_emitted,
      status = excluded.status,
      progressed = excluded.progressed,
      failed = excluded.failed,
      error = excluded.error,
      mission_updates = excluded.mission_updates,
      mission_receipts = excluded.mission_receipts,
      mission_reconciliations = excluded.mission_reconciliations,
      collaboration_notes = excluded.collaboration_notes,
      draft_artifacts = excluded.draft_artifacts,
      permission_request_id = excluded.permission_request_id,
      permission_auto_approved = excluded.permission_auto_approved,
      work_dispatches_json = excluded.work_dispatches_json,
      next_agents_json = excluded.next_agents_json,
      summary = excluded.summary`,
  ).run(
    id,
    input.roomId,
    input.taskId ?? null,
    input.runId,
    input.agentId,
    input.visibleMessageId ?? null,
    input.visibleMessageEmitted === true ? 1 : 0,
    input.status,
    input.progressed === true ? 1 : 0,
    input.failed === true ? 1 : 0,
    input.error?.slice(0, 2000) ?? '',
    input.missionUpdates ?? 0,
    input.missionReceipts ?? 0,
    input.missionReconciliations ?? 0,
    input.collaborationNotes ?? 0,
    input.draftArtifacts ?? 0,
    input.permissionRequestId ?? null,
    input.permissionAutoApproved === true ? 1 : 0,
    JSON.stringify(workDispatches),
    JSON.stringify(nextAgents),
    input.summary?.slice(0, 2000) ?? '',
    now,
  );
  return getAgentTurnOutcome(db, input.runId)!;
}

export function getAgentTurnOutcome(
  db: Database,
  runId: string,
): AgentTurnOutcome | null {
  const row = db.prepare(`SELECT * FROM agent_turn_outcomes WHERE run_id = ?`).get(runId) as
    | AgentTurnOutcomeRow
    | undefined;
  return row ? rowToAgentTurnOutcome(row) : null;
}

export function listAgentTurnOutcomesForRoom(
  db: Database,
  roomId: string,
  limit = 100,
): AgentTurnOutcome[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_turn_outcomes
       WHERE room_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(roomId, limit) as AgentTurnOutcomeRow[];
  return rows.map(rowToAgentTurnOutcome);
}
