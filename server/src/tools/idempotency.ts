import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export const AGENT_TOOL_CALL_STATUSES = [
  'decoded',
  'validated',
  'applied',
  'rejected',
  'duplicate',
  'permission_pending',
  'permission_denied',
  'failed',
] as const;

export type AgentToolCallStatus = (typeof AGENT_TOOL_CALL_STATUSES)[number];

export interface AgentToolCallRow {
  id: string;
  room_id: string;
  mission_id: string | null;
  run_id: string | null;
  message_id: string | null;
  agent_id: string;
  tool_name: string;
  idempotency_key: string;
  source: string;
  status: AgentToolCallStatus;
  args_json: string;
  normalized_args_json: string;
  result_json: string;
  error: string;
  created_at: number;
  applied_at: number | null;
}

export interface RecordToolCallInput {
  id?: string;
  roomId: string;
  missionId?: string | null;
  runId?: string | null;
  messageId?: string | null;
  agentId: string;
  toolName: string;
  idempotencyKey: string;
  source: string;
  status: AgentToolCallStatus;
  args?: unknown;
  normalizedArgs?: unknown;
  result?: unknown;
  error?: string;
  now?: number;
}

export function lookupPriorCall(
  db: Database,
  idempotencyKey: string,
  missionId: string | null | undefined,
  roomId: string,
): AgentToolCallRow | null {
  const row = db
    .prepare(
      `SELECT *
       FROM agent_tool_calls
       WHERE idempotency_key = ?
         AND room_id = ?
         AND COALESCE(mission_id, '') = COALESCE(?, '')
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(idempotencyKey, roomId, missionId ?? null) as AgentToolCallRow | undefined;
  return row ?? null;
}

export function recordCall(db: Database, input: RecordToolCallInput): AgentToolCallRow {
  const now = input.now ?? Date.now();
  const id = input.id ?? nanoid(16);
  const appliedAt = input.status === 'applied' ? now : null;
  const row: AgentToolCallRow = {
    id,
    room_id: input.roomId,
    mission_id: input.missionId ?? null,
    run_id: input.runId ?? null,
    message_id: input.messageId ?? null,
    agent_id: input.agentId,
    tool_name: input.toolName,
    idempotency_key: input.idempotencyKey,
    source: input.source,
    status: input.status,
    args_json: JSON.stringify(input.args ?? {}),
    normalized_args_json: JSON.stringify(input.normalizedArgs ?? input.args ?? {}),
    result_json: JSON.stringify(input.result ?? {}),
    error: input.error ?? '',
    created_at: now,
    applied_at: appliedAt,
  };

  db.prepare(
    `INSERT INTO agent_tool_calls (
      id, room_id, mission_id, run_id, message_id, agent_id, tool_name, idempotency_key,
      source, status, args_json, normalized_args_json, result_json, error, created_at, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.room_id,
    row.mission_id,
    row.run_id,
    row.message_id,
    row.agent_id,
    row.tool_name,
    row.idempotency_key,
    row.source,
    row.status,
    row.args_json,
    row.normalized_args_json,
    row.result_json,
    row.error,
    row.created_at,
    row.applied_at,
  );

  return row;
}
