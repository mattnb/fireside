// server/src/tools/audit.ts
//
// Persistence helpers for the `agent_tool_calls` audit table. The execute
// pipeline writes a row at decode time and updates it as the call advances
// through validation, permission, idempotency, and handler stages.

import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type {
  AgentToolCall,
  AgentToolCallStatus,
  AgentToolEffect,
  AgentToolResult,
  AgentToolSource,
} from './types.js';
import type { AgentId } from '../agents/types.js';

export interface AgentToolCallRow {
  id: string;
  roomId: string;
  missionId: string | null;
  runId: string | null;
  messageId: string | null;
  agentId: AgentId;
  toolName: string;
  idempotencyKey: string;
  source: AgentToolSource;
  status: AgentToolCallStatus;
  argsJson: string;
  normalizedArgsJson: string;
  resultJson: string;
  error: string;
  createdAt: number;
  appliedAt: number | null;
}

export interface InsertAgentToolCallInput {
  roomId: string;
  missionId: string | null;
  runId: string | null;
  messageId: string | null;
  agentId: AgentId;
  toolName: string;
  idempotencyKey: string;
  source: AgentToolSource;
  args: Record<string, unknown>;
  now: number;
}

/** Generate a stable id for a new audit row. */
export function newAgentToolCallId(): string {
  return nanoid(16);
}

/**
 * Insert a fresh audit row in the `decoded` state. Returns the row as it was
 * persisted so callers don't have to read it back.
 */
export function insertAgentToolCall(
  db: Database,
  input: InsertAgentToolCallInput,
): AgentToolCallRow {
  const id = newAgentToolCallId();
  const argsJson = JSON.stringify(input.args ?? {});
  db.prepare(
    `INSERT INTO agent_tool_calls (
      id, room_id, mission_id, run_id, message_id, agent_id,
      tool_name, idempotency_key, source, status,
      args_json, normalized_args_json, result_json, error, created_at, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'decoded', ?, '{}', '{}', '', ?, NULL)`,
  ).run(
    id,
    input.roomId,
    input.missionId,
    input.runId,
    input.messageId,
    input.agentId,
    input.toolName,
    input.idempotencyKey,
    input.source,
    argsJson,
    input.now,
  );

  return {
    id,
    roomId: input.roomId,
    missionId: input.missionId,
    runId: input.runId,
    messageId: input.messageId,
    agentId: input.agentId,
    toolName: input.toolName,
    idempotencyKey: input.idempotencyKey,
    source: input.source,
    status: 'decoded',
    argsJson,
    normalizedArgsJson: '{}',
    resultJson: '{}',
    error: '',
    createdAt: input.now,
    appliedAt: null,
  };
}

export interface UpdateAgentToolCallInput {
  status: AgentToolCallStatus;
  normalizedArgs?: Record<string, unknown>;
  result?: AgentToolResult;
  error?: string;
  appliedAt?: number | null;
}

