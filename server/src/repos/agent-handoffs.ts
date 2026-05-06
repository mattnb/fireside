import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';

export type AgentHandoffStatus = 'pending' | 'delivered' | 'canceled';

export interface AgentHandoff {
  id: string;
  roomId: string;
  sourceMessageId: string;
  authorId: string;
  targetAgentId: AgentId;
  status: AgentHandoffStatus;
  deliveredRunId: string | null;
  createdAt: number;
  deliveredAt: number | null;
}

interface AgentHandoffRow {
  id: string;
  room_id: string;
  source_message_id: string;
  author_id: string;
  target_agent_id: AgentId;
  status: AgentHandoffStatus;
  delivered_run_id: string | null;
  created_at: number;
  delivered_at: number | null;
}

function rowToAgentHandoff(row: AgentHandoffRow): AgentHandoff {
  return {
    id: row.id,
    roomId: row.room_id,
    sourceMessageId: row.source_message_id,
    authorId: row.author_id,
    targetAgentId: row.target_agent_id,
    status: row.status,
    deliveredRunId: row.delivered_run_id,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

export function createPendingAgentHandoffs(
  db: Database,
  input: {
    roomId: string;
    sourceMessageId: string;
    authorId: string;
    targetAgentIds: AgentId[];
  },
): AgentHandoff[] {
  const uniqueTargets = input.targetAgentIds.filter(
    (agentId, index) => input.targetAgentIds.indexOf(agentId) === index,
  );
  if (uniqueTargets.length === 0) return [];
  const now = Date.now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO agent_handoffs (
      id, room_id, source_message_id, author_id, target_agent_id, status,
      delivered_run_id, created_at, delivered_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
  );
  const tx = db.transaction((targets: AgentId[]) => {
    for (const target of targets) {
      insert.run(nanoid(16), input.roomId, input.sourceMessageId, input.authorId, target, now);
    }
  });
  tx(uniqueTargets);
  return listPendingAgentHandoffsForMessage(db, input.roomId, input.sourceMessageId).filter(
    (handoff) => uniqueTargets.includes(handoff.targetAgentId),
  );
}

export function listPendingAgentHandoffsForMessage(
  db: Database,
  roomId: string,
  sourceMessageId: string,
): AgentHandoff[] {
  const rows = db
    .prepare(
      `SELECT *
       FROM agent_handoffs
       WHERE room_id = ?
         AND source_message_id = ?
         AND status = 'pending'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(roomId, sourceMessageId) as AgentHandoffRow[];
  return rows.map(rowToAgentHandoff);
}

export function listPendingAgentHandoffsForRoom(
  db: Database,
  roomId: string,
): AgentHandoff[] {
  const rows = db
    .prepare(
      `SELECT *
       FROM agent_handoffs
       WHERE room_id = ?
         AND status = 'pending'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(roomId) as AgentHandoffRow[];
  return rows.map(rowToAgentHandoff);
}

export function firstPendingAgentHandoffForAgent(
  db: Database,
  input: { roomId: string; targetAgentId: AgentId },
): AgentHandoff | null {
  const row = db
    .prepare(
      `SELECT *
       FROM agent_handoffs
       WHERE room_id = ?
         AND target_agent_id = ?
         AND status = 'pending'
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
    )
    .get(input.roomId, input.targetAgentId) as AgentHandoffRow | undefined;
  return row ? rowToAgentHandoff(row) : null;
}

export function markAgentHandoffDelivered(
  db: Database,
  input: { handoffId: string; deliveredRunId: string },
): AgentHandoff | null {
  db.prepare(
    `UPDATE agent_handoffs
     SET status = 'delivered',
         delivered_run_id = ?,
         delivered_at = ?
     WHERE id = ?
       AND status = 'pending'`,
  ).run(input.deliveredRunId, Date.now(), input.handoffId);
  return getAgentHandoff(db, input.handoffId);
}

export function getAgentHandoff(db: Database, id: string): AgentHandoff | null {
  const row = db.prepare(`SELECT * FROM agent_handoffs WHERE id = ?`).get(id) as
    | AgentHandoffRow
    | undefined;
  return row ? rowToAgentHandoff(row) : null;
}
