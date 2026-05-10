// server/src/repos/acceptance-criteria.ts
//
// CRUD + dual-path verification helpers for `task_acceptance_criteria`. Each
// AC has two independent check sides (doer + verifier). The AC's `status`
// rolls up from those two sides:
//   both pass        → pass
//   either side fail → fail
//   otherwise        → pending

import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export type AcceptanceCheckStatus = 'pending' | 'pass' | 'fail';

export interface AcceptanceCriterion {
  id: string;
  taskId: string;
  sortOrder: number;
  title: string;
  detail: string;
  doerAgentId: string | null;
  status: AcceptanceCheckStatus;
  doerCheckStatus: AcceptanceCheckStatus;
  doerCheckEvidence: string;
  doerCheckAt: number | null;
  doerCheckByAgentId: string | null;
  verifierCheckStatus: AcceptanceCheckStatus;
  verifierCheckEvidence: string;
  verifierCheckAt: number | null;
  verifierCheckByAgentId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface AcceptanceCriterionRow {
  id: string;
  task_id: string;
  sort_order: number;
  title: string;
  detail: string;
  doer_agent_id: string | null;
  status: AcceptanceCheckStatus;
  doer_check_status: AcceptanceCheckStatus;
  doer_check_evidence: string;
  doer_check_at: number | null;
  doer_check_by_agent_id: string | null;
  verifier_check_status: AcceptanceCheckStatus;
  verifier_check_evidence: string;
  verifier_check_at: number | null;
  verifier_check_by_agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateAcceptanceCriterionInput {
  taskId: string;
  title: string;
  detail?: string;
  doerAgentId?: string | null;
  sortOrder?: number;
}

export interface UpdateAcceptanceCriterionInput {
  title?: string;
  detail?: string;
  doerAgentId?: string | null;
  sortOrder?: number;
}

export interface RecordCheckInput {
  status: AcceptanceCheckStatus;
  evidence: string;
  byAgentId: string;
}

function rowToCriterion(row: AcceptanceCriterionRow): AcceptanceCriterion {
  return {
    id: row.id,
    taskId: row.task_id,
    sortOrder: row.sort_order,
    title: row.title,
    detail: row.detail,
    doerAgentId: row.doer_agent_id,
    status: row.status,
    doerCheckStatus: row.doer_check_status,
    doerCheckEvidence: row.doer_check_evidence,
    doerCheckAt: row.doer_check_at,
    doerCheckByAgentId: row.doer_check_by_agent_id,
    verifierCheckStatus: row.verifier_check_status,
    verifierCheckEvidence: row.verifier_check_evidence,
    verifierCheckAt: row.verifier_check_at,
    verifierCheckByAgentId: row.verifier_check_by_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAcceptanceCriterion(
  db: Database,
  input: CreateAcceptanceCriterionInput,
): AcceptanceCriterion {
  const id = nanoid(14);
  const now = Date.now();
  db.prepare(
    `INSERT INTO task_acceptance_criteria (
      id, task_id, sort_order, title, detail, doer_agent_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.sortOrder ?? 0,
    input.title,
    input.detail ?? '',
    input.doerAgentId ?? null,
    now,
    now,
  );
  return getAcceptanceCriterion(db, id)!;
}

export function getAcceptanceCriterion(
  db: Database,
  id: string,
): AcceptanceCriterion | null {
  const row = db
    .prepare(`SELECT * FROM task_acceptance_criteria WHERE id = ?`)
    .get(id) as AcceptanceCriterionRow | undefined;
  return row ? rowToCriterion(row) : null;
}

export function listAcceptanceCriteria(
  db: Database,
  taskId: string,
): AcceptanceCriterion[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_acceptance_criteria
       WHERE task_id = ?
       ORDER BY sort_order, created_at`,
    )
    .all(taskId) as AcceptanceCriterionRow[];
  return rows.map(rowToCriterion);
}

export function updateAcceptanceCriterion(
  db: Database,
  id: string,
  input: UpdateAcceptanceCriterionInput,
): AcceptanceCriterion | null {
  const existing = getAcceptanceCriterion(db, id);
  if (!existing) return null;
  const now = Date.now();
  db.prepare(
    `UPDATE task_acceptance_criteria
       SET title = ?, detail = ?, doer_agent_id = ?, sort_order = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.title ?? existing.title,
    input.detail ?? existing.detail,
    input.doerAgentId !== undefined ? input.doerAgentId : existing.doerAgentId,
    input.sortOrder ?? existing.sortOrder,
    now,
    id,
  );
  return getAcceptanceCriterion(db, id);
}

export function recordDoerCheck(
  db: Database,
  id: string,
  input: RecordCheckInput,
): AcceptanceCriterion | null {
  const existing = getAcceptanceCriterion(db, id);
  if (!existing) return null;
  const now = Date.now();
  db.prepare(
    `UPDATE task_acceptance_criteria
       SET doer_check_status = ?, doer_check_evidence = ?, doer_check_at = ?,
           doer_check_by_agent_id = ?, updated_at = ?
     WHERE id = ?`,
  ).run(input.status, input.evidence, now, input.byAgentId, now, id);
  return recomputeAcceptanceStatus(db, id);
}

export function recordVerifierCheck(
  db: Database,
  id: string,
  input: RecordCheckInput,
): AcceptanceCriterion | null {
  const existing = getAcceptanceCriterion(db, id);
  if (!existing) return null;
  // Same agent cannot be both doer and verifier. The lone exception is the
  // human user, who is identified by the literal string 'human' on both
  // sides — but in practice the human is never the doer (the doer is always
  // the agent that closed the linked checklist item).
  if (
    input.byAgentId !== 'human' &&
    existing.doerCheckByAgentId !== null &&
    existing.doerCheckByAgentId === input.byAgentId
  ) {
    throw new Error(
      `same agent cannot be both doer and verifier (ac ${id}, agent ${input.byAgentId})`,
    );
  }
  const now = Date.now();
  db.prepare(
    `UPDATE task_acceptance_criteria
       SET verifier_check_status = ?, verifier_check_evidence = ?, verifier_check_at = ?,
           verifier_check_by_agent_id = ?, updated_at = ?
     WHERE id = ?`,
  ).run(input.status, input.evidence, now, input.byAgentId, now, id);
  return recomputeAcceptanceStatus(db, id);
}

export function recomputeAcceptanceStatus(
  db: Database,
  id: string,
): AcceptanceCriterion | null {
  const existing = getAcceptanceCriterion(db, id);
  if (!existing) return null;
  const next = deriveStatus(existing.doerCheckStatus, existing.verifierCheckStatus);
  if (next === existing.status) return existing;
  db.prepare(
    `UPDATE task_acceptance_criteria SET status = ?, updated_at = ? WHERE id = ?`,
  ).run(next, Date.now(), id);
  return getAcceptanceCriterion(db, id);
}

export function deriveStatus(
  doer: AcceptanceCheckStatus,
  verifier: AcceptanceCheckStatus,
): AcceptanceCheckStatus {
  if (doer === 'fail' || verifier === 'fail') return 'fail';
  if (doer === 'pass' && verifier === 'pass') return 'pass';
  return 'pending';
}

export function allCriteriaPassed(db: Database, taskId: string): boolean {
  const rows = db
    .prepare(`SELECT status FROM task_acceptance_criteria WHERE task_id = ?`)
    .all(taskId) as Array<{ status: AcceptanceCheckStatus }>;
  if (rows.length === 0) return false;
  return rows.every((row) => row.status === 'pass');
}
