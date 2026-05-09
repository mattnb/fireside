// server/src/agents/types.ts
import type { PermissionGrant } from '../permissions.js';
import type { AgentContextUsage } from '../context-usage.js';

export type ProviderId = 'claude' | 'codex' | 'gemini' | 'echo';
export type AgentId = string;

/**
 * Per-turn provider session lifecycle:
 *
 * - `persistent`     keep the resumed CLI session across turns indefinitely.
 *                    Cheapest live prompt; pays the full provider amplifier.
 * - `compacting`     keep the resumed session, run /compact when the
 *                    context-usage threshold is crossed.
 * - `ephemeral`      always start a fresh provider session; no resume.
 *                    Highest live prompt cost but no provider-side accumulation.
 * - `reset-after-lane` resume within a checklist lane, then drop the session
 *                    once the agent marks that lane done.
 */
export type SessionPolicy = 'persistent' | 'compacting' | 'ephemeral' | 'reset-after-lane';

export interface AgentPersona {
  id: string;
  name: string;
  category: string;
  summary: string;
  prompt: string;
}

export interface RoomAgentProfile {
  id: AgentId;
  providerId: ProviderId;
  displayName: string;
  personaId: string;
  personaName: string;
  personaSummary: string;
  modelId?: string;
  reasoningEffort?: string;
  autoCompactEnabled?: boolean;
  autoCompactPercent?: number;
  sessionPolicy?: SessionPolicy;
  temporary?: boolean;
  spawnedBy?: AgentId;
  spawnedByPersonaId?: string;
  spawnedAt?: number;
  spawnedReason?: string;
  spawnedScope?: string;
  dismissWhen?: string;
  maxTurns?: number;
  status?: AgentRuntimeStatus;
  statusReason?: string;
  statusUpdatedAt?: number;
  statusUntil?: string;
  currentTaskId?: string;
}

export type AgentRuntimeStatus = 'idle' | 'active' | 'blocked' | 'offline';

export type AgentTurnKind =
  | 'chat'
  | 'permission-operation'
  | 'work-lane'
  | 'workflow-repair'
  | 'maintenance-compaction';

/** Turn kinds that are mechanical bookkeeping rather than reasoning work.
 *  These are eligible for the cheap-model routing in provider adapters
 *  (e.g. Haiku 4.5 for the Claude provider). */
export const MECHANICAL_TURN_KINDS: ReadonlySet<AgentTurnKind> = new Set([
  'workflow-repair',
  'maintenance-compaction',
]);

export function isMechanicalTurnKind(kind: AgentTurnKind | undefined): boolean {
  return kind !== undefined && MECHANICAL_TURN_KINDS.has(kind);
}

export interface AgentRunContext {
  permission?: PermissionGrant;
  turnKind?: AgentTurnKind;
  model?: AgentModelSettings;
  roomId?: string;
}

export interface AgentModelSettings {
  modelId?: string;
  reasoningEffort?: string;
}

export type AgentStreamName = 'stdout' | 'stderr';
export type AgentStreamEventKind = 'event' | 'message' | 'tool' | 'usage' | 'stderr';
export type AgentStreamEventStatus = 'info' | 'running' | 'completed' | 'failed';

export interface AgentStreamEvent {
  kind: AgentStreamEventKind;
  status: AgentStreamEventStatus;
  label: string;
  detail?: string;
  contextUsage?: AgentContextUsage;
}

export interface AgentSpec {
  id: AgentId;
  displayName: string;
  command: string; // e.g. 'claude'
  /** Builds CLI argv for one turn. Receives the prior session id (if any). */
  buildArgs(prompt: string, sessionId: string | null, context?: AgentRunContext): string[];
  /** Optional pre-formatted text written to stdin. If undefined, the prompt
   *  goes via the CLI's argv (per the CLI's contract). */
  buildStdin?: (prompt: string, sessionId: string | null, context?: AgentRunContext) => string;
  /** Optional per-turn environment overrides merged into the subprocess env. */
  buildEnv?: (
    prompt: string,
    sessionId: string | null,
    context?: AgentRunContext,
  ) => Record<string, string>;
  /** Converts live stdout/stderr lines into provider-neutral progress events. */
  parseStreamLine?: (
    line: string,
    stream: AgentStreamName,
    sessionId?: string | null,
  ) => AgentStreamEvent[];
  /** Parses the stdout (and optionally stderr) into a reply. */
  parseOutput(stdout: string, stderr: string): AgentReply;
  /** Default per-turn timeout in ms. */
  defaultTimeoutMs: number;
  /** Optional default working directory for this agent's subprocess.
   *  Used by runners when the caller does not pass an explicit `cwd`.
   *  Agents that need a fresh workspace per invocation should prefer
   *  `buildCwd` instead. Other agents inherit the broker's cwd by leaving
   *  both unset. */
  defaultCwd?: string;
  /** Optional per-turn working directory builder. Caller-supplied cwd still
   *  wins. This is useful for CLIs that inspect or mutate their cwd and need
   *  a fresh empty workspace for every invocation. */
  buildCwd?: (prompt: string, sessionId: string | null, context?: AgentRunContext) => string;
}

export interface AgentReply {
  text: string;
  sessionId: string | null;
  raw: { stdout: string; stderr: string };
}

export class AgentParseError extends Error {
  constructor(
    public agentId: AgentId,
    message: string,
    public stdout: string,
    public stderr: string,
  ) {
    super(`[${agentId}] ${message}`);
    this.name = 'AgentParseError';
  }
}
