// server/src/repos/sessions.ts
import type { Database } from 'better-sqlite3';
import type { AgentId } from '../agents/types.js';

export function getCliSessionId(db: Database, roomId: string, agentId: AgentId): string | null {
  const row = db
    .prepare(`SELECT cli_session_id FROM sessions WHERE room_id = ? AND agent_id = ?`)
    .get(roomId, agentId) as { cli_session_id: string | null } | undefined;
  return row?.cli_session_id ?? null;
}

export function upsertCliSessionId(
  db: Database,
  roomId: string,
  agentId: AgentId,
  cliSessionId: string | null,
): void {
  db.prepare(
    `INSERT INTO sessions (room_id, agent_id, cli_session_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(room_id, agent_id) DO UPDATE SET
       cli_session_id = excluded.cli_session_id,
       updated_at = excluded.updated_at`,
  ).run(roomId, agentId, cliSessionId, Date.now());
}