/** Patch an existing audit row in place. */
export function updateAgentToolCall(
  db: Database,
  id: string,
  patch: UpdateAgentToolCallInput,
): void {
  const sets: string[] = ['status = ?'];
  const values: unknown[] = [patch.status];
  if (patch.normalizedArgs !== undefined) {
    sets.push('normalized_args_json = ?');
    values.push(JSON.stringify(patch.normalizedArgs));
  }
  if (patch.result !== undefined) {
    sets.push('result_json = ?');
    values.push(JSON.stringify(patch.result));
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    values.push(patch.error);
  }
  if (patch.appliedAt !== undefined) {
    sets.push('applied_at = ?');
    values.push(patch.appliedAt);
  }
  values.push(id);
  db.prepare(`UPDATE agent_tool_calls SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/** Read an audit row back. Useful for tests and replay. */
export function getAgentToolCall(db: Database, id: string): AgentToolCallRow | null {
  const row = db
    .prepare(
      `SELECT id, room_id, mission_id, run_id, message_id, agent_id,
              tool_name, idempotency_key, source, status,
              args_json, normalized_args_json, result_json, error,
              created_at, applied_at
         FROM agent_tool_calls
        WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToAgentToolCallRow(row) : null;
}

/** Decode a `tools.AgentToolCall` (transient) into an audit insert payload. */
export function callToInsertInput(call: AgentToolCall): InsertAgentToolCallInput {
  return {
    roomId: call.roomId,
    missionId: call.missionId,
    runId: call.runId,
    messageId: call.messageId,
    agentId: call.agentId,
    toolName: call.tool,
    idempotencyKey: call.idempotencyKey,
    source: call.source,
    args: call.args,
    now: call.createdAt,
  };
}

/**
 * UI-facing projection of an audit row. Decoded JSON columns are surfaced as
 * structured values, and a normalized target string is derived so the run
 * detail modal can render a concise "what did this tool act on" line.
 */
export interface AgentToolCallView {
  id: string;
  toolName: string;
  status: AgentToolCallStatus;
  source: AgentToolSource;
  agentId: AgentId;
  idempotencyKey: string;
  target: string;
  summary: string;
  error: string;
  args: Record<string, unknown>;
  normalizedArgs: Record<string, unknown>;
  result: AgentToolResult | null;
  effects: AgentToolEffect[];
  createdAt: number;
  appliedAt: number | null;
}

/** List tool-call audit rows for a run, oldest first. */
export function listAgentToolCallsForRun(
  db: Database,
  runId: string,
): AgentToolCallView[] {
  const rows = db
    .prepare(
      `SELECT id, room_id, mission_id, run_id, message_id, agent_id,
              tool_name, idempotency_key, source, status,
              args_json, normalized_args_json, result_json, error,
              created_at, applied_at
         FROM agent_tool_calls
        WHERE run_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(runId) as Record<string, unknown>[];
  return rows.map((raw) => toAgentToolCallView(rowToAgentToolCallRow(raw)));
}

function toAgentToolCallView(row: AgentToolCallRow): AgentToolCallView {
  const args = parseRecord(row.argsJson);
  const normalizedArgs = parseRecord(row.normalizedArgsJson);
  const result = parseResult(row.resultJson);
  return {
    id: row.id,
    toolName: row.toolName,
    status: row.status,
    source: row.source,
    agentId: row.agentId,
    idempotencyKey: row.idempotencyKey,
    target: deriveAuditTarget(normalizedArgs, args),
    summary: result?.summary ?? '',
    error: row.error,
    args,
    normalizedArgs,
    result,
    effects: result?.effects ?? [],
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
  };
}

function parseRecord(json: string): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function parseResult(json: string): AgentToolResult | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { status?: unknown }).status === 'string'
    ) {
      const candidate = parsed as Partial<AgentToolResult>;
      return {
        status: candidate.status as AgentToolResult['status'],
        summary: typeof candidate.summary === 'string' ? candidate.summary : '',
        data: candidate.data,
        effects: Array.isArray(candidate.effects)
          ? (candidate.effects as AgentToolEffect[])
          : [],
      };
    }
  } catch {
    // fall through
  }
  return null;
}

const TARGET_ID_KEYS = [
  'taskId',
  'itemId',
  'phaseId',
  'planId',
  'missionId',
  'permissionId',
  'noteId',
];

function deriveAuditTarget(
  normalizedArgs: Record<string, unknown>,
  rawArgs: Record<string, unknown>,
): string {
  const sources: Record<string, unknown>[] = [normalizedArgs, rawArgs];
  let id = '';
  let title = '';
  for (const source of sources) {
    if (!id) {
      for (const key of TARGET_ID_KEYS) {
        const value = source[key];
        if (typeof value === 'string' && value.trim()) {
          id = value.trim();
          break;
        }
      }
    }
    if (!title) {
      const t = source.title;
      if (typeof t === 'string' && t.trim()) title = t.trim();
    }
    if (id && title) break;
  }
  if (id && title) return `${id} (${title})`;
  return id || title || '';
}

function rowToAgentToolCallRow(row: Record<string, unknown>): AgentToolCallRow {
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    missionId: row.mission_id == null ? null : String(row.mission_id),
    runId: row.run_id == null ? null : String(row.run_id),
    messageId: row.message_id == null ? null : String(row.message_id),
    agentId: String(row.agent_id),
    toolName: String(row.tool_name),
    idempotencyKey: String(row.idempotency_key),
    source: row.source as AgentToolSource,
    status: row.status as AgentToolCallStatus,
    argsJson: String(row.args_json ?? '{}'),
    normalizedArgsJson: String(row.normalized_args_json ?? '{}'),
    resultJson: String(row.result_json ?? '{}'),
    error: String(row.error ?? ''),
    createdAt: Number(row.created_at),
    appliedAt: row.applied_at == null ? null : Number(row.applied_at),
  };
}
