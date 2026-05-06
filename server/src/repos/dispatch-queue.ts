import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';
import type { RoutingRuleTrace } from '../routing/agent-references.js';

export type DispatchTargetKind = 'agent' | 'human' | 'broker';
export type DispatchQueueKind =
  | 'chat-message'
  | 'agent-handoff'
  | 'mission-work'
  | 'permission-followup'
  | 'system-repair';
export type DispatchQueueStatus =
  | 'pending'
  | 'leased'
  | 'delivered'
  | 'canceled'
  | 'failed'
  | 'superseded';

export interface DispatchQueueItem {
  id: string;
  roomId: string;
  sourceMessageId: string;
  authorId: string;
  targetKind: DispatchTargetKind;
  targetId: string;
  kind: DispatchQueueKind;
  status: DispatchQueueStatus;
  priority: number;
  availableAt: number;
  attemptCount: number;
  leaseOwner: string;
  leaseExpiresAt: number;
  deliveredRunId: string | null;
  routingTrace: RoutingRuleTrace[];
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  error: string;
}

interface DispatchQueueRow {
  id: string;
  room_id: string;
  source_message_id: string;
  author_id: string;
  target_kind: DispatchTargetKind;
  target_id: string;
  kind: DispatchQueueKind;
  status: DispatchQueueStatus;
  priority: number;
  available_at: number;
  attempt_count: number;
  lease_owner: string;
  lease_expires_at: number;
  delivered_run_id: string | null;
  routing_trace_json: string;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
  error: string;
}

function parseTrace(value: string): RoutingRuleTrace[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as RoutingRuleTrace[]) : [];
  } catch {
    return [];
  }
}

