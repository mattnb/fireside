// server/src/activity-stream/audit-stream.ts
//
// Per-room unified audit stream. Reads every long-lived audit table
// (run actions, mission command events, routing decisions, tool calls,
// permission requests, turn outcomes), normalizes each into an `AuditEvent`,
// and returns the merged stream sorted by createdAt DESC.
//
// The sources already power individual surfaces (run-detail modal, evidence
// view, agent panel), but Chorus's "structured audit stream with session
// attribution" is missing — the user has to glue them together by reading
// across tabs. This module is the glue layer.
//
// All sources are accessed through their existing repos so we don't leak SQL
// outside the data-access layer.

import type { Database } from 'better-sqlite3';
import { listRecentAgentRunActions } from '../repos/run-actions.js';
import { listRoutingDecisionsForRoom } from '../repos/routing-decisions.js';
import { listMissionCommandEventsForRoom } from '../repos/mission-command-events.js';
import { listAgentTurnOutcomesForRoom } from '../repos/turn-outcomes.js';
import { listPermissionRequestsForRoom } from '../repos/permission-requests.js';
import { listAgentToolCallsForRoom } from './tool-call-listing.js';

export type AuditEventKind =
  | 'run-action'
  | 'mission-command'
  | 'routing-decision'
  | 'tool-call'
  | 'permission-request'
  | 'turn-outcome';

export const AUDIT_EVENT_KINDS = [
  'run-action',
  'mission-command',
  'routing-decision',
  'tool-call',
  'permission-request',
  'turn-outcome',
] as const;

export interface AuditEvent {
  /** Kind groups the event by its underlying table. UI uses it for filter
   *  chips and icons. */
  kind: AuditEventKind;
  /** Stable id of the underlying row. Combined with `kind` it uniquely
   *  identifies the event. */
  id: string;
  /** Acting agent or 'system' / 'human' for non-agent rows. */
  agentId: string;
  /** Lifecycle status when applicable (run-action.status, tool-call.status,
   *  permission.status, mission-command.status, routing.action,
   *  turn-outcome.status). */
  status: string;
  /** Sub-classification (e.g. mission command kind, routing decision kind,
   *  tool name, run-action kind). */
  subKind: string;
  /** Short headline for the row. */
  summary: string;
  /** Optional secondary text — extra context, evidence, or args summary. */
  detail: string;
  taskId: string | null;
  runId: string | null;
  createdAt: number;
}

export interface AuditStreamOptions {
  /** Restrict to one or more kinds. */
  kinds?: readonly AuditEventKind[];
  /** Restrict to one agent (acting agent id). */
  agentId?: string;
  /** Restrict to one task. */
  taskId?: string;
  /** Hard cap on returned events. Defaults to 200, max 1000. */
  limit?: number;
  /** Per-source pull cap. Defaults to 200. Each source pulls at most this
   *  many rows DESC before merging. */
  perSourceLimit?: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function shorten(value: string, max: number): string {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

export function buildAuditStream(
  db: Database,
  roomId: string,
  opts: AuditStreamOptions = {},
): AuditEvent[] {
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const perSource = Math.min(MAX_LIMIT, Math.max(20, opts.perSourceLimit ?? DEFAULT_LIMIT));
  const allowed: ReadonlySet<AuditEventKind> = new Set(
    opts.kinds && opts.kinds.length > 0 ? opts.kinds : AUDIT_EVENT_KINDS,
  );

  const events: AuditEvent[] = [];

  if (allowed.has('run-action')) {
    for (const row of listRecentAgentRunActions(db, roomId, perSource)) {
      events.push({
        kind: 'run-action',
        id: row.id,
        agentId: row.agentId,
        status: row.status,
        subKind: row.kind,
        summary: shorten(row.label, 160),
        detail: shorten(row.detail, 600),
        taskId: row.taskId,
        runId: row.runId,
        createdAt: row.createdAt,
      });
    }
  }

  if (allowed.has('mission-command')) {
    for (const row of listMissionCommandEventsForRoom(db, roomId, perSource)) {
      events.push({
        kind: 'mission-command',
        id: row.id,
        agentId: row.agentId,
        status: row.status,
        subKind: row.commandKind + (row.action ? `:${row.action}` : ''),
        summary: shorten(row.summary || `${row.commandKind} ${row.action}`.trim(), 160),
        detail: row.targetRef ? `target: ${shorten(row.targetRef, 240)}` : '',
        taskId: row.taskId,
        runId: row.runId,
        createdAt: row.createdAt,
      });
    }
  }

  if (allowed.has('routing-decision')) {
    for (const row of listRoutingDecisionsForRoom(db, roomId, perSource)) {
      const responders = row.responders.length > 0 ? `→ ${row.responders.join(', ')}` : '';
      events.push({
        kind: 'routing-decision',
        id: row.id,
        agentId: row.authorId || 'system',
        status: row.action,
        subKind: row.kind,
        summary: shorten(`${row.kind}: ${row.action} ${responders}`.trim(), 160),
        detail: shorten(row.reason, 480),
        taskId: row.taskId,
        runId: row.runId,
        createdAt: row.createdAt,
      });
    }
  }

  if (allowed.has('tool-call')) {
    for (const row of listAgentToolCallsForRoom(db, roomId, perSource)) {
      const arrow =
        row.target ? ` · target ${shorten(row.target, 80)}` : '';
      const summary = `${row.toolName}${arrow}`;
      const detail = row.error
        ? `error: ${shorten(row.error, 400)}`
        : shorten(row.summary, 480);
      events.push({
        kind: 'tool-call',
        id: row.id,
        agentId: row.agentId,
        status: row.status,
        subKind: row.toolName,
        summary: shorten(summary, 160),
        detail,
        taskId: row.missionId,
        runId: row.runId,
        createdAt: row.createdAt,
      });
    }
  }

  if (allowed.has('permission-request')) {
    for (const row of listPermissionRequestsForRoom(db, roomId, perSource)) {
      events.push({
        kind: 'permission-request',
        id: row.id,
        agentId: row.agentId,
        status: row.status,
        subKind: row.requestedMode || row.mode,
        summary: shorten(`permission: ${row.target}`, 160),
        detail: shorten(row.reason, 480),
        taskId: null,
        runId: null,
        createdAt: row.createdAt,
      });
    }
  }

  if (allowed.has('turn-outcome')) {
    for (const row of listAgentTurnOutcomesForRoom(db, roomId, perSource)) {
      events.push({
        kind: 'turn-outcome',
        id: row.id,
        agentId: row.agentId,
        status: row.status,
        subKind: row.runKind ?? '',
        summary: shorten(row.summary || `turn ${row.status}`, 160),
        detail: row.error ? `error: ${shorten(row.error, 400)}` : '',
        taskId: row.taskId,
        runId: row.runId,
        createdAt: row.createdAt,
      });
    }
  }

  // Apply optional filters before sort/limit so we don't waste sort work on
  // rows we will discard.
  let filtered = events;
  if (opts.agentId) {
    filtered = filtered.filter((event) => event.agentId === opts.agentId);
  }
  if (opts.taskId) {
    filtered = filtered.filter((event) => event.taskId === opts.taskId);
  }

  filtered.sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id.localeCompare(b.id);
  });
  return filtered.slice(0, limit);
}
