import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';

export type CollaborationKind = 'proposal' | 'challenge' | 'revision' | 'decision' | 'evidence';
export type CollaborationStatus =
  | 'open'
  | 'blocked'
  | 'accepted'
  | 'rejected'
  | 'resolved'
  | 'superseded'
  | 'informational';
export type CollaborationConfidence = '' | 'low' | 'medium' | 'high';

export interface CollaborationItem {
  id: string;
  roomId: string;
  taskId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  messageId: string | null;
  runId: string | null;
  agentId: AgentId;
  kind: CollaborationKind;
  status: CollaborationStatus;
  confidence: CollaborationConfidence;
  title: string;
  target: string;
  body: string;
  evidence: string[];
  createdAt: number;
}

interface CollaborationItemRow {
  id: string;
  room_id: string;
  task_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  message_id: string | null;
  run_id: string | null;
  agent_id: AgentId;
  kind: CollaborationKind;
  status: CollaborationStatus;
  confidence: CollaborationConfidence;
  title: string;
  target: string;
  body: string;
  evidence_json: string;
  created_at: number;
}

export interface CreateCollaborationItemInput {
  roomId: string;
  taskId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  messageId?: string | null;
  runId?: string | null;
  agentId: AgentId;
  kind: CollaborationKind;
  status: CollaborationStatus;
  confidence?: CollaborationConfidence;
  title: string;
  target?: string;
  body?: string;
  evidence?: string[];
}

function parseEvidence(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function rowToCollaborationItem(row: CollaborationItemRow): CollaborationItem {
  return {
    id: row.id,
    roomId: row.room_id,
    taskId: row.task_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    messageId: row.message_id,
    runId: row.run_id,
    agentId: row.agent_id,
    kind: row.kind,
    status: row.status,
    confidence: row.confidence,
    title: row.title,
    target: row.target,
    body: row.body,
    evidence: parseEvidence(row.evidence_json),
    createdAt: row.created_at,
  };
}

function bounded(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

export function createCollaborationItem(
  db: Database,
  input: CreateCollaborationItemInput,
): CollaborationItem {
  const id = nanoid(16);
  const now = Date.now();
  db.prepare(
    `INSERT INTO collaboration_items (
      id, room_id, task_id, subject_type, subject_id, message_id, run_id, agent_id, kind, status, confidence,
      title, target, body, evidence_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.roomId,
    input.taskId ?? null,
    input.subjectType ?? null,
    input.subjectId ?? null,
    input.messageId ?? null,
    input.runId ?? null,
    input.agentId,
    input.kind,
    input.status,
    input.confidence ?? '',
    bounded(input.title, 240),
    bounded(input.target ?? '', 500),
    bounded(input.body ?? '', 2000),
    JSON.stringify((input.evidence ?? []).map((item) => bounded(item, 500)).slice(0, 12)),
    now,
  );
  return getCollaborationItem(db, id)!;
}

export interface UpdateCollaborationItemInput {
  title?: string;
  body?: string;
  status?: CollaborationStatus;
  confidence?: CollaborationConfidence;
  evidence?: string[];
}

export function updateCollaborationItem(
  db: Database,
  id: string,
  input: UpdateCollaborationItemInput,
): CollaborationItem | null {
  const existing = getCollaborationItem(db, id);
  if (!existing) return null;
  const next: CollaborationItem = {
    ...existing,
    title: input.title !== undefined ? bounded(input.title, 240) : existing.title,
    body: input.body !== undefined ? bounded(input.body, 2000) : existing.body,
    status: input.status ?? existing.status,
    confidence: input.confidence ?? existing.confidence,
    evidence:
      input.evidence !== undefined
        ? input.evidence.map((item) => bounded(item, 500)).slice(0, 12)
        : existing.evidence,
  };
  db.prepare(
    `UPDATE collaboration_items
        SET title = ?, body = ?, status = ?, confidence = ?, evidence_json = ?
      WHERE id = ?`,
  ).run(
    next.title,
    next.body,
    next.status,
    next.confidence,
    JSON.stringify(next.evidence),
    id,
  );
  return getCollaborationItem(db, id);
}

export function getCollaborationItem(db: Database, id: string): CollaborationItem | null {
  const row = db.prepare(`SELECT * FROM collaboration_items WHERE id = ?`).get(id) as
    | CollaborationItemRow
    | undefined;
  return row ? rowToCollaborationItem(row) : null;
}

export function listCollaborationItems(
  db: Database,
  roomId: string,
  opts: { limit?: number; taskId?: string | null } = {},
): CollaborationItem[] {
  const limit = opts.limit ?? 50;
  const rows =
    opts.taskId === undefined
      ? (db
          .prepare(
            `SELECT * FROM collaboration_items
             WHERE room_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(roomId, limit) as CollaborationItemRow[])
      : (db
          .prepare(
            `SELECT * FROM collaboration_items
             WHERE room_id = ? AND task_id IS ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(roomId, opts.taskId, limit) as CollaborationItemRow[]);
  return rows.map(rowToCollaborationItem);
}
