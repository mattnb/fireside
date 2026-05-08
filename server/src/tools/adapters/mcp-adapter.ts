// server/src/tools/adapters/mcp-adapter.ts
//
// JSON-RPC 2.0 dispatch for the optional `/api/mcp` endpoint. This adapter is
// transport-agnostic on purpose: the Fastify route registration, auth
// pre-handler, and feature-flag gate live in `http-server.ts` (Milestone 6).
// This file knows nothing about Fastify; it parses JSON-RPC envelopes, maps
// MCP methods onto the registry / `executeToolCall` engine, and returns a
// JSON-RPC response.
//
// See docs/phase-6-mcp-endpoint-design-2026-05-07.md for the full design.

import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../../agents/types.js';
import type { PermissionGrant } from '../../permissions.js';
import { getRoom } from '../../repos/rooms.js';
import { executeToolCall } from '../execute-tool-call.js';
import {
  defaultToolRegistry,
  type ToolRegistry,
} from '../registry.js';
import type { StatePermission } from '../permissions/state-permissions.js';
import { statePermissionsForGrant } from '../permissions/authorize-tool-call.js';
import type {
  AgentToolCall,
  ExecuteToolCallOutcome,
} from '../types.js';

/**
 * Tools the MCP endpoint is allowed to invoke. Phase 6 deliberately ships a
 * narrow allowlist; widening it is a Phase 7 decision once per-caller
 * identity is modelled. See the design memo §"Tool exposure surface".
 */
export const MCP_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'mission.task.update',
  'mission.task.add_note',
  'mission.phase.create',
  'mission.phase.update',
  'mission.phase.complete',
  'mission.phase.reopen',
  'mission.plan.create',
  'mission.plan.update',
  'mission.plan.activate',
  'mission.plan.archive',
  'mission.receipt.submit',
]);

/** JSON-RPC 2.0 error codes used by the adapter. */
export const MCP_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Application-defined: tool execution returned a non-applied terminal status. */
  toolFailed: -32000,
  /** Application-defined: caller tried to invoke a tool not on the allowlist. */
  toolNotExposed: -32001,
} as const;

export interface McpDispatchContext {
  db: Database;
  registry?: ToolRegistry;
  /** Caller identity. Required for audit rows and authorization. */
  agentId: AgentId;
  roomId: string;
  missionId: string | null;
  /** Filesystem permission grant; state permissions are derived from this. */
  permission?: PermissionGrant | null;
  /** Override/augment grant-derived state permissions. */
  statePermissions?: readonly StatePermission[];
  /** Injectable clock for tests. */
  now?: () => number;
  /** Optional id minter for the synthetic call id. Tests can pin it. */
  newCallId?: () => string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

interface ToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
  idempotencyKey?: string;
}

/** Validate a parsed JSON value as a JSON-RPC 2.0 request. */
export function parseJsonRpcRequest(
  raw: unknown,
): { ok: true; value: JsonRpcRequest } | { ok: false; error: JsonRpcErrorResponse } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: errorResponse(null, MCP_ERROR.invalidRequest, 'request must be a JSON object') };
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.jsonrpc !== '2.0') {
    return {
      ok: false,
      error: errorResponse(envelopeId(candidate.id), MCP_ERROR.invalidRequest, 'jsonrpc must be "2.0"'),
    };
  }
  if (typeof candidate.method !== 'string' || !candidate.method) {
    return {
      ok: false,
      error: errorResponse(envelopeId(candidate.id), MCP_ERROR.invalidRequest, 'method is required'),
    };
  }
  return {
    ok: true,
    value: {
      jsonrpc: '2.0',
      id: envelopeId(candidate.id),
      method: candidate.method,
      params: candidate.params,
    },
  };
}

/**
 * Dispatch a JSON-RPC request against the tool engine. Always resolves; never
 * throws. Domain failures map to JSON-RPC error envelopes so the transport
 * layer can serialize unconditionally.
 */
export async function dispatchMcpRequest(
  request: JsonRpcRequest,
  ctx: McpDispatchContext,
): Promise<JsonRpcResponse> {
  const registry = ctx.registry ?? defaultToolRegistry;
  const id = request.id ?? null;

  switch (request.method) {
    case 'tools/list':
      return successResponse(id, {
        tools: registry.listTools({
          allowedNames: MCP_TOOL_ALLOWLIST,
          statePermissions: effectiveStatePermissions(ctx),
        }),
      });

    case 'tools/call':
      return await runToolsCall(id, request.params, ctx, registry);

    default:
      return errorResponse(id, MCP_ERROR.methodNotFound, `unknown method: ${request.method}`);
  }
}

