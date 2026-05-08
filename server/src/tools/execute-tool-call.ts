// server/src/tools/execute-tool-call.ts
//
// Nine-stage tool-call pipeline (see docs/agent-tool-layer-spec.md
// §"Tool Execution Is A Pipeline"):
//
//   1. Decode               (caller produces an AgentToolCall)
//   2. Authenticate actor   (call.agentId non-empty)
//   3. Validate schema      (registry tool's schema.parse)
//   4. Normalize references (folded into schema.parse)
//   5. Check permissions    (authorizeToolCall)
//   6. Check idempotency    (lookupPriorCall by (room, mission, key))
//   7. Apply state change   (handler invoked with validated args)
//   8. Record audit event   (single row in agent_tool_calls)
//   9. Emit effects         (returned to caller via outcome)
//
// The pipeline owns the order. Handlers stay narrow: validate + mutate.

import type { Database } from 'better-sqlite3';
import type { PermissionGrant } from '../permissions.js';
import { lookupPriorCall, recordCall } from './idempotency.js';
import { authorizeToolCall } from './permissions/authorize-tool-call.js';
import type { StatePermission } from './permissions/state-permissions.js';
import {
  defaultToolRegistry,
  type ToolRegistry,
} from './registry.js';
import type {
  AgentToolCall,
  AgentToolCallStatus,
  AgentToolResult,
  ExecuteToolCallOutcome,
} from './types.js';

