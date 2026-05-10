// server/src/repos/notifications.ts
//
// CRUD for the in-app notification inbox. The notifications themselves are
// produced by `notification-fanout.ts` from broker events; this module is a
// thin persistence layer + read/dismiss helpers.
//
// We use a `dedupe_key` UNIQUE INDEX (partial, only enforced when non-empty)
// so the same logical event firing twice doesn't double-list. Callers pick
// the dedupe key — typically `<kind>:<targetId>` — and pass it through
// `createNotification`.

import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export const NOTIFICATION_KINDS = [
  'permission-requested',
  'approval-needed',
  'verifier-needed',
  'task-done',
  'task-rejected',
  'run-failed',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SEVERITIES = ['info', 'warn', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export interface Notification {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  roomId: string | null;
  taskId: string | null;
  runId: string | null;
  permissionRequestId: string | null;
  agentId: string;
  summary: string;
  detail: string;
  payload: Record<string, unknown>;
  createdAt: number;
  readAt: number | null;
  dismissedAt: number | null;
}

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  room_id: string | null;
  task_id: string | null;
  run_id: string | null;
  permission_request_id: string | null;
  agent_id: string;
  summary: string;
  detail: string;
  payload_json: string;
  dedupe_key: string;
  created_at: number;
  read_at: number | null;
  dismissed_at: number | null;
}

function parsePayload(json: string): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

function rowToNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    roomId: row.room_id,
    taskId: row.task_id,
    runId: row.run_id,
    permissionRequestId: row.permission_request_id,
    agentId: row.agent_id,
    summary: row.summary,
    detail: row.detail,
    payload: parsePayload(row.payload_json),
    createdAt: row.created_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
  };
}

export interface CreateNotificationInput {
  kind: NotificationKind;
  severity?: NotificationSeverity;
  roomId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  permissionRequestId?: string | null;
  agentId?: string;
  summary: string;
  detail?: string;
  payload?: Record<string, unknown>;
  /** When non-empty, INSERT OR IGNORE protects against duplicate creates. */
  dedupeKey?: string;
}

/** Insert a notification. Returns the created row, or null when the dedupe
 *  key already exists (no-op). */
export function createNotification(
  db: Database,
  input: CreateNotificationInput,
): Notification | null {
  const id = nanoid(14);
  const now = Date.now();
  const dedupeKey = (input.dedupeKey ?? '').slice(0, 240);
  // Use INSERT OR IGNORE so a duplicate dedupe_key produces 0 changes — no
  // throw, no logging churn, no ambiguous error path.
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO notifications (
        id, kind, severity, room_id, task_id, run_id, permission_request_id,
        agent_id, summary, detail, payload_json, dedupe_key, created_at,
        read_at, dismissed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      id,
      input.kind,
      input.severity ?? 'info',
      input.roomId ?? null,
      input.taskId ?? null,
      input.runId ?? null,
      input.permissionRequestId ?? null,
      input.agentId ?? '',
      input.summary.slice(0, 240),
      (input.detail ?? '').slice(0, 2000),
      JSON.stringify(input.payload ?? {}),
      dedupeKey,
      now,
    );
  if (result.changes === 0) return null;
  return getNotification(db, id);
}

export function getNotification(db: Database, id: string): Notification | null {
  const row = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id) as
    | NotificationRow
    | undefined;
  return row ? rowToNotification(row) : null;
}

export interface ListNotificationsOptions {
  limit?: number;
  /** When true, only return rows that haven't been dismissed yet. Defaults
   *  to true — a dismissed notification is invisible by default. */
  excludeDismissed?: boolean;
  /** When true, only return unread (and not dismissed) rows. */
  unreadOnly?: boolean;
}

export function listNotifications(
  db: Database,
  opts: ListNotificationsOptions = {},
): Notification[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const excludeDismissed = opts.excludeDismissed !== false;
  const filters: string[] = [];
  if (excludeDismissed) filters.push('dismissed_at IS NULL');
  if (opts.unreadOnly) filters.push('read_at IS NULL');
  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM notifications
       ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(limit) as NotificationRow[];
  return rows.map(rowToNotification);
}

export function countUnreadNotifications(db: Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM notifications
       WHERE read_at IS NULL AND dismissed_at IS NULL`,
    )
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export function markNotificationRead(db: Database, id: string): Notification | null {
  const now = Date.now();
  db.prepare(
    `UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`,
  ).run(now, id);
  return getNotification(db, id);
}

export function markAllNotificationsRead(db: Database): number {
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE notifications SET read_at = ?
       WHERE read_at IS NULL AND dismissed_at IS NULL`,
    )
    .run(now);
  return result.changes ?? 0;
}

export function dismissNotification(db: Database, id: string): Notification | null {
  const now = Date.now();
  db.prepare(
    `UPDATE notifications SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL`,
  ).run(now, id);
  return getNotification(db, id);
}