function effectiveStatePermissions(ctx: McpDispatchContext): StatePermission[] {
  return [
    ...new Set([
      ...statePermissionsForGrant(ctx.permission ?? null),
      ...(ctx.statePermissions ?? []),
    ]),
  ];
}

async function runToolsCall(
  id: JsonRpcSuccessResponse['id'],
  rawParams: unknown,
  ctx: McpDispatchContext,
  registry: ToolRegistry,
): Promise<JsonRpcResponse> {
  const params = parseToolsCallParams(rawParams);
  if (!params.ok) return errorResponse(id, MCP_ERROR.invalidParams, params.error);

  const { name, arguments: args, idempotencyKey } = params.value;

  if (!MCP_TOOL_ALLOWLIST.has(name) || !registry.has(name)) {
    return errorResponse(id, MCP_ERROR.toolNotExposed, `tool not exposed via MCP: ${name}`);
  }

  // Validate routing context up-front so a missing/unknown room never reaches
  // the engine (the audit-row INSERT has a `room_id REFERENCES rooms(id)` FK
  // and would otherwise surface as a 500 with a SQLite stack).
  if (!ctx.roomId) {
    return errorResponse(
      id,
      MCP_ERROR.invalidParams,
      'tools/call requires routing context: set the x-fireside-room-id header',
    );
  }
  if (!getRoom(ctx.db, ctx.roomId)) {
    return errorResponse(id, MCP_ERROR.invalidParams, `unknown roomId: ${ctx.roomId}`);
  }

  const now = ctx.now ?? Date.now;
  const newCallId = ctx.newCallId ?? (() => nanoid(16));
  const call: AgentToolCall = {
    id: newCallId(),
    tool: name,
    idempotencyKey,
    args,
    source: 'mcp',
    roomId: ctx.roomId,
    missionId: ctx.missionId,
    runId: null,
    messageId: null,
    agentId: ctx.agentId,
    createdAt: now(),
  };

  const outcome = await executeToolCall({
    db: ctx.db,
    registry,
    call,
    ...(ctx.permission !== undefined ? { permission: ctx.permission } : {}),
    ...(ctx.statePermissions !== undefined ? { statePermissions: ctx.statePermissions } : {}),
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
  });

  return outcomeToJsonRpc(id, outcome);
}

function parseToolsCallParams(
  rawParams: unknown,
):
  | { ok: true; value: { name: string; arguments: Record<string, unknown>; idempotencyKey: string } }
  | { ok: false; error: string } {
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return { ok: false, error: 'tools/call params must be an object' };
  }
  const candidate = rawParams as Record<string, unknown>;
  const name = candidate.name;
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'tools/call requires string `name`' };
  }
  const idempotencyKey = candidate.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    return {
      ok: false,
      error: 'tools/call requires string `idempotencyKey` (server-minted keys defeat duplicate collapse)',
    };
  }
  const argsRaw = candidate.arguments ?? {};
  if (typeof argsRaw !== 'object' || argsRaw === null || Array.isArray(argsRaw)) {
    return { ok: false, error: 'tools/call `arguments` must be an object' };
  }
  return {
    ok: true,
    value: {
      name: name.trim(),
      arguments: argsRaw as Record<string, unknown>,
      idempotencyKey: idempotencyKey.trim(),
    },
  };
}

function outcomeToJsonRpc(
  id: JsonRpcSuccessResponse['id'],
  outcome: ExecuteToolCallOutcome,
): JsonRpcResponse {
  if (outcome.status === 'applied' || outcome.status === 'duplicate') {
    return successResponse(id, {
      callId: outcome.callId,
      toolName: outcome.toolName,
      status: outcome.status,
      summary: outcome.summary,
      duplicateOfCallId: outcome.duplicateOfCallId,
      result: outcome.result ?? null,
    });
  }
  return errorResponse(id, MCP_ERROR.toolFailed, outcome.error || outcome.summary || outcome.status, {
    callId: outcome.callId,
    toolName: outcome.toolName,
    status: outcome.status,
  });
}

function successResponse(
  id: JsonRpcSuccessResponse['id'],
  result: unknown,
): JsonRpcSuccessResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(
  id: JsonRpcErrorResponse['id'],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data !== undefined ? { code, message, data } : { code, message },
  };
}

function envelopeId(value: unknown): string | number | null {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}
