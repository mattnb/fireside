import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export type TaskChecklistStatus = 'open' | 'blocked' | 'done' | 'skipped';
export type TaskChecklistParallelism = 'parallel-safe' | 'coordinate' | 'exclusive';

export interface TaskChecklistItem {
  id: string;
  taskId: string;
  planId: string | null;
  phaseId: string | null;
  title: string;
  detail: string;
  status: TaskChecklistStatus;
  dependencyIds: string[];
  expectedTouches: string[];
  parallelism: TaskChecklistParallelism;
  conflictGroup: string;
  workRole: string;
  ownerAgentId: string;
  statusNote: string;
  blockedReason: string;
  councilRequired: boolean;
  updatedBy: string;
  completedAt: number | null;
  sortOrder: number;
  /** Optional link to a task_acceptance_criteria.id; closing this checklist
   * item fans out a doer-pass on the linked AC. Single-ref for v1. */
  acceptanceRef: string | null;
  createdAt: number;
  updatedAt: number;
}

export type TaskChecklistNoteKind = 'status' | 'completion' | 'blocker' | 'council';

export interface TaskChecklistNote {
  id: string;
  taskId: string;
  itemId: string;
  authorId: string;
  kind: TaskChecklistNoteKind;
  body: string;
  createdAt: number;
}

interface TaskChecklistItemRow {
  id: string;
  task_id: string;
  plan_id: string | null;
  phase_id: string | null;
  title: string;
  detail: string;
  status: TaskChecklistStatus;
  dependency_ids_json: string;
  expected_touches_json: string;
  parallelism: TaskChecklistParallelism;
  conflict_group: string;
  work_role: string;
  owner_agent_id: string;
  status_note: string;
  blocked_reason: string;
  council_required: number;
  updated_by: string;
  completed_at: number | null;
  sort_order: number;
  acceptance_ref: string | null;
  created_at: number;
  updated_at: number;
}

interface TaskChecklistNoteRow {
  id: string;
  task_id: string;
  item_id: string;
  author_id: string;
  kind: TaskChecklistNoteKind;
  body: string;
  created_at: number;
}

export interface CreateTaskChecklistItemInput {
  taskId: string;
  planId?: string | null;
  phaseId?: string | null;
  title: string;
  detail?: string;
  status?: TaskChecklistStatus;
  dependencyIds?: string[];
  expectedTouches?: string[];
  parallelism?: TaskChecklistParallelism;
  conflictGroup?: string;
  workRole?: string;
  ownerAgentId?: string;
  statusNote?: string;
  blockedReason?: string;
  councilRequired?: boolean;
  updatedBy?: string;
  sortOrder?: number;
  acceptanceRef?: string | null;
}

export interface UpdateTaskChecklistItemInput {
  planId?: string | null;
  phaseId?: string | null;
  title?: string;
  detail?: string;
  status?: TaskChecklistStatus;
  dependencyIds?: string[];
  expectedTouches?: string[];
  parallelism?: TaskChecklistParallelism;
  conflictGroup?: string;
  workRole?: string;
  ownerAgentId?: string;
  statusNote?: string;
  blockedReason?: string;
  councilRequired?: boolean;
  updatedBy?: string;
  sortOrder?: number;
  acceptanceRef?: string | null;
}

export interface CreateTaskChecklistNoteInput {
  taskId: string;
  itemId: string;
  authorId: string;
  kind?: TaskChecklistNoteKind;
  body: string;
}

function parseDependencyIds(json: string): string[] {
  return parseStringArray(json);
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function cleanDependencyIds(ids: string[] | undefined): string[] {
  if (!ids) return [];
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 20);
}

function cleanExpectedTouches(touches: string[] | undefined): string[] {
  if (!touches) return [];
  return [...new Set(touches.map((touch) => touch.trim()).filter(Boolean))].slice(0, 30);
}

function normalizeParallelism(
  value: TaskChecklistParallelism | undefined,
): TaskChecklistParallelism {
  return value === 'coordinate' || value === 'exclusive' ? value : 'parallel-safe';
}

