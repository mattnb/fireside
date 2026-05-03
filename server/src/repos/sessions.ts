// server/src/repos/sessions.ts
import type { Database } from 'better-sqlite3';
import type { AgentId, ProviderId } from '../agents/types.js';

export interface CliSession {
  cliSessionId: string;
  providerId: ProviderId | '';
}

export function getCliSession(db: Database, roomId: string, agentId: AgentId): CliSession | null {
  const row = db
    .prepare(`SELECT cli_session_id, provider_id FROM sessions WHERE room_id = ? AND agent_id = ?`)
    .get(roomId, agentId) as
    | { cli_session_id: string | null; provider_id?: ProviderId | '' | null }
    | undefined;
  if (!row?.cli_session_id) return null;
  return {
    cliSessionId: row.cli_session_id,
    providerId: row.provider_id ?? '',
  };
}

export function getCliSessionId(db: Database, roomId: string, agentId: AgentId): string | null {
  return getCliSession(db, roomId, agentId)?.cliSessionId ?? null;
}

export function upsertCliSessionId(
  db: Database,
  roomId: string,
  agentId: AgentId,
  cliSessionId: string | null,
  providerId: ProviderId | '' = '',
): void {
  db.prepare(
    `INSERT INTO sessions (room_id, agent_id, cli_session_id, provider_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(room_id, agent_id) DO UPDATE SET
       cli_session_id = excluded.cli_session_id,
       provider_id = excluded.provider_id,
       updated_at = excluded.updated_at`,
  ).run(roomId, agentId, cliSessionId, providerId, Date.now());
}

export function deleteCliSessionId(db: Database, roomId: string, agentId: AgentId): void {
  db.prepare(`DELETE FROM sessions WHERE room_id = ? AND agent_id = ?`).run(roomId, agentId);
}
