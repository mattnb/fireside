import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export type TaskPlanStatus = 'draft' | 'active' | 'superseded' | 'archived';

export interface TaskPlan {
  id: string;
  taskId: string;
  title: string;
  body: string;
  status: TaskPlanStatus;
  createdAt: number;
  updatedAt: number;
}

interface TaskPlanRow {
  id: string;
  task_id: string;
  title: string;
  body: string;
  status: TaskPlanStatus;
  created_at: number;
  updated_at: number;
}

export interface CreateTaskPlanInput {
  taskId: string;
  title: string;
  body?: string;
  status?: TaskPlanStatus;
}

export interface UpdateTaskPlanInput {
  title?: string;
  body?: string;
  status?: TaskPlanStatus;
}

function rowToTaskPlan(row: TaskPlanRow): TaskPlan {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function supersedeOtherActivePlans(db: Database, taskId: string, exceptPlanId?: string): void {
  const now = Date.now();
  if (exceptPlanId) {
    db.prepare(
      `UPDATE task_plans
       SET status = 'superseded', updated_at = ?
       WHERE task_id = ? AND status = 'active' AND id <> ?`,
    ).run(now, taskId, exceptPlanId);
    return;
  }
  db.prepare(
    `UPDATE task_plans
     SET status = 'superseded', updated_at = ?
     WHERE task_id = ? AND status = 'active'`,
  ).run(now, taskId);
}

export function createTaskPlan(db: Database, input: CreateTaskPlanInput): TaskPlan {
  const id = nanoid(14);
  const now = Date.now();
  const status = input.status ?? 'draft';
  const tx = db.transaction(() => {
    if (status === 'active') supersedeOtherActivePlans(db, input.taskId);
    db.prepare(
      `INSERT INTO task_plans (
        id, task_id, title, body, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.taskId, input.title, input.body ?? '', status, now, now);
  });
  tx();
  return getTaskPlan(db, id)!;
}

export function getTaskPlan(db: Database, id: string): TaskPlan | null {
  const row = db.prepare(`SELECT * FROM task_plans WHERE id = ?`).get(id) as
    | TaskPlanRow
    | undefined;
  return row ? rowToTaskPlan(row) : null;
}

export function listTaskPlans(db: Database, taskId: string): TaskPlan[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_plans
       WHERE task_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
                updated_at DESC, created_at DESC, id DESC`,
    )
    .all(taskId) as TaskPlanRow[];
  return rows.map(rowToTaskPlan);
}

export function updateTaskPlan(
  db: Database,
  id: string,
  input: UpdateTaskPlanInput,
): TaskPlan | null {
  const existing = getTaskPlan(db, id);
  if (!existing) return null;
  const updated: TaskPlan = {
    ...existing,
    ...('title' in input ? { title: input.title ?? '' } : {}),
    ...('body' in input ? { body: input.body ?? '' } : {}),
    ...('status' in input ? { status: input.status ?? existing.status } : {}),
    updatedAt: Date.now(),
  };
  const tx = db.transaction(() => {
    if (updated.status === 'active') supersedeOtherActivePlans(db, updated.taskId, id);
    db.prepare(
      `UPDATE task_plans
       SET title = ?, body = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    ).run(updated.title, updated.body, updated.status, updated.updatedAt, id);
  });
  tx();
  return getTaskPlan(db, id);
}
