import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';
import type { PermissionCapability, PermissionMode, PermissionTargetKind } from '../permissions.js';

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'empty' | 'permission-requested';
export type AgentRunLifecycleState =
  | 'start'
  | 'preparing_workspace'
  | 'building_prompt'
  | 'launching_agent_process'
  | 'initializing_session'
  | 'streaming_turn'
  | 'finishing'
  | 'stalled'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'canceled_by_reconciliation'
  | 'retry_queued'
  | 'released';

export interface AgentRun {
  id: string;
  roomId: string;
  taskId: string | null;
  triggerMessageId: string;
  replyMessageId: string | null;
  agentId: AgentId;
  status: AgentRunStatus;
  permissionMode: PermissionMode | 'plan';
  promptChars: number;
  estimatedPromptTokens: number;
  liveMessages: number;
  contextArtifacts: number;
  startedAt: number;
  completedAt: number | null;
  error: string;
  promptText?: string;
  stdout: string;
  stderr: string;
  replyText: string;
  cliSessionId: string | null;
  permissionSource: string;
  permissionTarget: string;
  permissionReason: string;
  permissionFilesystemScope: string;
  permissionWeb: boolean;
  permissionCapabilities: PermissionCapability[];
  permissionTargetExists: boolean | null;
  permissionTargetKind: PermissionTargetKind;
  permissionTargetResolvedPath: string;
  permissionTargetCheckedAt: number;
  permissionProviderProfile: string;
  lifecycleState: AgentRunLifecycleState;
  lifecycleReason: string;
  lifecycleUpdatedAt: number;
  lastSignalAt: number;
  attempt: number;
  continuationTurn: number;
  maxTurns: number;
  workspacePath: string;
  retryOfRunId: string;
  retryAfter: number;
}

export type AgentRunSummary = Omit<
  AgentRun,
  | 'promptText'
  | 'stdout'
  | 'stderr'
  | 'replyText'
  | 'permissionReason'
>;

interface AgentRunRow {
  id: string;
  room_id: string;
  task_id: string | null;
  trigger_message_id: string;
  reply_message_id: string | null;
  agent_id: AgentId;
  status: AgentRunStatus;
  permission_mode: PermissionMode | 'plan';
  prompt_chars: number;
  estimated_prompt_tokens: number;
  live_messages: number;
  context_artifacts: number;
  started_at: number;
  completed_at: number | null;
  error: string;
  prompt_text: string;
  stdout: string;
  stderr: string;
  reply_text: string;
  cli_session_id: string | null;
  permission_source: string;
  permission_target: string;
  permission_reason: string;
  permission_filesystem_scope: string;
  permission_web: number;
  permission_capabilities_json: string;
  permission_target_exists: number | null;
  permission_target_kind: PermissionTargetKind;
  permission_target_resolved_path: string;
  permission_target_checked_at: number;
  permission_provider_profile: string;
  lifecycle_state: AgentRunLifecycleState;
  lifecycle_reason: string;
  lifecycle_updated_at: number;
  last_signal_at: number;
  attempt: number;
  continuation_turn: number;
  max_turns: number;
  workspace_path: string;
  retry_of_run_id: string;
  retry_after: number;
}

export interface CreateAgentRunInput {
  roomId: string;
  taskId?: string | null;
  triggerMessageId: string;
  agentId: AgentId;
  permissionMode: PermissionMode | 'plan';
  promptChars: number;
  estimatedPromptTokens: number;
  liveMessages: number;
  contextArtifacts: number;
  promptText?: string;
  permissionSource?: string;
  permissionTarget?: string;
  permissionReason?: string;
  permissionFilesystemScope?: string;
  permissionWeb?: boolean;
  permissionCapabilities?: PermissionCapability[];
  permissionTargetExists?: boolean | null;
  permissionTargetKind?: PermissionTargetKind;
  permissionTargetResolvedPath?: string;
  permissionTargetCheckedAt?: number;
  permissionProviderProfile?: string;
  lifecycleState?: AgentRunLifecycleState;
  lifecycleReason?: string;
  lifecycleUpdatedAt?: number;
  lastSignalAt?: number;
  attempt?: number;
  continuationTurn?: number;
  maxTurns?: number;
  workspacePath?: string;
  retryOfRunId?: string;
  retryAfter?: number;
}

