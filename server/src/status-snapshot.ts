import type { Database } from 'better-sqlite3';
import type { AgentId, RoomAgentProfile } from './agents/types.js';
import type { AgentContextUsage } from './context-usage.js';
import {
  listAllAgentRunSummariesForRoom,
  type AgentRun,
  type AgentRunStatus,
  type AgentRunSummary,
} from './repos/agent-runs.js';
import { listActiveAgentJobSummariesForRoom, type AgentJob } from './repos/agent-jobs.js';
import {
  listAgentRunActionAggregatesForRoom,
  listRecentAgentRunActions,
  listRecentContextUsageActionsForRoom,
  type AgentRunAction,
  type AgentRunActionAggregate,
  type AgentRunActionKind,
  type AgentRunActionStatus,
} from './repos/run-actions.js';
import { getRoom, listRooms, type Room } from './repos/rooms.js';
import { listTasks, type Task, type TaskStatus } from './repos/tasks.js';
import { listTaskChecklistItems, type TaskChecklistItem } from './repos/task-checklist.js';
import {
  formatProviderCapacityBlock,
  latestProviderCapacityBlock,
} from './provider-capacity.js';

const TASK_STATUSES = [
  'active',
  'paused',
  'blocked',
  'verifying',
  'done',
] as const satisfies readonly TaskStatus[];
const ACTIVE_TASK_STATUSES = new Set<TaskStatus>(['active', 'blocked', 'verifying']);
const RUN_STATUSES = [
  'running',
  'completed',
  'failed',
  'empty',
  'permission-requested',
] as const satisfies readonly AgentRunStatus[];
const ACTION_STATUSES = [
  'info',
  'running',
  'completed',
  'failed',
] as const satisfies readonly AgentRunActionStatus[];
const ACTION_KINDS = [
  'prompt',
  'run',
  'permission',
  'adapter',
  'diagnostic',
  'message',
  'error',
  'ledger',
] as const satisfies readonly AgentRunActionKind[];

const DEFAULT_RECENT_LIMIT = 10;
const STALE_RUN_MS = 5 * 60 * 1000;

export interface BuildStatusSnapshotInput {
  db: Database;
  roomId?: string;
  recentLimit?: number;
}

export interface StatusSnapshotTaskCounts {
  total: number;
  active: number;
  paused: number;
  blocked: number;
  verifying: number;
  done: number;
  activeLike: number;
  byStatus: Record<TaskStatus, number>;
}

export interface StatusSnapshotRunCounts {
  total: number;
  running: number;
  retrying: number;
  completed: number;
  failed: number;
  empty: number;
  permissionRequested: number;
  byStatus: Record<AgentRunStatus, number>;
}

export interface StatusSnapshotRunActionCounts {
  total: number;
  info: number;
  running: number;
  completed: number;
  failed: number;
  withContextUsage: number;
  byStatus: Record<AgentRunActionStatus, number>;
  byKind: Record<AgentRunActionKind, number>;
}

export interface StatusSnapshotCounts {
  rooms: number;
  agents: number;
  activeMissions: number;
  tasks: StatusSnapshotTaskCounts;
  runs: StatusSnapshotRunCounts;
  runActions: StatusSnapshotRunActionCounts;
}

export interface StatusSnapshotRoomCounts {
  agents: number;
  activeMissions: number;
  tasks: StatusSnapshotTaskCounts;
  runs: StatusSnapshotRunCounts;
  runActions: StatusSnapshotRunActionCounts;
}

export interface StatusSnapshotTask {
  id: string;
  roomId: string;
  title: string;
  goal: string;
  repoPath: string;
  acceptanceCriteria: string;
  agents: AgentId[];
  status: TaskStatus;
  capabilityProfile: Task['capabilityProfile'];
  summary: string;
  createdAt: number;
  updatedAt: number;
}

