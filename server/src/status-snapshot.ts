import type { Database } from 'better-sqlite3';
import type { AgentId } from './agents/types.js';
import type { AgentContextUsage } from './context-usage.js';
import { listAllAgentRunsForRoom, type AgentRun, type AgentRunStatus } from './repos/agent-runs.js';
import { listActiveAgentJobsForRoom, type AgentJob } from './repos/agent-jobs.js';
import {
  listAgentRunActionsForRoom,
  type AgentRunAction,
  type AgentRunActionKind,
  type AgentRunActionStatus,
} from './repos/run-actions.js';
import { getRoom, listRooms, type Room } from './repos/rooms.js';
import { listTasks, type Task, type TaskStatus } from './repos/tasks.js';
import { listTaskChecklistItems, type TaskChecklistItem } from './repos/task-checklist.js';

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

export type StatusSnapshotAgentWorkflowState =
  | 'working'
  | 'stale'
  | 'waiting_on_human'
  | 'waiting_on_agent'
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

function addRunCount(counts: StatusSnapshotRunCounts, run: AgentRun): void {
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

function toRunSummary(run: AgentRun): StatusSnapshotRun {
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

function buildContextUsage(actions: StatusSnapshotRunAction[]): StatusSnapshotContextUsage {
  const withUsage = actions.filter((action) => action.contextUsage).sort(compareActionsDesc);
  const latestAction = withUsage[0];
  const latest = latestAction ? contextUsageEntry(latestAction) : null;
  const byAgent = new Map<AgentId, StatusSnapshotAgentContextUsage>();
  for (const action of withUsage) {
    if (byAgent.has(action.agentId)) continue;
    const entry = contextUsageEntry(action);
    if (entry) byAgent.set(action.agentId, entry);
  }
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

    const assignedItems = input.checklistItems
      .filter((item) => activeTaskIds.has(item.taskId) && item.ownerAgentId === agentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.updatedAt - b.updatedAt);
    const blockedItem = assignedItems.find((item) => item.status === 'blocked');
    if (blockedItem) {
      return {
        agentId,
        state: blockedItem.councilRequired ? 'waiting_on_human' : 'blocked',
        label: blockedItem.councilRequired ? 'waiting' : 'blocked',
        detail:
          blockedItem.blockedReason ||
          `${blockedItem.title} is blocked${blockedItem.councilRequired ? ' and needs council' : ''}.`,
        severity: blockedItem.councilRequired ? 'warn' : 'danger',
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
  const taskCounts = zeroTaskCounts();
  const runCounts = zeroRunCounts();
  const actionCounts = zeroRunActionCounts();
  const activeTasks: StatusSnapshotTask[] = [];
  const allRuns: StatusSnapshotRun[] = [];
  const allActions: StatusSnapshotRunAction[] = [];
  const allAgentStates: StatusSnapshotAgentState[] = [];

  const roomSnapshots = rooms.map((room) => {
    for (const agent of room.agents) agents.add(agent);

    const roomTaskCounts = zeroTaskCounts();
    const roomRunCounts = zeroRunCounts();
    const roomActionCounts = zeroRunActionCounts();
    const roomTasks = listTasks(input.db, room.id);
    const roomRuns = listAllAgentRunsForRoom(input.db, room.id);
    const roomActions = listAgentRunActionsForRoom(input.db, room.id);
    const roomActiveJobs = listActiveAgentJobsForRoom(input.db, room.id);

    const roomActiveTasks = roomTasks
      .filter((task) => ACTIVE_TASK_STATUSES.has(task.status))
      .map(toTaskSummary);
    const roomRunSummaries = roomRuns.map((run) => {
      addRunCount(roomRunCounts, run);
      return toRunSummary(run);
    });
    const roomActionSummaries = roomActions.map((action) => {
      addRunActionCount(roomActionCounts, action);
      return toRunActionSummary(action);
    });

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
      createdAt: room.createdAt,
      counts,
      activeMissions: roomActiveTasks,
      activeTasks: roomActiveTasks,
      lastRun: roomSortedRuns[0] ?? null,
      lastAction: roomSortedActions[0] ?? null,
      contextUsage: buildContextUsage(roomActionSummaries),
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
    contextUsage: buildContextUsage(allActions),
    agentStates: allAgentStates,
  };
}
