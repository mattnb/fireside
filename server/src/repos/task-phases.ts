import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export type TaskPhaseStatus = 'planned' | 'active' | 'blocked' | 'done';

export interface TaskPhase {
  id: string;
  taskId: string;
  planId: string | null;
  title: string;
  description: string;
  status: TaskPhaseStatus;
  gate: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

interface TaskPhaseRow {
  id: string;
  task_id: string;
  plan_id: string | null;
  title: string;
  description: string;
  status: TaskPhaseStatus;
  gate: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface CreateTaskPhaseInput {
  taskId: string;
  planId?: string | null;
  title: string;
  description?: string;
  status?: TaskPhaseStatus;
  gate?: string;
  sortOrder?: number;
}

export interface UpdateTaskPhaseInput {
  planId?: string | null;
  title?: string;
  description?: string;
  status?: TaskPhaseStatus;
  gate?: string;
  sortOrder?: number;
}

function rowToTaskPhase(row: TaskPhaseRow): TaskPhase {
  return {
    id: row.id,
    taskId: row.task_id,
    planId: row.plan_id,
    title: row.title,
    description: row.description,
    status: row.status,
    gate: row.gate,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTaskPhase(db: Database, input: CreateTaskPhaseInput): TaskPhase {
  const id = nanoid(14);
  const now = Date.now();
  db.prepare(
    `INSERT INTO task_phases (
      id, task_id, plan_id, title, description, status, gate, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.planId ?? null,
    input.title,
    input.description ?? '',
    input.status ?? 'planned',
    input.gate ?? '',
    input.sortOrder ?? 0,
    now,
    now,
  );
  return getTaskPhase(db, id)!;
}

export function getTaskPhase(db: Database, id: string): TaskPhase | null {
  const row = db.prepare(`SELECT * FROM task_phases WHERE id = ?`).get(id) as
    | TaskPhaseRow
    | undefined;
  return row ? rowToTaskPhase(row) : null;
}

export function listTaskPhases(db: Database, taskId: string): TaskPhase[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_phases
       WHERE task_id = ?
       ORDER BY sort_order ASC, created_at ASC, id ASC`,
    )
    .all(taskId) as TaskPhaseRow[];
  return rows.map(rowToTaskPhase);
}

export function updateTaskPhase(
  db: Database,
  id: string,
  input: UpdateTaskPhaseInput,
): TaskPhase | null {
  const existing = getTaskPhase(db, id);
  if (!existing) return null;
  const updated: TaskPhase = {
    ...existing,
    ...('planId' in input ? { planId: input.planId ?? null } : {}),
    ...('title' in input ? { title: input.title ?? '' } : {}),
    ...('description' in input ? { description: input.description ?? '' } : {}),
    ...('status' in input ? { status: input.status ?? existing.status } : {}),
    ...('gate' in input ? { gate: input.gate ?? '' } : {}),
    ...('sortOrder' in input ? { sortOrder: input.sortOrder ?? 0 } : {}),
    updatedAt: Date.now(),
  };
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE task_phases
       SET plan_id = ?, title = ?, description = ?, status = ?, gate = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      updated.planId,
      updated.title,
      updated.description,
      updated.status,
      updated.gate,
      updated.sortOrder,
      updated.updatedAt,
      id,
    );
    if ('planId' in input) {
      db.prepare(
        `UPDATE task_checklist_items
         SET plan_id = ?, updated_at = ?
         WHERE phase_id = ?`,
      ).run(updated.planId, updated.updatedAt, id);
    }
  });
  tx();
  return getTaskPhase(db, id);
}
