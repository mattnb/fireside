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

import { createHash } from 'node:crypto';
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
 * Tools the MCP endpoint exposes. Phase 6 shipped a narrow allowlist gated
 * behind future per-caller identity work; on 2026-05-09 the allowlist was
 * widened to the full agent tool surface so MCP could replace the slash-block
 * text adapter for in-room agent tool calls. The single-tenant local-first
 * trust model (loopback unauthenticated, non-loopback bearer) still applies.
 */
export const MCP_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  // Mission task lifecycle (action='create' is supported on update for
  // historical compatibility; new agent flows should use action='create').
  'mission.task.update',
  'mission.task.add_note',
  // Mission phase lifecycle.
  'mission.phase.create',
  'mission.phase.update',
  'mission.phase.complete',
  'mission.phase.reopen',
  // Mission plan lifecycle.
  'mission.plan.create',
  'mission.plan.update',
  'mission.plan.activate',
  'mission.plan.archive',
  // Mission receipts.
  'mission.receipt.submit',
  // Collaboration ledger — replaces the /collab-note slash-block adapter.
  'collab.note.add',
  'collab.note.update',
  // Permission requests — replaces the /permission-request slash-block adapter.
  'permission.request',
  // Agent self-management — replaces the /agent-roster slash-block adapter.
  'agent.set_status',
  'agent.checkin',
  'agent.list_assignments',
  'agent.ack_message',
  'agent.request_turns',
  // Discoverability (read-only).
  'search.tools',
]);

/** JSON-RPC 2.0 error codes used by the adapter. */
export const MCP_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
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
  /** When the call belongs to a specific spawned-agent turn, the run id
   *  the transport inferred from the running agent_run. Recorded on the
   *  audit row so tool calls associate with their producing run. */
  runId?: string | null;
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
 * MCP protocol version this server speaks. Echoed back from `initialize` when
 * the client doesn't request a specific version. The MCP spec also accepts
 * older versions if the client requests one we recognize, so a client on
 * 2024-11-05 still gets a successful handshake.
 */
const MCP_PROTOCOL_VERSIONS_SUPPORTED: ReadonlySet<string> = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
]);
const MCP_PROTOCOL_VERSION_DEFAULT = '2025-06-18';

const MCP_SERVER_INFO = { name: 'fireside', version: '0.1.0' } as const;

/**
 * Dispatch a JSON-RPC request against the tool engine. Always resolves; never
 * throws. Domain failures map to JSON-RPC error envelopes so the transport
 * layer can serialize unconditionally. Returns `null` for JSON-RPC
 * notifications (no `id`, method starting with `notifications/`); the HTTP
 * transport translates that to a 202 with no body per the MCP spec.
 */
export async function dispatchMcpRequest(
  request: JsonRpcRequest,
  ctx: McpDispatchContext,
): Promise<JsonRpcResponse | null> {
  const registry = ctx.registry ?? defaultToolRegistry;
  const id = request.id ?? null;

  switch (request.method) {
    case 'initialize':
      return successResponse(id, buildInitializeResult(request.params));

    case 'notifications/initialized':
    case 'notifications/cancelled':
      // JSON-RPC notifications: spec forbids returning a response.
      return null;

    case 'ping':
      return successResponse(id, {});

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
      if (request.method.startsWith('notifications/')) return null;
      return errorResponse(id, MCP_ERROR.methodNotFound, `unknown method: ${request.method}`);
  }
}

