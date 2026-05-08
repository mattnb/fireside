// server/src/tools/types.ts
//
// Shared contracts for the structured agent tool layer. See
// docs/agent-tool-layer-spec.md for the full design.

import type { Database } from 'better-sqlite3';
import type { AgentId } from '../agents/types.js';

/**
 * State permissions enforced at tool boundaries. These are distinct from
 * filesystem capabilities (read, edit-existing, run-command, etc.) which
 * gate provider-side actions.
 */
export type StatePermission =
  | 'mission:read'
  | 'mission:write'
  | 'mission:admin'
  | 'collab:write'
  | 'agent:write-self'
  | 'agent:coordinate'
  | 'permission:request'
  | 'search:read';

/** Where a tool call originated. */
export type AgentToolSource =
  | 'hidden-command'
  | 'provider-tool-call'
  | 'mcp'
  | 'system'
  | 'replay';

/**
 * Lifecycle state for an audit row in `agent_tool_calls`. The pipeline
 * advances a call through these as it traverses the nine stages.
 */
export type AgentToolCallStatus =
  | 'decoded'
  | 'validated'
  | 'applied'
  | 'rejected'
  | 'duplicate'
  | 'permission_pending'
  | 'permission_denied'
  | 'failed';

/** Terminal status returned by a handler (subset of AgentToolCallStatus). */
export type AgentToolHandlerStatus =
  | 'applied'
  | 'rejected'
  | 'duplicate'
  | 'permission_pending'
  | 'failed';

/** Effect emitted by a handler that the broker/UI should react to. */
export interface AgentToolEffect {
  kind:
    | 'mission-updated'
    | 'task-updated'
    | 'phase-updated'
    | 'plan-updated'
    | 'permission-requested'
    | 'agent-dispatch-requested'
    | 'activity-created';
  targetType?: string;
  targetId?: string;
  summary: string;
  payload?: unknown;
}

/** Result returned by a handler. */
export interface AgentToolResult {
  status: AgentToolHandlerStatus;
  summary: string;
  data?: unknown;
  effects: AgentToolEffect[];
}

/**
 * A decoded structured agent action. The args are unvalidated at this stage;
 * the registry's schema is responsible for validating and narrowing the type.
 */
export interface AgentToolCall {
  /** Stable id for this call (audit row id, generated at decode time). */
  id: string;
  /** Tool namespace + name, e.g. `mission.task.update`. */
  tool: string;
  /** Idempotency key supplied by the caller. Required for retry safety. */
  idempotencyKey: string;
  /** Raw args as decoded from source; the schema narrows them. */
  args: Record<string, unknown>;
  /** Where this call came from (hidden block, MCP, etc.). */
  source: AgentToolSource;
  /** Routing context. */
  roomId: string;
  missionId: string | null;
  runId: string | null;
  messageId: string | null;
  agentId: AgentId;
  /** Wall clock at decode time; ms since epoch. */
  createdAt: number;
}

/**
 * Inputs handed to a tool handler. The pipeline normalizes args/permissions
 * before invoking the handler, so handlers operate on validated state.
 */
export interface AgentToolHandlerInput<TArgs = Record<string, unknown>> {
  call: AgentToolCall;
  args: TArgs;
  db: Database;
  /** Now in ms; injected so tests can pin time. */
  now: number;
}

/** A tool handler is the only stage that performs a state mutation. */
export type AgentToolHandler<TArgs = Record<string, unknown>> = (
  input: AgentToolHandlerInput<TArgs>,
) => Promise<AgentToolResult> | AgentToolResult;

/**
 * Schema validates and narrows raw args. Implementations may use Zod or
 * any other validator; the registry only cares about this contract so that
 * we are not coupled to a particular schema library.
 */
export interface AgentToolSchema<TArgs = Record<string, unknown>> {
  /** JSON Schema fragment suitable for provider/MCP discovery. */
  inputSchema?: Record<string, unknown>;
  parse(input: unknown): TArgs;
}

/**
 * Static description of a tool registered with the registry. The handler
 * receives args after schema validation and reference normalization.
 */
export interface AgentToolDefinition<TArgs = Record<string, unknown>> {
  /** Fully qualified name, e.g. `mission.task.update`. */
  name: string;
  /** One-line summary for prompt manifests and UI. */
  summary: string;
  /** State permissions required to invoke. The actor must hold all of them. */
  requiredPermissions: StatePermission[];
  /** Validates raw args. Throws on invalid input. */
  schema: AgentToolSchema<TArgs>;
  /** Performs the state mutation. */
  handler: AgentToolHandler<TArgs>;
}

/**
 * Final outcome of `executeToolCall`. Mirrors the audit row that was
 * persisted, so callers (broker, adapters, replay harness) can react
 * without re-reading the DB.
 */
export interface ExecuteToolCallOutcome {
  callId: string;
  toolName: string;
  status: AgentToolCallStatus;
  summary: string;
  result?: AgentToolResult;
  /** Populated when status is rejected/failed/permission_denied. */
  error?: string;
  /** Populated when status is duplicate; points at the prior applied call. */
  duplicateOfCallId?: string;
}
