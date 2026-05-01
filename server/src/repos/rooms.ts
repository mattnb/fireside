// server/src/repos/rooms.ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';
import { ensureDefaultProject, getProject } from './projects.js';

export interface Room {
  id: string;
  projectId: string;
  name: string;
  agents: AgentId[];
  yoloAgents: AgentId[];
  createdAt: number;
}

interface RoomRow {
  id: string;
  project_id: string | null;
  name: string;
  agents_json: string;
  yolo_agents_json: string;
  created_at: number;
}

function parseAgents(json: string): AgentId[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? (parsed.filter((item) => typeof item === 'string') as AgentId[])
      : [];
  } catch {
    return [];
  }
}

function rowToRoom(row: RoomRow): Room {
  const agents = parseAgents(row.agents_json);
  const yoloAgents = parseAgents(row.yolo_agents_json).filter((agent) => agents.includes(agent));
  return {
    id: row.id,
    projectId: row.project_id || 'general',
    name: row.name,
    agents,
    yoloAgents,
    createdAt: row.created_at,
  };
}

export function createRoom(
  db: Database,
  input: { name: string; agents: AgentId[]; yoloAgents?: AgentId[]; projectId?: string | null },
): Room {
  const id = nanoid(12);
  const now = Date.now();
  const yoloAgents = (input.yoloAgents ?? []).filter((agent) => input.agents.includes(agent));
  const projectId =
    input.projectId && getProject(db, input.projectId)
      ? input.projectId
      : ensureDefaultProject(db).id;
  db.prepare(
    `INSERT INTO rooms (id, project_id, name, created_at, agents_json, yolo_agents_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, input.name, now, JSON.stringify(input.agents), JSON.stringify(yoloAgents));
  return { id, projectId, name: input.name, agents: input.agents, yoloAgents, createdAt: now };
}

export function getRoom(db: Database, id: string): Room | null {
  const row = db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id) as RoomRow | undefined;
  return row ? rowToRoom(row) : null;
}

export function listRooms(db: Database): Room[] {
  const rows = db.prepare(`SELECT * FROM rooms ORDER BY created_at ASC`).all() as RoomRow[];
  return rows.map(rowToRoom);
}

export function updateRoomProject(db: Database, roomId: string, projectId: string): Room | null {
  if (!getProject(db, projectId)) return null;
  db.prepare(`UPDATE rooms SET project_id = ? WHERE id = ?`).run(projectId, roomId);
  return getRoom(db, roomId);
}

export function setRoomAgents(
  db: Database,
  roomId: string,
  agents: AgentId[],
  yoloAgents?: AgentId[],
): void {
  const room = getRoom(db, roomId);
  if (!room) return;
  const removed = room.agents.filter((a) => !agents.includes(a));
  const nextYoloAgents = (yoloAgents ?? room.yoloAgents).filter((agent) => agents.includes(agent));
  // Run as a transaction so the agent list and session cleanup are atomic.
  const tx = db.transaction((newAgents: AgentId[]) => {
    db.prepare(`UPDATE rooms SET agents_json = ?, yolo_agents_json = ? WHERE id = ?`).run(
      JSON.stringify(newAgents),
      JSON.stringify(nextYoloAgents),
      roomId,
    );
    if (removed.length > 0) {
      const stmt = db.prepare(`DELETE FROM sessions WHERE room_id = ? AND agent_id = ?`);
      for (const a of removed) stmt.run(roomId, a);
    }
  });
  tx(agents);
}

export function deleteRoom(db: Database, roomId: string): boolean {
  // Foreign-key cascade on messages.room_id handles message deletion.
  // sessions.room_id has no FK, so delete it explicitly.
  db.prepare('DELETE FROM sessions WHERE room_id = ?').run(roomId);
  const r = db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
  return r.changes > 0;
}