export interface ExecuteToolCallInput {
  call: AgentToolCall;
  db: Database;
  registry?: ToolRegistry;
  /** Filesystem permission grant (yolo/edit/plan) used to derive state perms. */
  permission?: PermissionGrant | null;
  /** Explicit state permissions (overrides/augments the grant-derived set). */
  statePermissions?: readonly StatePermission[];
  /** Durable audit label for how state permissions were resolved. */
  permissionResolutionSource?: string;
  /** Optional id of the agent the call is targeting (for agent.* coord checks). */
  targetAgentId?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * Execute a single decoded tool call end-to-end. The function never throws on
 * domain failures (unknown tool, validation error, permission denial,
 * duplicate, handler failure). It throws only for genuinely exceptional DB
 * failures the caller cannot meaningfully recover from.
 */
export async function executeToolCall(
  input: ExecuteToolCallInput,
): Promise<ExecuteToolCallOutcome> {
  const { call, db } = input;
  const registry = input.registry ?? defaultToolRegistry;
  const now = input.now ?? Date.now;

  // 2. Authenticate actor
  if (!call.agentId || call.agentId.trim() === '') {
    return persistTerminal({
      db,
      call,
      status: 'rejected',
      summary: 'rejected: missing agent id',
      error: 'agent id required',
      now: now(),
    });
  }

  // 6a. Idempotency pre-check (before inserting). Done before validation so
  //     a duplicate key short-circuits without any handler work, regardless
  //     of whether args match the prior call's args.
  const prior = lookupPriorCall(db, call.idempotencyKey, call.missionId, call.roomId);
  if (prior) {
    const duplicate = recordDuplicateCall({
      db,
      call,
      priorCallId: prior.id,
      priorToolName: prior.tool_name,
      now: now(),
    });
    return {
      callId: duplicate.id,
      toolName: prior.tool_name,
      status: 'duplicate',
      summary: `duplicate: idempotency key ${call.idempotencyKey} already applied`,
      duplicateOfCallId: prior.id,
    };
  }

  // 3. Schema validation requires a registered tool first.
  const tool = registry.get(call.tool);
  if (!tool) {
    return persistTerminal({
      db,
      call,
      status: 'rejected',
      summary: `rejected: unknown tool ${call.tool}`,
      error: `unknown tool: ${call.tool}`,
      now: now(),
    });
  }

  // 3 + 4. Validate schema and normalize references in one step.
  let normalizedArgs: Record<string, unknown>;
  try {
    const parsed = tool.schema.parse(call.args);
    normalizedArgs = (parsed ?? {}) as Record<string, unknown>;
  } catch (err) {
    return persistTerminal({
      db,
      call,
      status: 'rejected',
      summary: `rejected: schema validation failed for ${call.tool}`,
      error: errorMessage(err),
      now: now(),
    });
  }

  // 5. Permission check
  const targetAgentId =
    input.targetAgentId ?? (call.tool === 'agent.set_status' ? stringArg(normalizedArgs, 'agentId') : undefined);
  const auth = authorizeToolCall({
    toolName: call.tool,
    agentId: call.agentId,
    requiredPermissions: tool.requiredPermissions,
    permission: input.permission ?? null,
    ...(targetAgentId !== undefined ? { targetAgentId } : {}),
    ...(input.statePermissions !== undefined ? { statePermissions: input.statePermissions } : {}),
  });
  if (!auth.ok) {
    return persistTerminal({
      db,
      call,
      status: 'permission_denied',
      summary: `permission denied: ${call.tool}`,
      error: auth.reason,
      normalizedArgs,
      authorization: {
        resolutionSource: permissionResolutionSource(input),
        required: auth.required,
        granted: auth.granted,
      },
      now: now(),
    });
  }

  // 7. Apply state change
  let result: AgentToolResult;
  try {
    result = await tool.handler({ call, args: normalizedArgs, db, now: now() });
  } catch (err) {
    return persistTerminal({
      db,
      call,
      status: 'failed',
      summary: `failed: handler threw for ${call.tool}`,
      error: errorMessage(err),
      normalizedArgs,
      now: now(),
    });
  }

  // 8. Record audit event with the handler's terminal status.
  return persistTerminal({
    db,
    call,
    status: handlerStatusToAuditStatus(result.status),
    summary: result.summary,
    result,
    normalizedArgs,
    authorization: {
      resolutionSource: permissionResolutionSource(input),
      required: auth.required,
      granted: auth.granted,
    },
    now: now(),
  });
}

interface PersistTerminalInput {
  db: Database;
  call: AgentToolCall;
  status: AgentToolCallStatus;
  summary: string;
  error?: string;
  result?: AgentToolResult;
  normalizedArgs?: Record<string, unknown>;
  authorization?: AuthorizationAuditMetadata;
  now: number;
}

function persistTerminal(input: PersistTerminalInput): ExecuteToolCallOutcome {
  // The unique index on (room_id, mission_id, idempotency_key) means a racing
  // duplicate attempt will throw at insert. Treat that as a duplicate too so
  // concurrent retries collapse cleanly instead of surfacing a 500.
  try {
    const row = recordCall(input.db, {
      id: input.call.id,
      roomId: input.call.roomId,
      missionId: input.call.missionId,
      runId: input.call.runId,
      messageId: input.call.messageId,
      agentId: input.call.agentId,
      toolName: input.call.tool,
      idempotencyKey: input.call.idempotencyKey,
      source: input.call.source,
      status: input.status,
      args: input.call.args,
      normalizedArgs: input.normalizedArgs ?? input.call.args,
      now: input.now,
      ...(input.result !== undefined || input.authorization !== undefined
        ? { result: auditResult(input.result, input.authorization) }
        : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    });
    return {
      callId: row.id,
      toolName: input.call.tool,
      status: input.status,
      summary: input.summary,
      ...(input.result ? { result: input.result } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const prior = lookupPriorCall(
        input.db,
        input.call.idempotencyKey,
        input.call.missionId,
        input.call.roomId,
      );
      if (prior) {
        const duplicate = recordDuplicateCall({
          db: input.db,
          call: input.call,
          priorCallId: prior.id,
          priorToolName: prior.tool_name,
          now: input.now,
        });
        return {
          callId: duplicate.id,
          toolName: prior.tool_name,
          status: 'duplicate',
          summary: `duplicate: idempotency key ${input.call.idempotencyKey} already applied`,
          duplicateOfCallId: prior.id,
        };
      }
    }
    throw err;
  }
}

interface AuthorizationAuditMetadata {
  resolutionSource: string;
  required: StatePermission[];
  granted: StatePermission[];
}

function auditResult(
  result: AgentToolResult | undefined,
  authorization: AuthorizationAuditMetadata | undefined,
): AgentToolResult | { authorization: AuthorizationAuditMetadata } {
  if (!authorization) return result as AgentToolResult;
  return {
    ...(result ?? {}),
    authorization,
  };
}

function permissionResolutionSource(input: ExecuteToolCallInput): string {
  if (input.permissionResolutionSource) return input.permissionResolutionSource;
  if (input.permission) return `grant:${input.permission.source}:${input.permission.mode}`;
  if (input.statePermissions !== undefined) return 'state-permissions';
  return 'default';
}

function recordDuplicateCall(input: {
  db: Database;
  call: AgentToolCall;
  priorCallId: string;
  priorToolName: string;
  now: number;
}) {
  return recordCall(input.db, {
    roomId: input.call.roomId,
    missionId: input.call.missionId,
    runId: input.call.runId,
    messageId: input.call.messageId,
    agentId: input.call.agentId,
    toolName: input.call.tool,
    idempotencyKey: input.call.idempotencyKey,
    source: input.call.source,
    status: 'duplicate',
    args: input.call.args,
    normalizedArgs: input.call.args,
    result: {
      status: 'duplicate',
      summary: `duplicate of ${input.priorToolName} call ${input.priorCallId}`,
      effects: [],
    },
    now: input.now,
  });
}

function handlerStatusToAuditStatus(
  status: AgentToolResult['status'],
): AgentToolCallStatus {
  switch (status) {
    case 'applied':
      return 'applied';
    case 'rejected':
      return 'rejected';
    case 'duplicate':
      return 'duplicate';
    case 'permission_pending':
      return 'permission_pending';
    case 'failed':
      return 'failed';
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /UNIQUE constraint failed/i.test(err.message);
}