export interface StatusSnapshotRun {
  id: string;
  agentJobId: string;
  roomId: string;
  taskId: string | null;
  triggerMessageId: string;
  replyMessageId: string | null;
  agentId: AgentId;
  status: AgentRunStatus;
  permissionMode: AgentRun['permissionMode'];
  promptChars: number;
  estimatedPromptTokens: number;
  liveMessages: number;
  contextArtifacts: number;
  startedAt: number;
  completedAt: number | null;
  error: string;
  cliSessionId: string | null;
  lifecycleState: AgentRun['lifecycleState'];
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

export interface StatusSnapshotRunAction {
  id: string;
  roomId: string;
  taskId: string | null;
  runId: string;
  agentId: AgentId;
  kind: AgentRunActionKind;
  status: AgentRunActionStatus;
  label: string;
  detail: string;
  contextUsage: AgentContextUsage | null;
  createdAt: number;
}

export interface StatusSnapshotAgentContextUsage {
  agentId: AgentId;
  actionId: string;
  runId: string;
  createdAt: number;
  usage: AgentContextUsage;
}

export interface StatusSnapshotContextUsage {
  latest: StatusSnapshotAgentContextUsage | null;
  byAgent: StatusSnapshotAgentContextUsage[];
}

interface ContextUsageBuildOptions {
  agentIds?: AgentId[];
  agentProviderById?: Map<AgentId, string>;
}

interface SharedProviderQuota {
  providerId: string;
  actionId: string;
  runId: string;
  createdAt: number;
  quota: NonNullable<AgentContextUsage['quota']>;
}

type AgentQuotaWindow = NonNullable<NonNullable<AgentContextUsage['quota']>['fiveHour']>;

export type StatusSnapshotAgentWorkflowState =
  | 'working'
  | 'stale'
  | 'waiting_on_human'
  | 'waiting_on_agent'
  | 'incapacitated'
  | 'blocked'
  | 'idle_ready'
  | 'idle';

export interface StatusSnapshotAgentState {
  agentId: AgentId;
  state: StatusSnapshotAgentWorkflowState;
  label: string;
  detail: string;
  severity: 'good' | 'info' | 'warn' | 'danger' | 'muted';
  since: number;
  runId: string | null;
  taskId: string | null;
  checklistItemId: string | null;
}

export interface StatusSnapshotRoom {
  id: string;
  projectId: string;
  name: string;
  agents: AgentId[];
  yoloAgents: AgentId[];
  leadAgentId: AgentId | null;
  agentProfiles: RoomAgentProfile[];
  createdAt: number;
  counts: StatusSnapshotRoomCounts;
  activeMissions: StatusSnapshotTask[];
  activeTasks: StatusSnapshotTask[];
  lastRun: StatusSnapshotRun | null;
  lastAction: StatusSnapshotRunAction | null;
  contextUsage: StatusSnapshotContextUsage;
  agentStates: StatusSnapshotAgentState[];
}

export interface StatusSnapshot {
  version: 1;
  generatedAt: number;
  scope: {
    roomId: string | null;
  };
  counts: StatusSnapshotCounts;
  rooms: StatusSnapshotRoom[];
  activeMissions: StatusSnapshotTask[];
  activeTasks: StatusSnapshotTask[];
  runs: {
    last: StatusSnapshotRun | null;
    running: StatusSnapshotRun[];
    retrying: StatusSnapshotRun[];
    completed: StatusSnapshotRun[];
  };
  runActions: {
    last: StatusSnapshotRunAction | null;
    recent: StatusSnapshotRunAction[];
    summary: StatusSnapshotRunActionCounts;
  };
  contextUsage: StatusSnapshotContextUsage;
  agentStates: StatusSnapshotAgentState[];
}

function zeroTaskCounts(): StatusSnapshotTaskCounts {
  return {
    total: 0,
    active: 0,
    paused: 0,
    blocked: 0,
    verifying: 0,
    done: 0,
    activeLike: 0,
    byStatus: { active: 0, paused: 0, blocked: 0, verifying: 0, done: 0 },
  };
}

function zeroRunCounts(): StatusSnapshotRunCounts {
  return {
    total: 0,
    running: 0,
    retrying: 0,
    completed: 0,
    failed: 0,
    empty: 0,
    permissionRequested: 0,
    byStatus: {
      running: 0,
      completed: 0,
      failed: 0,
      empty: 0,
      'permission-requested': 0,
    },
  };
}

function zeroRunActionCounts(): StatusSnapshotRunActionCounts {
  return {
    total: 0,
    info: 0,
    running: 0,
    completed: 0,
    failed: 0,
    withContextUsage: 0,
    byStatus: { info: 0, running: 0, completed: 0, failed: 0 },
    byKind: {
      prompt: 0,
      run: 0,
      permission: 0,
      adapter: 0,
      diagnostic: 0,
      message: 0,
      error: 0,
      ledger: 0,
    },
  };
}

function addTaskCount(counts: StatusSnapshotTaskCounts, task: Task): void {
  counts.total += 1;
  counts[task.status] += 1;
  counts.byStatus[task.status] += 1;
  if (ACTIVE_TASK_STATUSES.has(task.status)) counts.activeLike += 1;
}

function addRunCount(counts: StatusSnapshotRunCounts, run: AgentRunSummary): void {
  counts.total += 1;
  counts.byStatus[run.status] += 1;
  if (run.lifecycleState === 'retry_queued') {
    counts.retrying += 1;
  }
  switch (run.status) {
    case 'running':
      counts.running += 1;
      break;
    case 'completed':
      counts.completed += 1;
      break;
    case 'failed':
      counts.failed += 1;
      break;
    case 'empty':
      counts.empty += 1;
      break;
    case 'permission-requested':
      counts.permissionRequested += 1;
      break;
  }
}

function addRunActionCount(counts: StatusSnapshotRunActionCounts, action: AgentRunAction): void {
  counts.total += 1;
  counts[action.status] += 1;
  counts.byStatus[action.status] += 1;
  counts.byKind[action.kind] += 1;
  if (action.contextUsage) counts.withContextUsage += 1;
}

function addRunActionAggregate(
  counts: StatusSnapshotRunActionCounts,
  aggregate: AgentRunActionAggregate,
): void {
  counts.total += aggregate.count;
  counts[aggregate.status] += aggregate.count;
  counts.byStatus[aggregate.status] += aggregate.count;
  counts.byKind[aggregate.kind] += aggregate.count;
  counts.withContextUsage += aggregate.withContextUsage;
}

function mergeTaskCounts(target: StatusSnapshotTaskCounts, source: StatusSnapshotTaskCounts): void {
  target.total += source.total;
  target.active += source.active;
  target.paused += source.paused;
  target.blocked += source.blocked;
  target.verifying += source.verifying;
  target.done += source.done;
  target.activeLike += source.activeLike;
  for (const status of TASK_STATUSES) {
    target.byStatus[status] += source.byStatus[status];
  }
}

function mergeRunCounts(target: StatusSnapshotRunCounts, source: StatusSnapshotRunCounts): void {
  target.total += source.total;
  target.running += source.running;
  target.retrying += source.retrying;
  target.completed += source.completed;
  target.failed += source.failed;
  target.empty += source.empty;
  target.permissionRequested += source.permissionRequested;
  for (const status of RUN_STATUSES) {
    target.byStatus[status] += source.byStatus[status];
  }
}

function mergeRunActionCounts(
  target: StatusSnapshotRunActionCounts,
  source: StatusSnapshotRunActionCounts,
): void {
  target.total += source.total;
  target.info += source.info;
  target.running += source.running;
  target.completed += source.completed;
  target.failed += source.failed;
  target.withContextUsage += source.withContextUsage;
  for (const status of ACTION_STATUSES) {
    target.byStatus[status] += source.byStatus[status];
  }
  for (const kind of ACTION_KINDS) {
    target.byKind[kind] += source.byKind[kind];
  }
}

function toTaskSummary(task: Task): StatusSnapshotTask {
  return {
    id: task.id,
    roomId: task.roomId,
    title: task.title,
    goal: task.goal,
    repoPath: task.repoPath,
    acceptanceCriteria: task.acceptanceCriteria,
    agents: task.agents,
    status: task.status,
    capabilityProfile: task.capabilityProfile,
    summary: task.summary,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function toRunSummary(run: AgentRunSummary): StatusSnapshotRun {
  return {
    id: run.id,
    agentJobId: run.agentJobId,
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

function toRunActionSummary(action: AgentRunAction): StatusSnapshotRunAction {
  return {
    id: action.id,
    roomId: action.roomId,
    taskId: action.taskId,
    runId: action.runId,
    agentId: action.agentId,
    kind: action.kind,
    status: action.status,
    label: action.label,
    detail: action.detail,
    contextUsage: action.contextUsage ?? null,
    createdAt: action.createdAt,
  };
}

function runSortTime(run: StatusSnapshotRun): number {
  return run.completedAt ?? run.startedAt;
}

function compareRunsDesc(a: StatusSnapshotRun, b: StatusSnapshotRun): number {
  const timeDiff = runSortTime(b) - runSortTime(a);
  return timeDiff !== 0 ? timeDiff : b.id.localeCompare(a.id);
}

function compareActionsDesc(a: StatusSnapshotRunAction, b: StatusSnapshotRunAction): number {
  const timeDiff = b.createdAt - a.createdAt;
  return timeDiff !== 0 ? timeDiff : b.id.localeCompare(a.id);
}

function mergedActionSummaries(actions: AgentRunAction[]): StatusSnapshotRunAction[] {
  const byId = new Map<string, StatusSnapshotRunAction>();
  for (const action of actions) {
    byId.set(action.id, toRunActionSummary(action));
  }
  return Array.from(byId.values()).sort(compareActionsDesc);
}

function latestForAgent<T extends { agentId: AgentId }>(values: T[], agentId: AgentId): T | null {
  return values.find((value) => value.agentId === agentId) ?? null;
}

function contextUsageEntry(
  action: StatusSnapshotRunAction,
): StatusSnapshotAgentContextUsage | null {
  if (!action.contextUsage) return null;
  return {
    agentId: action.agentId,
    actionId: action.id,
    runId: action.runId,
    createdAt: action.createdAt,
    usage: action.contextUsage,
  };
}

function fallbackProviderId(agentId: AgentId): string {
  if (agentId === 'claude' || agentId.startsWith('claude-')) return 'claude';
  if (agentId === 'codex' || agentId.startsWith('codex-')) return 'codex';
  if (agentId === 'gemini' || agentId.startsWith('gemini-')) return 'gemini';
  return agentId;
}

function providerIdForAgent(
  agentId: AgentId,
  agentProviderById: Map<AgentId, string> | undefined,
): string {
  return agentProviderById?.get(agentId) ?? fallbackProviderId(agentId);
}

function providerIdForRoomAgent(room: Room, agentId: AgentId): string {
  return (
    room.agentProfiles.find((profile) => profile.id === agentId)?.providerId ??
    fallbackProviderId(agentId)
  );
}

function mergeQuotaWindow(
  existing: AgentQuotaWindow | undefined,
  incoming: AgentQuotaWindow | undefined,
  preferIncoming: boolean,
): AgentQuotaWindow | undefined {
  if (!incoming) return existing;
  if (!existing) return incoming;
  return preferIncoming ? { ...existing, ...incoming } : { ...incoming, ...existing };
}

function mergeQuota(
  existing: AgentContextUsage['quota'] | undefined,
  incoming: AgentContextUsage['quota'] | undefined,
  preferIncoming: boolean,
): AgentContextUsage['quota'] | undefined {
  if (!incoming) return existing;
  if (!existing) return incoming;
  const merged = preferIncoming
    ? { ...existing, ...incoming, source: incoming.source }
    : { ...incoming, ...existing, source: existing.source };
  const fiveHour = mergeQuotaWindow(existing.fiveHour, incoming.fiveHour, preferIncoming);
  const sevenDay = mergeQuotaWindow(existing.sevenDay, incoming.sevenDay, preferIncoming);
  const daily = mergeQuotaWindow(existing.daily, incoming.daily, preferIncoming);
  if (fiveHour) merged.fiveHour = fiveHour;
  if (sevenDay) merged.sevenDay = sevenDay;
  if (daily) merged.daily = daily;
  return merged;
}

function mergeQuotaUsage(
  usage: AgentContextUsage,
  quota: AgentContextUsage['quota'] | undefined,
  preferIncoming: boolean,
): AgentContextUsage {
  if (!quota) return usage;
  const mergedQuota = mergeQuota(usage.quota, quota, preferIncoming);
  if (!mergedQuota) return usage;
  return {
    ...usage,
    quota: mergedQuota,
  };
}

function buildSharedProviderQuotas(
  actions: StatusSnapshotRunAction[],
  options: ContextUsageBuildOptions,
): Map<string, SharedProviderQuota> {
  const byProvider = new Map<string, SharedProviderQuota>();
  for (const action of actions) {
    const quota = action.contextUsage?.quota;
    if (!quota) continue;
    const providerId = providerIdForAgent(action.agentId, options.agentProviderById);
    if (providerId !== 'claude' && providerId !== 'gemini') continue;
    const existing = byProvider.get(providerId);
    if (!existing) {
      byProvider.set(providerId, {
        providerId,
        actionId: action.id,
        runId: action.runId,
        createdAt: action.createdAt,
        quota,
      });
      continue;
    }
    existing.quota = mergeQuota(existing.quota, quota, false) ?? existing.quota;
  }
  return byProvider;
}

function applySharedProviderQuotas(
  byAgent: Map<AgentId, StatusSnapshotAgentContextUsage>,
  sharedQuotas: Map<string, SharedProviderQuota>,
  options: ContextUsageBuildOptions,
): void {
  for (const agentId of options.agentIds ?? []) {
    const providerId = providerIdForAgent(agentId, options.agentProviderById);
    const shared = sharedQuotas.get(providerId);
    if (!shared) continue;
    const existing = byAgent.get(agentId);
    if (existing) {
      existing.usage = mergeQuotaUsage(existing.usage, shared.quota, true);
      continue;
    }
    byAgent.set(agentId, {
      agentId,
      actionId: shared.actionId,
      runId: shared.runId,
      createdAt: shared.createdAt,
      usage: {
        provider: providerId,
        model: providerId,
        usedTokens: 0,
        quota: shared.quota,
        quotaOnly: true,
        source: shared.quota.source,
      },
    });
  }
}

function buildContextUsage(
  actions: StatusSnapshotRunAction[],
  options: ContextUsageBuildOptions = {},
): StatusSnapshotContextUsage {
  const withUsage = actions.filter((action) => action.contextUsage).sort(compareActionsDesc);
  const latestAction = withUsage[0];
  const latest = latestAction ? contextUsageEntry(latestAction) : null;
  const byAgent = new Map<AgentId, StatusSnapshotAgentContextUsage>();
  for (const action of withUsage) {
    const entry = contextUsageEntry(action);
    if (!entry) continue;
    const existing = byAgent.get(action.agentId);
    if (!existing) {
      byAgent.set(action.agentId, entry);
      continue;
    }

    if (existing.usage.quotaOnly && !entry.usage.quotaOnly) {
      byAgent.set(action.agentId, {
        ...entry,
        usage: mergeQuotaUsage(entry.usage, existing.usage.quota, true),
      });
      continue;
    }

    if (entry.usage.quota) {
      existing.usage = mergeQuotaUsage(existing.usage, entry.usage.quota, false);
    }
  }
  applySharedProviderQuotas(byAgent, buildSharedProviderQuotas(withUsage, options), options);
  return { latest, byAgent: Array.from(byAgent.values()) };
}

function checklistItemsForTasks(db: Database, tasks: Task[]): TaskChecklistItem[] {
  return tasks.flatMap((task) => listTaskChecklistItems(db, task.id));
}

function dependenciesAreClosed(
  item: TaskChecklistItem,
  byId: Map<string, TaskChecklistItem>,
): boolean {
  if (item.dependencyIds.length === 0) return true;
  return item.dependencyIds.every((id) => {
    const dependency = byId.get(id);
    return dependency?.status === 'done' || dependency?.status === 'skipped';
  });
}

function buildAgentStates(input: {
  room: Room;
  activeTasks: Task[];
  runs: StatusSnapshotRun[];
  actions: StatusSnapshotRunAction[];
  activeJobs: AgentJob[];
  checklistItems: TaskChecklistItem[];
  agentProviderById: Map<AgentId, string>;
  now: number;
}): StatusSnapshotAgentState[] {
  const runsDesc = [...input.runs].sort(compareRunsDesc);
  const actionsDesc = [...input.actions].sort(compareActionsDesc);
  const checklistById = new Map(input.checklistItems.map((item) => [item.id, item]));
  const activeTaskIds = new Set(input.activeTasks.map((task) => task.id));
  const activeMissionAgents = new Set(input.activeTasks.flatMap((task) => task.agents));

  return input.room.agents.map((agentId) => {
    const runningRun = input.runs
      .filter((run) => run.agentId === agentId && run.status === 'running')
      .sort(compareRunsDesc)[0];
    if (runningRun) {
      const lastActivityAt =
        runningRun.lastSignalAt || runningRun.lifecycleUpdatedAt || runningRun.startedAt;
      const stale = input.now - lastActivityAt >= STALE_RUN_MS;
      return {
        agentId,
        state: stale ? 'stale' : 'working',
        label: stale ? 'stale' : 'working',
        detail: stale
          ? `No provider signal for ${Math.round((input.now - lastActivityAt) / 1000)}s.`
          : runningRun.lifecycleReason || 'Provider run is active.',
        severity: stale ? 'warn' : 'good',
        since: runningRun.startedAt,
        runId: runningRun.id,
        taskId: runningRun.taskId,
        checklistItemId: null,
      };
    }

    const activeJob = input.activeJobs.find((job) => job.agentId === agentId);
    if (activeJob) {
      return {
        agentId,
        state: 'working',
        label: activeJob.status === 'queued' ? 'queued' : 'working',
        detail: `Agent job is ${activeJob.status}.`,
        severity: 'good',
        since: activeJob.createdAt,
        runId: activeJob.runId,
        taskId: activeJob.taskId,
        checklistItemId: activeJob.checklistItemId,
      };
    }

    const latestRun = latestForAgent(runsDesc, agentId);
    if (latestRun?.status === 'permission-requested') {
      return {
        agentId,
        state: 'waiting_on_human',
        label: 'waiting',
        detail: latestRun.lifecycleReason || 'Waiting for a human permission decision.',
        severity: 'warn',
        since: latestRun.completedAt ?? latestRun.startedAt,
        runId: latestRun.id,
        taskId: latestRun.taskId,
        checklistItemId: null,
      };
    }

    const providerId = input.agentProviderById.get(agentId);
    const capacityBlock = providerId
      ? latestProviderCapacityBlock(actionsDesc, providerId, input.now)
      : null;
    if (capacityBlock) {
      return {
        agentId,
        state: 'incapacitated',
        label: 'quota limited',
        detail: formatProviderCapacityBlock(capacityBlock, input.now),
        severity: 'danger',
        since: capacityBlock.createdAt,
        runId: latestRun?.id ?? null,
        taskId: latestRun?.taskId ?? input.activeTasks[0]?.id ?? null,
        checklistItemId: null,
      };
    }

    const assignedItems = input.checklistItems
      .filter((item) => activeTaskIds.has(item.taskId) && item.ownerAgentId === agentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.updatedAt - b.updatedAt);
    const blockedItem = assignedItems.find((item) => item.status === 'blocked');
    if (blockedItem) {
      const needsHuman = blockedItem.councilRequired;
      return {
        agentId,
        state: needsHuman ? 'waiting_on_human' : 'blocked',
        label: needsHuman ? 'waiting' : 'has blocker',
        detail:
          blockedItem.blockedReason ||
          `${blockedItem.title} is blocked${needsHuman ? ' and needs council' : ''}.`,
        severity: 'warn',
        since: blockedItem.updatedAt,
        runId: latestRun?.id ?? null,
        taskId: blockedItem.taskId,
        checklistItemId: blockedItem.id,
      };
    }

    const openItem = assignedItems.find((item) => item.status === 'open');
    if (openItem) {
      const ready = dependenciesAreClosed(openItem, checklistById);
      return {
        agentId,
        state: ready ? 'idle_ready' : 'waiting_on_agent',
        label: ready ? 'ready' : 'waiting',
        detail: ready
          ? `Ready to pick up ${openItem.title}.`
          : `Waiting for dependencies before ${openItem.title}.`,
        severity: ready ? 'info' : 'warn',
        since: openItem.updatedAt,
        runId: latestRun?.id ?? null,
        taskId: openItem.taskId,
        checklistItemId: openItem.id,
      };
    }

    const latestAction = latestForAgent(actionsDesc, agentId);
    if (activeMissionAgents.has(agentId)) {
      return {
        agentId,
        state: 'idle_ready',
        label: input.room.yoloAgents.includes(agentId) ? 'yolo ready' : 'available',
        detail: 'Active mission has no assigned open lane for this agent.',
        severity: 'info',
        since: latestRun?.completedAt ?? latestAction?.createdAt ?? input.now,
        runId: latestRun?.id ?? null,
        taskId: input.activeTasks[0]?.id ?? null,
        checklistItemId: null,
      };
    }

    return {
      agentId,
      state: 'idle',
      label: input.room.yoloAgents.includes(agentId) ? 'yolo' : 'idle',
      detail: latestRun ? `Last run: ${latestRun.status}.` : 'No active work.',
      severity: 'muted',
      since: latestRun?.completedAt ?? latestAction?.createdAt ?? input.now,
      runId: latestRun?.id ?? null,
      taskId: latestRun?.taskId ?? null,
      checklistItemId: null,
    };
  });
}

function selectedRooms(db: Database, roomId: string | undefined): Room[] {
  if (roomId) {
    const room = getRoom(db, roomId);
    return room ? [room] : [];
  }
  return listRooms(db);
}

function boundedRecentLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RECENT_LIMIT;
  if (!Number.isFinite(value)) return DEFAULT_RECENT_LIMIT;
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

export function buildStatusSnapshot(input: BuildStatusSnapshotInput): StatusSnapshot {
  const rooms = selectedRooms(input.db, input.roomId);
  const recentLimit = boundedRecentLimit(input.recentLimit);
  const now = Date.now();
  const agents = new Set<AgentId>();
  const agentProviderById = new Map<AgentId, string>();
  const taskCounts = zeroTaskCounts();
  const runCounts = zeroRunCounts();
  const actionCounts = zeroRunActionCounts();
  const activeTasks: StatusSnapshotTask[] = [];
  const allRuns: StatusSnapshotRun[] = [];
  const allActions: StatusSnapshotRunAction[] = [];
  const allAgentStates: StatusSnapshotAgentState[] = [];

  const roomSnapshots = rooms.map((room) => {
    const roomAgentProviderById = new Map<AgentId, string>();
    for (const agent of room.agents) {
      agents.add(agent);
      const providerId = providerIdForRoomAgent(room, agent);
      agentProviderById.set(agent, providerId);
      roomAgentProviderById.set(agent, providerId);
    }

    const roomTaskCounts = zeroTaskCounts();
    const roomRunCounts = zeroRunCounts();
    const roomActionCounts = zeroRunActionCounts();
    const roomTasks = listTasks(input.db, room.id);
    const roomRuns = listAllAgentRunSummariesForRoom(input.db, room.id);
    const roomRecentActions = listRecentAgentRunActions(input.db, room.id, Math.max(100, recentLimit));
    const roomContextActions = listRecentContextUsageActionsForRoom(input.db, room.id);
    const roomActionAggregates = listAgentRunActionAggregatesForRoom(input.db, room.id);
    const roomActiveJobs = listActiveAgentJobSummariesForRoom(input.db, room.id);

    const roomActiveTasks = roomTasks
      .filter((task) => ACTIVE_TASK_STATUSES.has(task.status))
      .map(toTaskSummary);
    const roomRunSummaries = roomRuns.map((run) => {
      addRunCount(roomRunCounts, run);
      return toRunSummary(run);
    });
    const roomActionSummaries = mergedActionSummaries([
      ...roomRecentActions,
      ...roomContextActions,
    ]);
    for (const aggregate of roomActionAggregates) addRunActionAggregate(roomActionCounts, aggregate);

    for (const task of roomTasks) addTaskCount(roomTaskCounts, task);
    mergeTaskCounts(taskCounts, roomTaskCounts);
    mergeRunCounts(runCounts, roomRunCounts);
    mergeRunActionCounts(actionCounts, roomActionCounts);
    activeTasks.push(...roomActiveTasks);
    allRuns.push(...roomRunSummaries);
    allActions.push(...roomActionSummaries);

    const roomSortedRuns = [...roomRunSummaries].sort(compareRunsDesc);
    const roomSortedActions = [...roomActionSummaries].sort(compareActionsDesc);
    const activeTaskRecords = roomTasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
    const roomAgentStates = buildAgentStates({
      room,
      activeTasks: activeTaskRecords,
      runs: roomRunSummaries,
      actions: roomActionSummaries,
      activeJobs: roomActiveJobs,
      checklistItems: checklistItemsForTasks(input.db, activeTaskRecords),
      agentProviderById: roomAgentProviderById,
      now,
    });
    allAgentStates.push(...roomAgentStates);
    const counts: StatusSnapshotRoomCounts = {
      agents: room.agents.length,
      activeMissions: roomTaskCounts.activeLike,
      tasks: roomTaskCounts,
      runs: roomRunCounts,
      runActions: roomActionCounts,
    };

    return {
      id: room.id,
      projectId: room.projectId,
      name: room.name,
      agents: room.agents,
      yoloAgents: room.yoloAgents,
      leadAgentId: room.leadAgentId,
      agentProfiles: room.agentProfiles,
      createdAt: room.createdAt,
      counts,
      activeMissions: roomActiveTasks,
      activeTasks: roomActiveTasks,
      lastRun: roomSortedRuns[0] ?? null,
      lastAction: roomSortedActions[0] ?? null,
      contextUsage: buildContextUsage(roomActionSummaries, {
        agentIds: room.agents,
        agentProviderById: roomAgentProviderById,
      }),
      agentStates: roomAgentStates,
    } satisfies StatusSnapshotRoom;
  });

  const sortedRuns = [...allRuns].sort(compareRunsDesc);
  const sortedActions = [...allActions].sort(compareActionsDesc);
  const completedRuns = sortedRuns
    .filter((run) => run.status === 'completed')
    .slice(0, recentLimit);
  const runningRuns = sortedRuns.filter((run) => run.status === 'running');
  const retryingRuns = sortedRuns.filter((run) => run.lifecycleState === 'retry_queued');
  const counts: StatusSnapshotCounts = {
    rooms: roomSnapshots.length,
    agents: agents.size,
    activeMissions: taskCounts.activeLike,
    tasks: taskCounts,
    runs: runCounts,
    runActions: actionCounts,
  };

  return {
    version: 1,
    generatedAt: Date.now(),
    scope: { roomId: input.roomId ?? null },
    counts,
    rooms: roomSnapshots,
    activeMissions: activeTasks,
    activeTasks,
    runs: {
      last: sortedRuns[0] ?? null,
      running: runningRuns,
      retrying: retryingRuns,
      completed: completedRuns,
    },
    runActions: {
      last: sortedActions[0] ?? null,
      recent: sortedActions.slice(0, recentLimit),
      summary: actionCounts,
    },
    contextUsage: buildContextUsage(allActions, {
      agentIds: Array.from(agents),
      agentProviderById,
    }),
    agentStates: allAgentStates,
  };
}
