// server/src/repos/clarifying-questions.ts
//
// CRUD + open-questions filter for `task_clarifying_questions`. While a task
// is in `proposal_status = 'elaborating'`, every unanswered question keeps
// the lead from advancing the task to `proposed`. The lead writes via
// `mission.clarify.ask`; the human or designated answerer writes via
// `mission.clarify.answer` (agents) or `POST /api/clarifying-questions/:id/answer`
// (humans).

import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export type ClarifyingQuestionCategory =
  | 'scope'
  | 'data-model'
  | 'acceptance'
  | 'out-of-scope'
  | 'risk'
  | 'general';

export interface ClarifyingQuestion {
  id: string;
  taskId: string;
  sortOrder: number;
  category: ClarifyingQuestionCategory;
  question: string;
  askedByAgentId: string;
  answer: string;
  answeredBy: string;
  answeredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface ClarifyingQuestionRow {
  id: string;
  task_id: string;
  sort_order: number;
  category: ClarifyingQuestionCategory;
  question: string;
  asked_by_agent_id: string;
  answer: string;
  answered_by: string;
  answered_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateClarifyingQuestionInput {
  taskId: string;
  askedByAgentId: string;
  question: string;
  category?: ClarifyingQuestionCategory;
  sortOrder?: number;
}

export interface AnswerQuestionInput {
  answer: string;
  answeredBy: string;
}

function rowToQuestion(row: ClarifyingQuestionRow): ClarifyingQuestion {
  return {
    id: row.id,
    taskId: row.task_id,
    sortOrder: row.sort_order,
    category: row.category,
    question: row.question,
    askedByAgentId: row.asked_by_agent_id,
    answer: row.answer,
    answeredBy: row.answered_by,
    answeredAt: row.answered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createClarifyingQuestion(
  db: Database,
  input: CreateClarifyingQuestionInput,
): ClarifyingQuestion {
  const id = nanoid(14);
  const now = Date.now();
  db.prepare(
    `INSERT INTO task_clarifying_questions (
      id, task_id, sort_order, category, question, asked_by_agent_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.sortOrder ?? 0,
    input.category ?? 'general',
    input.question,
    input.askedByAgentId,
    now,
    now,
  );
  return getClarifyingQuestion(db, id)!;
}

export function getClarifyingQuestion(
  db: Database,
  id: string,
): ClarifyingQuestion | null {
  const row = db
    .prepare(`SELECT * FROM task_clarifying_questions WHERE id = ?`)
    .get(id) as ClarifyingQuestionRow | undefined;
  return row ? rowToQuestion(row) : null;
}

export function listClarifyingQuestions(
  db: Database,
  taskId: string,
): ClarifyingQuestion[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_clarifying_questions
       WHERE task_id = ?
       ORDER BY sort_order, created_at`,
    )
    .all(taskId) as ClarifyingQuestionRow[];
  return rows.map(rowToQuestion);
}

export function openQuestions(db: Database, taskId: string): ClarifyingQuestion[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_clarifying_questions
       WHERE task_id = ? AND TRIM(answer) = ''
       ORDER BY sort_order, created_at`,
    )
    .all(taskId) as ClarifyingQuestionRow[];
  return rows.map(rowToQuestion);
}

export function answerQuestion(
  db: Database,
  id: string,
  input: AnswerQuestionInput,
): ClarifyingQuestion | null {
  if (!input.answer.trim()) {
    throw new Error(`answer must be non-empty`);
  }
  const existing = getClarifyingQuestion(db, id);
  if (!existing) return null;
  const now = Date.now();
  db.prepare(
    `UPDATE task_clarifying_questions
       SET answer = ?, answered_by = ?, answered_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(input.answer, input.answeredBy, now, now, id);
  return getClarifyingQuestion(db, id);
}