export interface UpdateAgentRunInput {
  status?: AgentRunStatus;
  replyMessageId?: string | null;
  completedAt?: number | null;
  error?: string;
  stdout?: string;
  stderr?: string;
  replyText?: string;
  cliSessionId?: string | null;
  lifecycleState?: AgentRunLifecycleState;
  lifecycleReason?: string;
  lifecycleUpdatedAt?: number;
  lastSignalAt?: number;
  attempt?: number;
  continuationTurn?: number;
  maxTurns?: number;
  workspacePath?: string;
  retryOfRunId?: string;
  retryAfter?: number;
}

const MAX_STORED_TEXT_CHARS = 200_000;

function boundedText(text: string, maxChars = MAX_STORED_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${omitted} chars omitted from stored run diagnostics ...]`;
}

function parseCapabilities(json: string): PermissionCapability[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PermissionCapability => typeof item === 'string');
  } catch {
    return [];
  }
}

function rowToAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    roomId: row.room_id,
    taskId: row.task_id,
    triggerMessageId: row.trigger_message_id,
    replyMessageId: row.reply_message_id,
    agentId: row.agent_id,
    status: row.status,
    permissionMode: row.permission_mode,
    promptChars: row.prompt_chars,
    estimatedPromptTokens: row.estimated_prompt_tokens,
    liveMessages: row.live_messages,
    contextArtifacts: row.context_artifacts,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    promptText: row.prompt_text,
    stdout: row.stdout,
    stderr: row.stderr,
    replyText: row.reply_text,
    cliSessionId: row.cli_session_id,
    permissionSource: row.permission_source,
    permissionTarget: row.permission_target,
    permissionReason: row.permission_reason,
    permissionFilesystemScope: row.permission_filesystem_scope,
    permissionWeb: row.permission_web === 1,
    permissionCapabilities: parseCapabilities(row.permission_capabilities_json),
    permissionTargetExists:
      row.permission_target_exists === null ? null : row.permission_target_exists === 1,
    permissionTargetKind: row.permission_target_kind || 'unknown',
    permissionTargetResolvedPath: row.permission_target_resolved_path || '',
    permissionTargetCheckedAt: row.permission_target_checked_at || 0,
    permissionProviderProfile: row.permission_provider_profile || '',
    lifecycleState: row.lifecycle_state || 'launching_agent_process',
    lifecycleReason: row.lifecycle_reason || '',
    lifecycleUpdatedAt: row.lifecycle_updated_at || 0,
    lastSignalAt: row.last_signal_at || 0,
    attempt: row.attempt || 1,
    continuationTurn: row.continuation_turn || 1,
    maxTurns: row.max_turns || 1,
    workspacePath: row.workspace_path || '',
    retryOfRunId: row.retry_of_run_id || '',
    retryAfter: row.retry_after || 0,
  };
}

function toAgentRunSummary(run: AgentRun): AgentRunSummary {
  return {
    id: run.id,
    roomId: run.roomId,
    taskId: run.taskId,
    triggerMessageId: run.triggerMessageId,
    replyMessageId: run.replyMessageId,
    agentId: run.agentId,
    status: run.status,
    permissionMode: run.permissionMode,
    promptChars: run.promptChars,
    estimatedPromptTokens: run.estimatedPromptTokens,
    liveMessages: run.liveMessages,
    contextArtifacts: run.contextArtifacts,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.error,
    cliSessionId: run.cliSessionId,
    permissionSource: run.permissionSource,
    permissionTarget: run.permissionTarget,
    permissionFilesystemScope: run.permissionFilesystemScope,
    permissionWeb: run.permissionWeb,
    permissionCapabilities: run.permissionCapabilities,
    permissionTargetExists: run.permissionTargetExists,
    permissionTargetKind: run.permissionTargetKind,
    permissionTargetResolvedPath: run.permissionTargetResolvedPath,
    permissionTargetCheckedAt: run.permissionTargetCheckedAt,
    permissionProviderProfile: run.permissionProviderProfile,
    lifecycleState: run.lifecycleState,
    lifecycleReason: run.lifecycleReason,
    lifecycleUpdatedAt: run.lifecycleUpdatedAt,
    lastSignalAt: run.lastSignalAt,
    attempt: run.attempt,
    continuationTurn: run.continuationTurn,
    maxTurns: run.maxTurns,
    workspacePath: run.workspacePath,
    retryOfRunId: run.retryOfRunId,
    retryAfter: run.retryAfter,
  };
}

export function createAgentRun(db: Database, input: CreateAgentRunInput): AgentRunSummary {
  const id = nanoid(16);
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_runs (
      id, room_id, task_id, trigger_message_id, reply_message_id, agent_id, status, permission_mode,
      prompt_chars, estimated_prompt_tokens, live_messages, context_artifacts, started_at, completed_at, error,
      prompt_text, stdout, stderr, reply_text, cli_session_id, permission_source, permission_target,
      permission_reason, permission_filesystem_scope, permission_web, permission_capabilities_json,
      permission_target_exists, permission_target_kind, permission_target_resolved_path,
      permission_target_checked_at, permission_provider_profile, lifecycle_state, lifecycle_reason,
      lifecycle_updated_at, last_signal_at, attempt, continuation_turn, max_turns, workspace_path,
      retry_of_run_id, retry_after
    ) VALUES (?, ?, ?, ?, NULL, ?, 'running', ?, ?, ?, ?, ?, ?, NULL, '', ?, '', '', '', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.roomId,
    input.taskId ?? null,
    input.triggerMessageId,
    input.agentId,
    input.permissionMode,
    input.promptChars,
    input.estimatedPromptTokens,
    input.liveMessages,
    input.contextArtifacts,
    now,
    boundedText(input.promptText ?? ''),
    input.permissionSource ?? '',
    input.permissionTarget ?? '',
    input.permissionReason ?? '',
    input.permissionFilesystemScope ?? '',
    input.permissionWeb === true ? 1 : 0,
    JSON.stringify(input.permissionCapabilities ?? []),
    input.permissionTargetExists === undefined || input.permissionTargetExists === null
      ? null
      : input.permissionTargetExists
        ? 1
        : 0,
    input.permissionTargetKind ?? 'unknown',
    input.permissionTargetResolvedPath ?? '',
    input.permissionTargetCheckedAt ?? 0,
    input.permissionProviderProfile ?? '',
    input.lifecycleState ?? 'launching_agent_process',
    input.lifecycleReason ?? '',
    input.lifecycleUpdatedAt ?? now,
    input.lastSignalAt ?? 0,
    input.attempt ?? 1,
    input.continuationTurn ?? 1,
    input.maxTurns ?? 1,
    input.workspacePath ?? '',
    input.retryOfRunId ?? '',
    input.retryAfter ?? 0,
  );
  return toAgentRunSummary(getAgentRun(db, id)!);
}

export function getAgentRun(db: Database, id: string): AgentRun | null {
  const row = db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as
    | AgentRunRow
    | undefined;
  return row ? rowToAgentRun(row) : null;
}

export function listAgentRuns(
  db: Database,
  roomId: string,
  opts: { limit?: number } = {},
): AgentRunSummary[] {
  const limit = opts.limit ?? 30;
  const rows = db
    .prepare(
      `SELECT * FROM agent_runs WHERE room_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
    )
    .all(roomId, limit) as AgentRunRow[];
  return rows.map(rowToAgentRun).map(toAgentRunSummary);
}

