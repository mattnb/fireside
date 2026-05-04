import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';
import type { RoutingRuleTrace } from '../routing/agent-references.js';

export type RoutingDecisionKind = 'human-message' | 'agent-message' | 'mission-work';

export interface RoutingDecisionRecord {
  id: string;
  roomId: string;
  taskId: string | null;
  runId: string | null;
  messageId: string | null;
  authorId: string;
  kind: RoutingDecisionKind;
  action: string;
  reason: string;
  responders: AgentId[];
  trace: RoutingRuleTrace[];
  createdAt: number;
}

interface RoutingDecisionRow {
  id: string;
  room_id: string;
  task_id: string | null;
  run_id: string | null;
  message_id: string | null;
  author_id: string;
  kind: RoutingDecisionKind;
  action: string;
  reason: string;
  responders_json: string;
  trace_json: string;
  created_at: number;
}

export interface CreateRoutingDecisionInput {
  roomId: string;
  taskId?: string | null;
  runId?: string | null;
  messageId?: string | null;
  authorId?: string;
  kind: RoutingDecisionKind;
  action: string;
  reason?: string;
  responders?: AgentId[];
  trace?: RoutingRuleTrace[];
}

function parseJsonArray<T>(json: string, fallback: T[]): T[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function rowToRoutingDecision(row: RoutingDecisionRow): RoutingDecisionRecord {
  return {
    id: row.id,
    roomId: row.room_id,
    taskId: row.task_id,
    runId: row.run_id,
    messageId: row.message_id,
    authorId: row.author_id,
    kind: row.kind,
    action: row.action,
    reason: row.reason,
    responders: parseJsonArray<AgentId>(row.responders_json, []),
    trace: parseJsonArray<RoutingRuleTrace>(row.trace_json, []),
    createdAt: row.created_at,
  };
}

export function createRoutingDecision(
  db: Database,
  input: CreateRoutingDecisionInput,
): RoutingDecisionRecord {
  const id = nanoid(16);
  const now = Date.now();
  db.prepare(
    `INSERT INTO routing_decisions (
      id, room_id, task_id, run_id, message_id, author_id, kind, action, reason,
      responders_json, trace_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.roomId,
    input.taskId ?? null,
    input.runId ?? null,
    input.messageId ?? null,
    input.authorId?.slice(0, 120) ?? '',
    input.kind,
    input.action.slice(0, 120),
    input.reason?.slice(0, 500) ?? '',
    JSON.stringify(input.responders ?? []),
    JSON.stringify(input.trace ?? []),
    now,
  );
  return getRoutingDecision(db, id)!;
}

export function getRoutingDecision(
  db: Database,
  id: string,
): RoutingDecisionRecord | null {
  const row = db.prepare(`SELECT * FROM routing_decisions WHERE id = ?`).get(id) as
    | RoutingDecisionRow
    | undefined;
  return row ? rowToRoutingDecision(row) : null;
}

export function listRoutingDecisionsForRoom(
  db: Database,
  roomId: string,
  limit = 100,
): RoutingDecisionRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM routing_decisions
       WHERE room_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(roomId, limit) as RoutingDecisionRow[];
  return rows.map(rowToRoutingDecision);
}