function rowToTaskChecklistItem(row: TaskChecklistItemRow): TaskChecklistItem {
  return {
    id: row.id,
    taskId: row.task_id,
    planId: row.plan_id,
    phaseId: row.phase_id,
    title: row.title,
    detail: row.detail,
    status: row.status,
    dependencyIds: parseDependencyIds(row.dependency_ids_json),
    expectedTouches: parseStringArray(row.expected_touches_json),
    parallelism: normalizeParallelism(row.parallelism),
    conflictGroup: row.conflict_group,
    workRole: row.work_role,
    ownerAgentId: row.owner_agent_id,
    statusNote: row.status_note,
    blockedReason: row.blocked_reason,
    councilRequired: row.council_required === 1,
    updatedBy: row.updated_by,
    completedAt: row.completed_at,
    sortOrder: row.sort_order,
    acceptanceRef: row.acceptance_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTaskChecklistNote(row: TaskChecklistNoteRow): TaskChecklistNote {
  return {
    id: row.id,
    taskId: row.task_id,
    itemId: row.item_id,
    authorId: row.author_id,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at,
  };
}

export function createTaskChecklistItem(
  db: Database,
  input: CreateTaskChecklistItemInput,
): TaskChecklistItem {
  const id = nanoid(14);
  const now = Date.now();
  const status = input.status ?? 'open';
  db.prepare(
    `INSERT INTO task_checklist_items (
      id, task_id, plan_id, phase_id, title, detail, status, dependency_ids_json,
      expected_touches_json, parallelism, conflict_group, work_role, owner_agent_id,
      status_note, blocked_reason, council_required, updated_by, completed_at,
      sort_order, acceptance_ref, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.planId ?? null,
    input.phaseId ?? null,
    input.title,
    input.detail ?? '',
    status,
    JSON.stringify(cleanDependencyIds(input.dependencyIds)),
    JSON.stringify(cleanExpectedTouches(input.expectedTouches)),
    normalizeParallelism(input.parallelism),
    input.conflictGroup?.trim().slice(0, 160) ?? '',
    input.workRole?.trim().slice(0, 80) ?? '',
    input.ownerAgentId ?? '',
    input.statusNote ?? '',
    input.blockedReason ?? '',
    input.councilRequired === true ? 1 : 0,
    input.updatedBy ?? '',
    status === 'done' ? now : null,
    input.sortOrder ?? 0,
    input.acceptanceRef ?? null,
    now,
    now,
  );
  return getTaskChecklistItem(db, id)!;
}

export function getTaskChecklistItem(db: Database, id: string): TaskChecklistItem | null {
  const row = db.prepare(`SELECT * FROM task_checklist_items WHERE id = ?`).get(id) as
    | TaskChecklistItemRow
    | undefined;
  return row ? rowToTaskChecklistItem(row) : null;
}

export function listTaskChecklistItems(db: Database, taskId: string): TaskChecklistItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_checklist_items
       WHERE task_id = ?
       ORDER BY sort_order ASC, created_at ASC, id ASC`,
    )
    .all(taskId) as TaskChecklistItemRow[];
  return rows.map(rowToTaskChecklistItem);
}

export function updateTaskChecklistItem(
  db: Database,
  id: string,
  input: UpdateTaskChecklistItemInput,
): TaskChecklistItem | null {
  const existing = getTaskChecklistItem(db, id);
  if (!existing) return null;
  const updated: TaskChecklistItem = {
    ...existing,
    ...('planId' in input ? { planId: input.planId ?? null } : {}),
    ...('phaseId' in input ? { phaseId: input.phaseId ?? null } : {}),
    ...('title' in input ? { title: input.title ?? '' } : {}),
    ...('detail' in input ? { detail: input.detail ?? '' } : {}),
    ...('status' in input ? { status: input.status ?? existing.status } : {}),
    ...('dependencyIds' in input ? { dependencyIds: cleanDependencyIds(input.dependencyIds) } : {}),
    ...('expectedTouches' in input
      ? { expectedTouches: cleanExpectedTouches(input.expectedTouches) }
      : {}),
    ...('parallelism' in input ? { parallelism: normalizeParallelism(input.parallelism) } : {}),
    ...('conflictGroup' in input
      ? { conflictGroup: input.conflictGroup?.trim().slice(0, 160) ?? '' }
      : {}),
    ...('workRole' in input ? { workRole: input.workRole?.trim().slice(0, 80) ?? '' } : {}),
    ...('ownerAgentId' in input ? { ownerAgentId: input.ownerAgentId ?? '' } : {}),
    ...('statusNote' in input ? { statusNote: input.statusNote ?? '' } : {}),
    ...('blockedReason' in input ? { blockedReason: input.blockedReason ?? '' } : {}),
    ...('councilRequired' in input ? { councilRequired: input.councilRequired === true } : {}),
    ...('updatedBy' in input ? { updatedBy: input.updatedBy ?? '' } : {}),
    ...('sortOrder' in input ? { sortOrder: input.sortOrder ?? 0 } : {}),
    ...('acceptanceRef' in input ? { acceptanceRef: input.acceptanceRef ?? null } : {}),
    updatedAt: Date.now(),
  };
  const completedAt =
    updated.status === 'done' && existing.status !== 'done'
      ? updated.updatedAt
      : updated.status === 'done'
        ? existing.completedAt
        : null;
  db.prepare(
    `UPDATE task_checklist_items
     SET plan_id = ?, phase_id = ?, title = ?, detail = ?, status = ?, dependency_ids_json = ?,
         expected_touches_json = ?, parallelism = ?, conflict_group = ?, work_role = ?,
         owner_agent_id = ?, status_note = ?, blocked_reason = ?, council_required = ?,
         updated_by = ?, completed_at = ?, sort_order = ?, acceptance_ref = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    updated.planId,
    updated.phaseId,
    updated.title,
    updated.detail,
    updated.status,
    JSON.stringify(updated.dependencyIds),
    JSON.stringify(updated.expectedTouches),
    updated.parallelism,
    updated.conflictGroup,
    updated.workRole,
    updated.ownerAgentId,
    updated.statusNote,
    updated.blockedReason,
    updated.councilRequired ? 1 : 0,
    updated.updatedBy,
    completedAt,
    updated.sortOrder,
    updated.acceptanceRef,
    updated.updatedAt,
    id,
  );
  return getTaskChecklistItem(db, id);
}

export function createTaskChecklistNote(
  db: Database,
  input: CreateTaskChecklistNoteInput,
): TaskChecklistNote {
  const id = nanoid(14);
  const now = Date.now();
  db.prepare(
    `INSERT INTO task_checklist_notes (
      id, task_id, item_id, author_id, kind, body, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.taskId, input.itemId, input.authorId, input.kind ?? 'status', input.body, now);
  return getTaskChecklistNote(db, id)!;
}

export function getTaskChecklistNote(db: Database, id: string): TaskChecklistNote | null {
  const row = db.prepare(`SELECT * FROM task_checklist_notes WHERE id = ?`).get(id) as
    | TaskChecklistNoteRow
    | undefined;
  return row ? rowToTaskChecklistNote(row) : null;
}

export function listTaskChecklistNotes(db: Database, taskId: string): TaskChecklistNote[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_checklist_notes
       WHERE task_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(taskId) as TaskChecklistNoteRow[];
  return rows.map(rowToTaskChecklistNote);
}
