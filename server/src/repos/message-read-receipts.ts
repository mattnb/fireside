import type { Database } from 'better-sqlite3';
import type { AgentId } from '../agents/types.js';

export interface MessageReadReceipt {
  roomId: string;
  messageId: string;
  agentId: AgentId;
  runId: string | null;
  seenAt: number;
}

interface MessageReadReceiptRow {
  room_id: string;
  message_id: string;
  agent_id: AgentId;
  run_id: string | null;
  seen_at: number;
}

function rowToReceipt(row: MessageReadReceiptRow): MessageReadReceipt {
  return {
    roomId: row.room_id,
    messageId: row.message_id,
    agentId: row.agent_id,
    runId: row.run_id,
    seenAt: row.seen_at,
  };
}

export function recordMessageReadReceipts(
  db: Database,
  input: {
    roomId: string;
    agentId: AgentId;
    runId: string | null;
    messageIds: string[];
    seenAt?: number;
  },
): MessageReadReceipt[] {
  const seenAt = input.seenAt ?? Date.now();
  const uniqueMessageIds = [...new Set(input.messageIds)].filter(Boolean);
  if (uniqueMessageIds.length === 0) return [];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO message_read_receipts (
       room_id, message_id, agent_id, run_id, seen_at
     )
     SELECT m.room_id, m.id, ?, ?, ?
     FROM messages m
     WHERE m.room_id = ?
       AND m.id = ?
       AND NOT (m.author_kind = 'agent' AND m.author_id = ?)`,
  );
  const select = db.prepare(
    `SELECT room_id, message_id, agent_id, run_id, seen_at
     FROM message_read_receipts
     WHERE message_id = ? AND agent_id = ?`,
  );
  const created: MessageReadReceipt[] = [];

  const record = db.transaction((messageIds: string[]) => {
    for (const messageId of messageIds) {
      const result = insert.run(
        input.agentId,
        input.runId,
        seenAt,
        input.roomId,
        messageId,
        input.agentId,
      );
      if (result.changes === 0) continue;
      const row = select.get(messageId, input.agentId) as MessageReadReceiptRow | undefined;
      if (row) created.push(rowToReceipt(row));
    }
  });

  record(uniqueMessageIds);
  return created;
}

export function listMessageReadReceiptsForRoom(
  db: Database,
  roomId: string,
): MessageReadReceipt[] {
  const rows = db
    .prepare(
      `SELECT room_id, message_id, agent_id, run_id, seen_at
       FROM message_read_receipts
       WHERE room_id = ?
       ORDER BY seen_at ASC, agent_id ASC`,
    )
    .all(roomId) as MessageReadReceiptRow[];
  return rows.map(rowToReceipt);
}

export function listSeenAgentsByMessage(
  db: Database,
  roomId: string,
  messageIds: string[],
): Map<string, AgentId[]> {
  const uniqueMessageIds = [...new Set(messageIds)].filter(Boolean);
  const seen = new Map<string, AgentId[]>();
  for (const messageId of uniqueMessageIds) seen.set(messageId, []);
  if (uniqueMessageIds.length === 0) return seen;

  const placeholders = uniqueMessageIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT message_id, agent_id
       FROM message_read_receipts
       WHERE room_id = ?
         AND message_id IN (${placeholders})
       ORDER BY seen_at ASC, agent_id ASC`,
    )
    .all(roomId, ...uniqueMessageIds) as Array<{ message_id: string; agent_id: AgentId }>;

  for (const row of rows) {
    const agents = seen.get(row.message_id) ?? [];
    agents.push(row.agent_id);
    seen.set(row.message_id, agents);
  }
  return seen;
}