function rowToDispatchQueueItem(row: DispatchQueueRow): DispatchQueueItem {
  return {
    id: row.id,
    roomId: row.room_id,
    sourceMessageId: row.source_message_id,
    authorId: row.author_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    availableAt: row.available_at,
    attemptCount: row.attempt_count,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    deliveredRunId: row.delivered_run_id,
    routingTrace: parseTrace(row.routing_trace_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    error: row.error,
  };
}

export function createDispatchQueueItems(
  db: Database,
  input: {
    roomId: string;
    sourceMessageId: string;
    authorId: string;
    targetKind: DispatchTargetKind;
    targetIds: string[];
    kind: DispatchQueueKind;
    priority?: number | undefined;
    availableAt?: number | undefined;
    routingTrace?: RoutingRuleTrace[] | undefined;
  },
): DispatchQueueItem[] {
  const uniqueTargets = input.targetIds.filter(
    (targetId, index) => targetId && input.targetIds.indexOf(targetId) === index,
  );
  if (uniqueTargets.length === 0) return [];

  const now = Date.now();
  const priority = input.priority ?? 0;
  const availableAt = input.availableAt ?? now;
  const routingTraceJson = JSON.stringify(input.routingTrace ?? []);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO dispatch_queue (
      id, room_id, source_message_id, author_id, target_kind, target_id, kind,
      status, priority, available_at, attempt_count, lease_owner, lease_expires_at,
      delivered_run_id, routing_trace_json, created_at, updated_at, delivered_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, '', 0, NULL, ?, ?, ?, NULL, '')`,
  );
  const tx = db.transaction((targetIds: string[]) => {
    for (const [index, targetId] of targetIds.entries()) {
      const rowCreatedAt = now + index;
      insert.run(
        nanoid(16),
        input.roomId,
        input.sourceMessageId,
        input.authorId,
        input.targetKind,
        targetId,
        input.kind,
        priority,
        availableAt,
        routingTraceJson,
        rowCreatedAt,
        rowCreatedAt,
      );
    }
  });
  tx(uniqueTargets);
  return listPendingDispatchQueueItemsForMessage(db, input.roomId, input.sourceMessageId).filter(
    (item) =>
      item.targetKind === input.targetKind &&
      item.kind === input.kind &&
      uniqueTargets.includes(item.targetId),
  );
}

export function listPendingDispatchQueueItemsForRoom(
  db: Database,
  roomId: string,
  now = Date.now(),
): DispatchQueueItem[] {
  const rows = db
    .prepare(
      `SELECT *
       FROM dispatch_queue
       WHERE room_id = ?
         AND status = 'pending'
         AND available_at <= ?
       ORDER BY priority DESC, created_at ASC, id ASC`,
    )
    .all(roomId, now) as DispatchQueueRow[];
  return rows.map(rowToDispatchQueueItem);
}

export function listPendingDispatchQueueItemsForMessage(
  db: Database,
  roomId: string,
  sourceMessageId: string,
  now = Date.now(),
): DispatchQueueItem[] {
  const rows = db
    .prepare(
      `SELECT *
       FROM dispatch_queue
       WHERE room_id = ?
         AND source_message_id = ?
         AND status = 'pending'
         AND available_at <= ?
       ORDER BY priority DESC, created_at ASC, id ASC`,
    )
    .all(roomId, sourceMessageId, now) as DispatchQueueRow[];
  return rows.map(rowToDispatchQueueItem);
}

export function firstPendingDispatchQueueItemForAgent(
  db: Database,
  input: { roomId: string; agentId: AgentId; now?: number | undefined },
): DispatchQueueItem | null {
  const row = db
    .prepare(
      `SELECT *
       FROM dispatch_queue
       WHERE room_id = ?
         AND target_kind = 'agent'
         AND target_id = ?
         AND status = 'pending'
         AND available_at <= ?
       ORDER BY priority DESC, created_at ASC, id ASC
       LIMIT 1`,
    )
    .get(input.roomId, input.agentId, input.now ?? Date.now()) as DispatchQueueRow | undefined;
  return row ? rowToDispatchQueueItem(row) : null;
}

export function markDispatchQueueItemDelivered(
  db: Database,
  input: { id: string; deliveredRunId: string },
): DispatchQueueItem | null {
  const now = Date.now();
  db.prepare(
    `UPDATE dispatch_queue
     SET status = 'delivered',
         delivered_run_id = ?,
         delivered_at = ?,
         updated_at = ?
     WHERE id = ?
       AND status IN ('pending', 'leased')`,
  ).run(input.deliveredRunId, now, now, input.id);
  return getDispatchQueueItem(db, input.id);
}

export function leaseDispatchQueueItem(
  db: Database,
  input: { id: string; leaseOwner: string; leaseMs: number },
): DispatchQueueItem | null {
  const now = Date.now();
  db.prepare(
    `UPDATE dispatch_queue
     SET status = 'leased',
         attempt_count = attempt_count + 1,
         lease_owner = ?,
         lease_expires_at = ?,
         updated_at = ?
     WHERE id = ?
       AND status = 'pending'`,
  ).run(input.leaseOwner, now + input.leaseMs, now, input.id);
  return getDispatchQueueItem(db, input.id);
}

export function markDispatchQueueItemFailed(
  db: Database,
  input: { id: string; error: string },
): DispatchQueueItem | null {
  const now = Date.now();
  db.prepare(
    `UPDATE dispatch_queue
     SET status = 'failed',
         error = ?,
         updated_at = ?
     WHERE id = ?
       AND status IN ('pending', 'leased')`,
  ).run(input.error.slice(0, 1000), now, input.id);
  return getDispatchQueueItem(db, input.id);
}

export function getDispatchQueueItem(db: Database, id: string): DispatchQueueItem | null {
  const row = db.prepare(`SELECT * FROM dispatch_queue WHERE id = ?`).get(id) as
    | DispatchQueueRow
    | undefined;
  return row ? rowToDispatchQueueItem(row) : null;
}

export function recoverLeasedDispatchQueueItems(db: Database, now = Date.now()): number {
  const result = db
    .prepare(
      `UPDATE dispatch_queue
       SET status = 'pending',
           lease_owner = '',
           lease_expires_at = 0,
           updated_at = ?
       WHERE status = 'leased'
         AND lease_expires_at > 0
         AND lease_expires_at <= ?`,
    )
    .run(now, now);
  return result.changes;
}
