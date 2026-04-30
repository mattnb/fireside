// server/src/repos/messages.ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export type AuthorKind = 'human' | 'agent' | 'system';

export interface Message {
  id: string;
  roomId: string;
  authorId: string;
  authorKind: AuthorKind;
  text: string;
  createdAt: number;
}

interface MessageRow {
  id: string;
  room_id: string;
  author_id: string;
  author_kind: AuthorKind;
  text: string;
  created_at: number;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    roomId: row.room_id,
    authorId: row.author_id,
    authorKind: row.author_kind,
    text: row.text,
    createdAt: row.created_at,
  };
}

export function addMessage(
  db: Database,
  input: { roomId: string; authorId: string; authorKind: AuthorKind; text: string },
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
  db.prepare(
    `INSERT INTO messages (id, room_id, author_id, author_kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.roomId, input.authorId, input.authorKind, input.text, createdAt);
  return { id, ...input, createdAt };
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
    return rows.map(rowToMessage);
  }
  const rows = db
    .prepare(`SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC, id ASC`)
    .all(roomId) as MessageRow[];
  return rows.map(rowToMessage);
}

export function getMessage(db: Database, id: string): Message | null {
  const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
    | MessageRow
    | undefined;
  return row ? rowToMessage(row) : null;
}

export function listMessagesAfter(db: Database, roomId: string, afterMs: number): Message[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE room_id = ? AND created_at > ? ORDER BY created_at ASC, id ASC`,
    )
    .all(roomId, afterMs) as MessageRow[];
  return rows.map(rowToMessage);
}
