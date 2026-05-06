import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';
import type { AgentContextUsage } from '../context-usage.js';
import { capacityBlockFromContextUsage } from '../provider-capacity.js';

export type AgentRunActionKind =
  | 'prompt'
  | 'run'
  | 'permission'
  | 'adapter'
  | 'diagnostic'
  | 'message'
  | 'error'
  | 'ledger';
export type AgentRunActionStatus = 'info' | 'running' | 'completed' | 'failed';

export interface AgentRunAction {
  id: string;
  roomId: string;
  taskId: string | null;
  runId: string;
  agentId: AgentId;
  kind: AgentRunActionKind;
  status: AgentRunActionStatus;
  label: string;
  detail: string;
  contextUsage?: AgentContextUsage;
  createdAt: number;
}

interface AgentRunActionRow {
  id: string;
  room_id: string;
  task_id: string | null;
  run_id: string;
  agent_id: AgentId;
  kind: AgentRunActionKind;
  status: AgentRunActionStatus;
  label: string;
  detail: string;
  context_usage_json: string;
  created_at: number;
}

export interface AgentRunActionAggregate {
  kind: AgentRunActionKind;
  status: AgentRunActionStatus;
  count: number;
  withContextUsage: number;
}

interface AgentRunActionAggregateRow {
  kind: AgentRunActionKind;
  status: AgentRunActionStatus;
  count: number;
  with_context_usage: number;
}

export interface CreateAgentRunActionInput {
  roomId: string;
  taskId?: string | null;
  runId: string;
  agentId: AgentId;
  kind: AgentRunActionKind;
  status: AgentRunActionStatus;
  label: string;
  detail?: string;
  contextUsage?: AgentContextUsage;
}

function bounded(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function rowToAgentRunAction(row: AgentRunActionRow): AgentRunAction {
  const contextUsage = parseContextUsage(row.context_usage_json);
  return {
    id: row.id,
    roomId: row.room_id,
    taskId: row.task_id,
    runId: row.run_id,
    agentId: row.agent_id,
    kind: row.kind,
    status: row.status,
    label: row.label,
    detail: row.detail,
    ...(contextUsage ? { contextUsage } : {}),
    createdAt: row.created_at,
  };
}

function parseContextUsage(json: string): AgentContextUsage | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const obj = parsed as Partial<AgentContextUsage>;
    if (typeof obj.provider !== 'string' || typeof obj.model !== 'string') return undefined;
    if (typeof obj.usedTokens !== 'number' || !Number.isFinite(obj.usedTokens)) return undefined;
    return obj as AgentContextUsage;
  } catch {
    return undefined;
  }
}

export function createAgentRunAction(
  db: Database,
  input: CreateAgentRunActionInput,
): AgentRunAction {
  const id = nanoid(16);
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_run_actions (
      id, room_id, task_id, run_id, agent_id, kind, status, label, detail, context_usage_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.roomId,
    input.taskId ?? null,
    input.runId,
    input.agentId,
    input.kind,
    input.status,
    bounded(input.label, 160),
    bounded(input.detail ?? '', 2000),
    input.contextUsage ? JSON.stringify(input.contextUsage) : '',
    now,
  );
  return getAgentRunAction(db, id)!;
}

export function getAgentRunAction(db: Database, id: string): AgentRunAction | null {
  const row = db.prepare(`SELECT * FROM agent_run_actions WHERE id = ?`).get(id) as
    | AgentRunActionRow
    | undefined;
  return row ? rowToAgentRunAction(row) : null;
}

export function listRecentAgentRunActions(
  db: Database,
  roomId: string,
  limit = 60,
): AgentRunAction[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_run_actions
       WHERE room_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(roomId, limit) as AgentRunActionRow[];
  return rows.map(rowToAgentRunAction);
}

export function listRecentContextUsageActionsForRoom(
  db: Database,
  roomId: string,
  limit = 200,
): AgentRunAction[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_run_actions
       WHERE room_id = ? AND context_usage_json <> ''
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(roomId, limit) as AgentRunActionRow[];
  return rows.map(rowToAgentRunAction);
}

export function listRecentContextUsageActions(
  db: Database,
  limit = 500,
): AgentRunAction[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_run_actions
       WHERE context_usage_json <> ''
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(limit) as AgentRunActionRow[];
  return rows.map(rowToAgentRunAction);
}

export function listAgentRunActionAggregatesForRoom(
  db: Database,
  roomId: string,
): AgentRunActionAggregate[] {
  const rows = db
    .prepare(
      `SELECT
         kind,
         status,
         COUNT(*) AS count,
         SUM(CASE WHEN context_usage_json <> '' THEN 1 ELSE 0 END) AS with_context_usage
       FROM agent_run_actions
       WHERE room_id = ?
       GROUP BY kind, status`,
    )
    .all(roomId) as AgentRunActionAggregateRow[];
  return rows.map((row) => ({
    kind: row.kind,
    status: row.status,
    count: row.count,
    withContextUsage: row.with_context_usage,
  }));
}

export function listAgentRunActionsForRoom(db: Database, roomId: string): AgentRunAction[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_run_actions
       WHERE room_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(roomId) as AgentRunActionRow[];
  return rows.map(rowToAgentRunAction);
}

/**
 * Clear every recent context-usage row that currently represents an active
 * provider-capacity block for `providerId`. Walks the most recent 1000 rows
 * (DESC), JS-parses each `context_usage_json`, and identifies real blocks
 * via `capacityBlockFromContextUsage` (same logic the dispatch path uses to
 * decide whether to refuse). Clears `context_usage_json` to '' on those rows
 * — the SQL filter `context_usage_json <> ''` then skips them on the next
 * walk, so the block evaporates without destroying audit metadata (id, run,
 * label, detail all stay intact).
 *
 * Safe to call when there are no blocks: returns `{ cleared: 0 }`.
 */
export function clearProviderQuotaBlocks(
  db: Database,
  providerId: string,
  now = Date.now(),
): { cleared: number } {
  const rows = db
    .prepare(
      `SELECT id, context_usage_json, created_at FROM agent_run_actions
       WHERE context_usage_json <> ''
       ORDER BY created_at DESC, id DESC
       LIMIT 1000`,
    )
    .all() as Array<{ id: string; context_usage_json: string; created_at: number }>;

  const idsToClear: string[] = [];
  for (const row of rows) {
    const usage = parseContextUsage(row.context_usage_json);
    if (!usage || usage.provider !== providerId) continue;
    const block = capacityBlockFromContextUsage(usage, now, row.created_at);
    if (block) idsToClear.push(row.id);
  }

  if (idsToClear.length === 0) return { cleared: 0 };

  const stmt = db.prepare(`UPDATE agent_run_actions SET context_usage_json = '' WHERE id = ?`);
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(id);
  });
  tx(idsToClear);

  return { cleared: idsToClear.length };
}

export function listAgentRunActions(db: Database, runId: string): AgentRunAction[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_run_actions
       WHERE run_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(runId) as AgentRunActionRow[];
  return rows.map(rowToAgentRunAction);
}