export function listAllAgentRunsForRoom(db: Database, roomId: string): AgentRun[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_runs WHERE room_id = ? ORDER BY started_at ASC, id ASC`,
    )
    .all(roomId) as AgentRunRow[];
  return rows.map(rowToAgentRun);
}

export function listRecentAgentRunsForTask(
  db: Database,
  roomId: string,
  taskId: string | null,
  limit = 8,
): AgentRunSummary[] {
  const rows = taskId
    ? (db
        .prepare(
          `SELECT * FROM agent_runs WHERE room_id = ? AND task_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .all(roomId, taskId, limit) as AgentRunRow[])
    : (db
        .prepare(`SELECT * FROM agent_runs WHERE room_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`)
        .all(roomId, limit) as AgentRunRow[]);
  return rows.map(rowToAgentRun).map(toAgentRunSummary);
}

export function listRunningAgentRuns(db: Database): AgentRunSummary[] {
  const rows = db
    .prepare(`SELECT * FROM agent_runs WHERE status = 'running' ORDER BY started_at ASC, id ASC`)
    .all() as AgentRunRow[];
  return rows.map(rowToAgentRun).map(toAgentRunSummary);
}

export function listRunningAgentRunsForRoom(
  db: Database,
  roomId: string,
): AgentRunSummary[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_runs WHERE room_id = ? AND status = 'running' ORDER BY started_at ASC, id ASC`,
    )
    .all(roomId) as AgentRunRow[];
  return rows.map(rowToAgentRun).map(toAgentRunSummary);
}

export function recoverInterruptedAgentRuns(db: Database, now = Date.now()): AgentRunSummary[] {
  const running = listRunningAgentRuns(db);
  return running
    .map((run) =>
      updateAgentRun(db, run.id, {
        status: 'failed',
        completedAt: now,
        error: 'Interrupted by Fireside server restart before the provider turn completed.',
        lifecycleState: 'canceled_by_reconciliation',
        lifecycleReason: 'Fireside restarted before the provider turn completed.',
      }),
    )
    .filter((run): run is AgentRunSummary => run !== null);
}

export function updateAgentRun(
  db: Database,
  id: string,
  input: UpdateAgentRunInput,
): AgentRunSummary | null {
  const existing = getAgentRun(db, id);
  if (!existing) return null;

  const updated = {
    status: input.status ?? existing.status,
    replyMessageId:
      'replyMessageId' in input ? input.replyMessageId ?? null : existing.replyMessageId,
    completedAt:
      'completedAt' in input ? input.completedAt ?? null : existing.completedAt,
    error: input.error ?? existing.error,
    stdout: input.stdout !== undefined ? boundedText(input.stdout) : existing.stdout,
    stderr: input.stderr !== undefined ? boundedText(input.stderr) : existing.stderr,
    replyText: input.replyText !== undefined ? boundedText(input.replyText) : existing.replyText,
    cliSessionId:
      'cliSessionId' in input ? input.cliSessionId ?? null : existing.cliSessionId,
    lifecycleState: input.lifecycleState ?? existing.lifecycleState,
    lifecycleReason: input.lifecycleReason ?? existing.lifecycleReason,
    lifecycleUpdatedAt:
      input.lifecycleUpdatedAt ?? (input.lifecycleState ? Date.now() : existing.lifecycleUpdatedAt),
    lastSignalAt: input.lastSignalAt ?? existing.lastSignalAt,
    attempt: input.attempt ?? existing.attempt,
    continuationTurn: input.continuationTurn ?? existing.continuationTurn,
    maxTurns: input.maxTurns ?? existing.maxTurns,
    workspacePath: input.workspacePath ?? existing.workspacePath,
    retryOfRunId: input.retryOfRunId ?? existing.retryOfRunId,
    retryAfter: input.retryAfter ?? existing.retryAfter,
  };

  db.prepare(
    `UPDATE agent_runs
     SET status = ?, reply_message_id = ?, completed_at = ?, error = ?,
         stdout = ?, stderr = ?, reply_text = ?, cli_session_id = ?,
         lifecycle_state = ?, lifecycle_reason = ?, lifecycle_updated_at = ?, last_signal_at = ?,
         attempt = ?, continuation_turn = ?, max_turns = ?, workspace_path = ?,
         retry_of_run_id = ?, retry_after = ?
     WHERE id = ?`,
  ).run(
    updated.status,
    updated.replyMessageId,
    updated.completedAt,
    updated.error,
    updated.stdout,
    updated.stderr,
    updated.replyText,
    updated.cliSessionId,
    updated.lifecycleState,
    updated.lifecycleReason,
    updated.lifecycleUpdatedAt,
    updated.lastSignalAt,
    updated.attempt,
    updated.continuationTurn,
    updated.maxTurns,
    updated.workspacePath,
    updated.retryOfRunId,
    updated.retryAfter,
    id,
  );
  const run = getAgentRun(db, id);
  return run ? toAgentRunSummary(run) : null;
}
