// server/src/repos/rooms.ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import {
  defaultAgentProfile,
  normalizeRoomAgentProfiles,
  parseRoomAgentProfiles,
} from '../agents/profiles.js';
import type { AgentId, RoomAgentProfile } from '../agents/types.js';
import { ensureDefaultProject, getProject } from './projects.js';
import { deleteCliSessionId } from './sessions.js';

export interface Room {
  id: string;
  projectId: string;
  name: string;
  agents: AgentId[];
  yoloAgents: AgentId[];
  leadAgentId: AgentId | null;
  agentProfiles: RoomAgentProfile[];
  createdAt: number;
}

interface RoomRow {
  id: string;
  project_id: string | null;
  name: string;
  agents_json: string;
  yolo_agents_json: string;
  agent_profiles_json?: string;
  lead_agent_id?: string | null;
  created_at: number;
}

function parseAgents(json: string): AgentId[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    const agents: AgentId[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string' || agents.includes(item)) continue;
      agents.push(item);
    }
    return agents;
  } catch {
    return [];
  }
}

function profileRuntimeSettingsChanged(
  previous: RoomAgentProfile | undefined,
  next: RoomAgentProfile,
): boolean {
  if (!previous) return false;
  return (
    previous.providerId !== next.providerId ||
    (previous.modelId ?? '') !== (next.modelId ?? '') ||
    (previous.reasoningEffort ?? '') !== (next.reasoningEffort ?? '')
  );
}

function rowToRoom(row: RoomRow): Room {
  const agents = parseAgents(row.agents_json);
  const yoloAgents = parseAgents(row.yolo_agents_json).filter((agent) => agents.includes(agent));
  const leadAgentId =
    typeof row.lead_agent_id === 'string' && agents.includes(row.lead_agent_id)
      ? row.lead_agent_id
      : null;
  const agentProfiles = parseRoomAgentProfiles(row.agent_profiles_json ?? '[]', agents);
  return {
    id: row.id,
    projectId: row.project_id || 'general',
    name: row.name,
    agents,
    yoloAgents,
    leadAgentId,
    agentProfiles,
    createdAt: row.created_at,
  };
}

export function createRoom(
  db: Database,
  input: {
    name: string;
    agents?: AgentId[];
    yoloAgents?: AgentId[];
    leadAgentId?: AgentId | null;
    agentProfiles?: RoomAgentProfile[];
    projectId?: string | null;
  },
): Room {
  const id = nanoid(12);
  const now = Date.now();
  const agentProfileInput: { agents?: AgentId[]; agentProfiles?: RoomAgentProfile[] } = {};
  if (input.agents !== undefined) agentProfileInput.agents = input.agents;
  if (input.agentProfiles !== undefined) agentProfileInput.agentProfiles = input.agentProfiles;
  const agentProfiles = normalizeRoomAgentProfiles(agentProfileInput);
  const agents = agentProfiles.map((profile) => profile.id);
  const yoloAgents = (input.yoloAgents ?? []).filter((agent) => agents.includes(agent));
  const leadAgentId =
    input.leadAgentId && agents.includes(input.leadAgentId) ? input.leadAgentId : null;
  const projectId =
    input.projectId && getProject(db, input.projectId)
      ? input.projectId
      : ensureDefaultProject(db).id;
  db.prepare(
    `INSERT INTO rooms (
      id, project_id, name, created_at, agents_json, yolo_agents_json, agent_profiles_json, lead_agent_id
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    input.name,
    now,
    JSON.stringify(agents),
    JSON.stringify(yoloAgents),
    JSON.stringify(agentProfiles),
    leadAgentId,
  );
  return { id, projectId, name: input.name, agents, yoloAgents, leadAgentId, agentProfiles, createdAt: now };
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
  agentProfiles?: RoomAgentProfile[],
  leadAgentId?: AgentId | null,
): void {
  const room = getRoom(db, roomId);
  if (!room) return;
  const nextProfiles = normalizeRoomAgentProfiles({
    agents,
    agentProfiles:
      agentProfiles ??
      agents.map((agentId) => room.agentProfiles.find((profile) => profile.id === agentId) ?? defaultAgentProfile(agentId)),
  });
  const nextAgents = nextProfiles.map((profile) => profile.id);
  const removed = room.agents.filter((a) => !nextAgents.includes(a));
  const currentProfilesById = new Map(room.agentProfiles.map((profile) => [profile.id, profile]));
  const runtimeSettingsChanged = nextProfiles
    .filter((profile) => currentProfilesById.get(profile.id)?.providerId !== undefined)
    .filter((profile) => profileRuntimeSettingsChanged(currentProfilesById.get(profile.id), profile))
    .map((profile) => profile.id);
  const sessionsToDelete = [...new Set([...removed, ...runtimeSettingsChanged])];
  const nextYoloAgents = (yoloAgents ?? room.yoloAgents).filter((agent) =>
    nextAgents.includes(agent),
  );
  const nextLeadAgentId =
    leadAgentId === undefined
      ? room.leadAgentId && nextAgents.includes(room.leadAgentId)
        ? room.leadAgentId
        : null
      : leadAgentId && nextAgents.includes(leadAgentId)
        ? leadAgentId
        : null;
  // Run as a transaction so the agent list and session cleanup are atomic.
  const tx = db.transaction((newAgents: AgentId[]) => {
    db.prepare(
      `UPDATE rooms
       SET agents_json = ?, yolo_agents_json = ?, agent_profiles_json = ?, lead_agent_id = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify(newAgents),
      JSON.stringify(nextYoloAgents),
      JSON.stringify(nextProfiles),
      nextLeadAgentId,
      roomId,
    );
    if (sessionsToDelete.length > 0) {
      for (const agentId of sessionsToDelete) deleteCliSessionId(db, roomId, agentId);
    }
  });
  tx(nextAgents);
}

export function setRoomLeadAgent(
  db: Database,
  roomId: string,
  leadAgentId: AgentId | null,
): Room | null {
  const room = getRoom(db, roomId);
  if (!room) return null;
  const nextLeadAgentId = leadAgentId && room.agents.includes(leadAgentId) ? leadAgentId : null;
  db.prepare(`UPDATE rooms SET lead_agent_id = ? WHERE id = ?`).run(nextLeadAgentId, roomId);
  return getRoom(db, roomId);
}

export function deleteRoom(db: Database, roomId: string): boolean {
  // Foreign-key cascade on messages.room_id handles message deletion.
  // sessions.room_id has no FK, so delete it explicitly.
  db.prepare('DELETE FROM sessions WHERE room_id = ?').run(roomId);
  const r = db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
  return r.changes > 0;
}
