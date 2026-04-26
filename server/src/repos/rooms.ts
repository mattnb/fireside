// server/src/repos/rooms.ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';

export interface Room {
  id: string;
  name: string;
  agents: AgentId[];
  createdAt: number;
}

interface RoomRow {
  id: string;
  name: string;
  agents_json: string;
  created_at: number;
}

function rowToRoom(row: RoomRow): Room {
  return {
    id: row.id,
    name: row.name,
    agents: JSON.parse(row.agents_json) as AgentId[],
    createdAt: row.created_at,
  };
}

export function createRoom(
  db: Database,
  input: { name: string; agents: AgentId[] },
): Room {
  const id = nanoid(12);
  const now = Date.now();
  db.prepare(
    `INSERT INTO rooms (id, name, created_at, agents_json) VALUES (?, ?, ?, ?)`,
  ).run(id, input.name, now, JSON.stringify(input.agents));
  return { id, name: input.name, agents: input.agents, createdAt: now };
}

export function getRoom(db: Database, id: string): Room | null {
  const row = db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id) as RoomRow | undefined;
  return row ? rowToRoom(row) : null;
}

export function listRooms(db: Database): Room[] {
  const rows = db.prepare(`SELECT * FROM rooms ORDER BY created_at ASC`).all() as RoomRow[];
  return rows.map(rowToRoom);
}

export function setRoomAgents(db: Database, roomId: string, agents: AgentId[]): void {
  db.prepare(`UPDATE rooms SET agents_json = ? WHERE id = ?`).run(JSON.stringify(agents), roomId);
}
