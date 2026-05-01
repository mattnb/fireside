import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentRun } from './agent-runs.js';
import type { AgentRunAction } from './run-actions.js';
import type { CollaborationItem } from './collaboration.js';
import type { Message } from './messages.js';
import type { Room } from './rooms.js';
import type { Task } from './tasks.js';
import type { TaskChecklistItem, TaskChecklistNote } from './task-checklist.js';
import type { TaskPhase } from './task-phases.js';
import type { TaskPlan } from './task-plans.js';

export interface MissionBriefingPayload {
  version: 1;
  capturedAt: number;
  room: Room;
  task: Task | null;
  currentPhase: TaskPhase | null;
  activePlan: TaskPlan | null;
  phases: TaskPhase[];
  checklistItems: TaskChecklistItem[];
  checklistNotes: TaskChecklistNote[];
  plans: TaskPlan[];
  collaboration: CollaborationItem[];
  messages: Message[];
  runs: AgentRun[];
  runActions: AgentRunAction[];
}

export interface MissionBriefing {
  id: string;
  roomId: string | null;
  taskId: string | null;
  title: string;
  summary: string;
  createdBy: string;
  createdAt: number;
  messageCount: number;
  runCount: number;
  payload: MissionBriefingPayload;
}

export type MissionBriefingSummary = Omit<MissionBriefing, 'payload'>;

interface MissionBriefingRow {
  id: string;
  room_id: string | null;
  task_id: string | null;
  title: string;
  summary: string;
  created_by: string;
  created_at: number;
  message_count: number;
  run_count: number;
  payload_json: string;
}

export interface CreateMissionBriefingInput {
  roomId: string;
  taskId?: string | null;
  title: string;
  summary?: string;
  createdBy: string;
  payload: MissionBriefingPayload;
}

function safeParsePayload(json: string): MissionBriefingPayload {
  return JSON.parse(json) as MissionBriefingPayload;
}

function rowToSummary(row: MissionBriefingRow): MissionBriefingSummary {
  return {
    id: row.id,
    roomId: row.room_id,
    taskId: row.task_id,
    title: row.title,
    summary: row.summary,
    createdBy: row.created_by,
    createdAt: row.created_at,
    messageCount: row.message_count,
    runCount: row.run_count,
  };
}

function rowToBriefing(row: MissionBriefingRow): MissionBriefing {
  return {
    ...rowToSummary(row),
    payload: safeParsePayload(row.payload_json),
  };
}

function bounded(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

export function createMissionBriefing(
  db: Database,
  input: CreateMissionBriefingInput,
): MissionBriefing {
  const id = nanoid(16);
  const createdAt = input.payload.capturedAt;
  db.prepare(
    `INSERT INTO mission_briefings (
      id, room_id, task_id, title, summary, created_by, created_at, message_count, run_count, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.roomId,
    input.taskId ?? null,
    bounded(input.title, 220),
    bounded(input.summary ?? '', 1000),
    bounded(input.createdBy, 120),
    createdAt,
    input.payload.messages.length,
    input.payload.runs.length,
    JSON.stringify(input.payload),
  );
  return getMissionBriefing(db, id)!;
}

export function listMissionBriefings(
  db: Database,
  opts: { roomId?: string; limit?: number } = {},
): MissionBriefingSummary[] {
  const limit = opts.limit ?? 100;
  const rows = opts.roomId
    ? (db
        .prepare(
          `SELECT * FROM mission_briefings
           WHERE room_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(opts.roomId, limit) as MissionBriefingRow[])
    : (db
        .prepare(
          `SELECT * FROM mission_briefings
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(limit) as MissionBriefingRow[]);
  return rows.map(rowToSummary);
}

export function getMissionBriefing(db: Database, id: string): MissionBriefing | null {
  const row = db.prepare(`SELECT * FROM mission_briefings WHERE id = ?`).get(id) as
    | MissionBriefingRow
    | undefined;
  return row ? rowToBriefing(row) : null;
}
