// server/src/activity-stream/tool-call-listing.ts
//
// Helper for the audit stream: list recent agent_tool_calls audit rows for a
// room as `AgentToolCallView` objects. Lives next to the audit-stream
// builder (rather than in tools/audit.ts) because the existing repo only
// exposed per-run listing; this is the per-room counterpart.

import type { Database } from 'better-sqlite3';
import type {
  AgentToolCallStatus,
  AgentToolEffect,
  AgentToolResult,
  AgentToolSource,
} from '../tools/types.js';
import type { AgentId } from '../agents/types.js';

export interface AgentToolCallAuditRow {
  id: string;
  roomId: string;
  missionId: string | null;
  runId: string | null;
  messageId: string | null;
  agentId: AgentId;
  toolName: string;
  status: AgentToolCallStatus;
  source: AgentToolSource;
  target: string;
  summary: string;
  error: string;
  effects: AgentToolEffect[];
  createdAt: number;
}

interface RawRow {
  id: string;
  room_id: string;
  mission_id: string | null;
  run_id: string | null;
  message_id: string | null;
  agent_id: AgentId;
  tool_name: string;
  status: AgentToolCallStatus;
  source: AgentToolSource;
  args_json: string;
  normalized_args_json: string;
  result_json: string;
  error: string;
  created_at: number;
}

const TARGET_ID_KEYS = ['taskId', 'itemId', 'phaseId', 'planId', 'missionId', 'permissionId', 'noteId'];

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

function deriveTarget(
  normalizedArgs: Record<string, unknown>,
  rawArgs: Record<string, unknown>,
): string {
  for (const source of [normalizedArgs, rawArgs]) {
    for (const key of TARGET_ID_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
}

export function listAgentToolCallsForRoom(
  db: Database,
  roomId: string,
  limit = 100,
): AgentToolCallAuditRow[] {
  const rows = db
    .prepare(
      `SELECT id, room_id, mission_id, run_id, message_id, agent_id,
              tool_name, status, source, args_json, normalized_args_json,
              result_json, error, created_at
         FROM agent_tool_calls
        WHERE room_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(roomId, limit) as RawRow[];
  return rows.map((row) => {
    const normalizedArgs = parseRecord(row.normalized_args_json);
    const rawArgs = parseRecord(row.args_json);
    const result = parseResult(row.result_json);
    return {
      id: row.id,
      roomId: row.room_id,
      missionId: row.mission_id,
      runId: row.run_id,
      messageId: row.message_id,
      agentId: row.agent_id,
      toolName: row.tool_name,
      status: row.status,
      source: row.source,
      target: deriveTarget(normalizedArgs, rawArgs),
      summary: result?.summary ?? '',
      error: row.error,
      effects: result?.effects ?? [],
      createdAt: row.created_at,
    };
  });
}
