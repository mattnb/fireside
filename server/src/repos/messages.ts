// server/src/repos/messages.ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';
import { listSeenAgentsByMessage } from './message-read-receipts.js';

export type AuthorKind = 'human' | 'agent' | 'system';
export type MessageDeliveryStatus = 'queued' | 'delivered';

export interface Message {
  id: string;
  roomId: string;
  authorId: string;
  authorKind: AuthorKind;
  text: string;
  createdAt: number;
  deliveryStatus: MessageDeliveryStatus;
  seenBy: AgentId[];
}

interface MessageRow {
  id: string;
  room_id: string;
  author_id: string;
  author_kind: AuthorKind;
  text: string;
  created_at: number;
  delivery_status: MessageDeliveryStatus;
}

function rowToMessage(row: MessageRow, seenBy: AgentId[] = []): Message {
  return {
    id: row.id,
    roomId: row.room_id,
    authorId: row.author_id,
    authorKind: row.author_kind,
    text: row.text,
    createdAt: row.created_at,
    deliveryStatus: row.delivery_status ?? 'delivered',
    seenBy,
  };
}

function attachSeenBy(db: Database, roomId: string, messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const seenByMessage = listSeenAgentsByMessage(
    db,
    roomId,
    messages.map((message) => message.id),
  );
  return messages.map((message) => ({
    ...message,
    seenBy: seenByMessage.get(message.id) ?? [],
  }));
}

export function addMessage(
  db: Database,
  input: {
    roomId: string;
    authorId: string;
    authorKind: AuthorKind;
    text: string;
    deliveryStatus?: MessageDeliveryStatus;
  },
): Message {
  const id = nanoid(16);
  // Ensure created_at is strictly monotonic within a room so ordering and
  // cursor-based queries are deterministic even when multiple messages land in
  // the same millisecond (common on modern hardware). Without this, ORDER BY
  // created_at returns ties in arbitrary order and `created_at > cursor`
  // skips rows that share the cursor's millisecond.
  const lastRow = db
    .prepare(`SELECT created_at FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(input.roomId) as { created_at: number } | undefined;
  const now = Date.now();
  const createdAt = lastRow ? Math.max(now, lastRow.created_at + 1) : now;
  const deliveryStatus = input.deliveryStatus ?? 'delivered';
  db.prepare(
    `INSERT INTO messages (
      id, room_id, author_id, author_kind, text, created_at, delivery_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.roomId, input.authorId, input.authorKind, input.text, createdAt, deliveryStatus);
  return { id, ...input, deliveryStatus, createdAt, seenBy: [] };
}

export function listMessages(
  db: Database,
  roomId: string,
  opts: { limit?: number } = {},
): Message[] {
  if (opts.limit) {
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
         ) ORDER BY created_at ASC, id ASC`,
      )
      .all(roomId, opts.limit) as MessageRow[];
    return attachSeenBy(db, roomId, rows.map((row) => rowToMessage(row)));
  }
  const rows = db
    .prepare(`SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC, id ASC`)
    .all(roomId) as MessageRow[];
  return attachSeenBy(db, roomId, rows.map((row) => rowToMessage(row)));
}

export function getMessage(db: Database, id: string): Message | null {
  const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
    | MessageRow
    | undefined;
  if (!row) return null;
  const seenBy = listSeenAgentsByMessage(db, row.room_id, [row.id]).get(row.id) ?? [];
  return rowToMessage(row, seenBy);
}

export function updateMessageDeliveryStatus(
  db: Database,
  id: string,
  deliveryStatus: MessageDeliveryStatus,
): Message | null {
  db.prepare(`UPDATE messages SET delivery_status = ? WHERE id = ?`).run(deliveryStatus, id);
  return getMessage(db, id);
}

export function listQueuedHumanMessages(db: Database, roomId: string): Message[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages
       WHERE room_id = ? AND author_kind = 'human' AND delivery_status = 'queued'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(roomId) as MessageRow[];
  return attachSeenBy(db, roomId, rows.map((row) => rowToMessage(row)));
}

export function listMessagesAfter(db: Database, roomId: string, afterMs: number): Message[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE room_id = ? AND created_at > ? ORDER BY created_at ASC, id ASC`,
    )
    .all(roomId, afterMs) as MessageRow[];
  return attachSeenBy(db, roomId, rows.map((row) => rowToMessage(row)));
}