function buildInitializeResult(rawParams: unknown): {
  protocolVersion: string;
  capabilities: { tools: Record<string, unknown> };
  serverInfo: { name: string; version: string };
} {
  let requestedVersion: string | null = null;
  if (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
    const candidate = (rawParams as { protocolVersion?: unknown }).protocolVersion;
    if (typeof candidate === 'string') requestedVersion = candidate;
  }
  const protocolVersion =
    requestedVersion && MCP_PROTOCOL_VERSIONS_SUPPORTED.has(requestedVersion)
      ? requestedVersion
      : MCP_PROTOCOL_VERSION_DEFAULT;
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { ...MCP_SERVER_INFO },
  };
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
  const effectiveKey = idempotencyKey ?? deriveMcpIdempotencyKey({
    toolName: name,
    args,
    agentId: ctx.agentId,
    roomId: ctx.roomId,
  });
  const call: AgentToolCall = {
    id: newCallId(),
    tool: name,
    idempotencyKey: effectiveKey,
    args,
    source: 'mcp',
    roomId: ctx.roomId,
    missionId: ctx.missionId,
    runId: ctx.runId ?? null,
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
  | { ok: true; value: { name: string; arguments: Record<string, unknown>; idempotencyKey: string | null } }
  | { ok: false; error: string } {
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return { ok: false, error: 'tools/call params must be an object' };
  }
  const candidate = rawParams as Record<string, unknown>;
  const name = candidate.name;
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'tools/call requires string `name`' };
  }
  // The MCP spec defines tools/call params as { name, arguments }; idempotency
  // is an extension. Accept it from the top-level (Fireside-native callers) or
  // from `_meta.idempotencyKey` (the MCP convention for protocol metadata). If
  // neither is present, the dispatcher mints a deterministic key from the
  // canonical (caller, tool, args) tuple so retries with identical inputs
  // still collapse to `duplicate` exactly like a caller-supplied key would.
  const meta = (candidate._meta && typeof candidate._meta === 'object' && !Array.isArray(candidate._meta))
    ? (candidate._meta as Record<string, unknown>)
    : null;
  const rawKey = candidate.idempotencyKey ?? meta?.idempotencyKey;
  let idempotencyKey: string | null = null;
  if (rawKey !== undefined && rawKey !== null) {
    if (typeof rawKey !== 'string' || !rawKey.trim()) {
      return { ok: false, error: 'tools/call `idempotencyKey` must be a non-empty string when provided' };
    }
    idempotencyKey = rawKey.trim();
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
      idempotencyKey,
    },
  };
}

/**
 * Stable JSON serialization with sorted object keys, so two argument objects
 * that differ only by key order hash to the same idempotency key.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function deriveMcpIdempotencyKey(input: {
  toolName: string;
  args: Record<string, unknown>;
  agentId: AgentId;
  roomId: string;
}): string {
  const hash = createHash('sha256')
    .update(canonicalJson({ tool: input.toolName, args: input.args }))
    .digest('hex')
    .slice(0, 24);
  return `mcp:${input.agentId}:${input.roomId}:${hash}`;
}

/**
 * Translate an engine outcome into an MCP-spec-compliant `tools/call` result.
 *
 * Per https://modelcontextprotocol.io/specification/2025-06-18/server/tools §
 * "Tool Result" and "Error Handling": tool *execution* failures are reported
 * inside the result envelope with `isError: true`, not as JSON-RPC errors.
 * Only protocol-level failures (unknown method, invalid request, unknown tool
 * from the caller's perspective) become JSON-RPC errors. So every engine
 * outcome — applied, duplicate, rejected, denied, timeout, etc. — flows back
 * through the success channel here, with `isError` flipped for non-success
 * terminal states. Fireside-specific fields (`callId`, `status`, `result`,
 * `duplicateOfCallId`, `error`) ride along in `structuredContent` so native
 * callers can still read them.
 */
function outcomeToJsonRpc(
  id: JsonRpcSuccessResponse['id'],
  outcome: ExecuteToolCallOutcome,
): JsonRpcResponse {
  const isError = outcome.status !== 'applied' && outcome.status !== 'duplicate';
  const text = isError
    ? (outcome.error || outcome.summary || outcome.status)
    : (outcome.summary ?? outcome.status);
  const structuredContent: Record<string, unknown> = {
    callId: outcome.callId,
    toolName: outcome.toolName,
    status: outcome.status,
    summary: outcome.summary ?? null,
    duplicateOfCallId: outcome.duplicateOfCallId ?? null,
    result: outcome.result ?? null,
  };
  if (outcome.error) structuredContent.error = outcome.error;
  return successResponse(id, {
    content: [{ type: 'text', text }],
    isError,
    structuredContent,
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
