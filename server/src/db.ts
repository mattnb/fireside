// server/src/db.ts
import Database from 'better-sqlite3';
import type { Database as DbType } from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  agents_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent', 'system')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  cli_session_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);
`;

export function openDatabase(filename: string): DbType {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
