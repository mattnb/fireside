import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';

export type MissionCommandKind =
  | 'mission-create'
  | 'mission-plan'
  | 'mission-phase'
  | 'mission-task'
  | 'mission-receipt'
  | 'agent-roster';
export type MissionCommandStatus = 'parsed' | 'applied' | 'rejected' | 'reconciled';

export interface MissionCommandEvent {
  id: string;
  roomId: string;
  taskId: string | null;
  runId: string | null;
  agentId: AgentId;
  commandKind: MissionCommandKind;
  action: string;
  targetRef: string;
  status: MissionCommandStatus;
  summary: string;
  payload: unknown;
  createdAt: number;
}

interface MissionCommandEventRow {
  id: string;
  room_id: string;
  task_id: string | null;
  run_id: string | null;
  agent_id: AgentId;
  command_kind: MissionCommandKind;
  action: string;
  target_ref: string;
  status: MissionCommandStatus;
  summary: string;
  payload_json: string;
  created_at: number;
}

export interface CreateMissionCommandEventInput {
  roomId: string;
  taskId?: string | null;
  runId?: string | null;
  agentId: AgentId;
  commandKind: MissionCommandKind;
  action?: string;
  targetRef?: string;
  status: MissionCommandStatus;
  summary?: string;
  payload?: unknown;
}

function parsePayload(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return {};
  }
}

function rowToMissionCommandEvent(row: MissionCommandEventRow): MissionCommandEvent {
  return {
    id: row.id,
    roomId: row.room_id,
    taskId: row.task_id,
    runId: row.run_id,
    agentId: row.agent_id,
    commandKind: row.command_kind,
    action: row.action,
    targetRef: row.target_ref,
    status: row.status,
    summary: row.summary,
    payload: parsePayload(row.payload_json),
    createdAt: row.created_at,
  };
}

export function createMissionCommandEvent(
  db: Database,
  input: CreateMissionCommandEventInput,
): MissionCommandEvent {
  const id = nanoid(16);
  const now = Date.now();
  db.prepare(
    `INSERT INTO mission_command_events (
      id, room_id, task_id, run_id, agent_id, command_kind, action, target_ref,
      status, summary, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.roomId,
    input.taskId ?? null,
    input.runId ?? null,
    input.agentId,
    input.commandKind,
    input.action?.slice(0, 80) ?? '',
    input.targetRef?.slice(0, 240) ?? '',
    input.status,
    input.summary?.slice(0, 1000) ?? '',
    JSON.stringify(input.payload ?? {}),
    now,
  );
  return getMissionCommandEvent(db, id)!;
}

export function getMissionCommandEvent(
  db: Database,
  id: string,
): MissionCommandEvent | null {
  const row = db.prepare(`SELECT * FROM mission_command_events WHERE id = ?`).get(id) as
    | MissionCommandEventRow
    | undefined;
  return row ? rowToMissionCommandEvent(row) : null;
}

export function listMissionCommandEventsForRoom(
  db: Database,
  roomId: string,
  limit = 100,
): MissionCommandEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM mission_command_events
       WHERE room_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(roomId, limit) as MissionCommandEventRow[];
  return rows.map(rowToMissionCommandEvent);
}
