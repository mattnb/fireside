// server/src/broker.ts
import { EventEmitter } from 'node:events';
import type { Database } from 'better-sqlite3';
import {
  addMessage,
  getMessage,
  listQueuedHumanMessages,
  listMessages,
  updateMessageDeliveryStatus,
  type Message,
  type AuthorKind,
  type MessageDeliveryStatus,
} from './repos/messages.js';
import {
  getRoom,
  deleteRoom as deleteRoomRepo,
  listRooms,
  setRoomAgents as setRoomAgentsRepo,
  type Room,
} from './repos/rooms.js';
import { getCliSessionId, upsertCliSessionId } from './repos/sessions.js';
import { buildTurnPromptResult, type WorkLanePromptItem } from './transcript.js';
import { parseAgentReferences } from './mentions.js';
import {
  listConversationArtifacts,
  messageTextForPrompt,
  writeConversationContextFiles,
  attachConversationFixture,
  removeConversationArtifact,
  type ConversationArtifactListing,
  type ConversationFixture,
} from './context-files.js';
import {
  isPermissionMode,
  isYoloFilesystemScope,
  buildPermissionGrant,
  extractPermissionRequest,
  type NormalizedYoloPermissionProfile,
  type PermissionGrant,
  type PermissionRequest,
  type YoloFilesystemScope,
  type YoloPermissionProfile,
} from './permissions.js';
import {
  addPermissionRequest,
  getPermissionRequest,
  resolvePermissionRequest as resolvePermissionRequestRepo,
} from './repos/permission-requests.js';
import {
  createTask as createTaskRepo,
  getActiveTask,
  getTask,
  listTasks as listTasksRepo,
  updateTask as updateTaskRepo,
  type CreateTaskInput,
  type Task,
  type UpdateTaskInput,
} from './repos/tasks.js';
import {
  createAgentRun,
  getAgentRun,
  listAllAgentRunsForRoom,
  listAgentRuns as listAgentRunsRepo,
  listRecentAgentRunsForTask,
  listRunningAgentRunsForRoom,
  recoverInterruptedAgentRuns,
  updateAgentRun,
  type AgentRun,
  type AgentRunLifecycleState,
  type AgentRunSummary,
} from './repos/agent-runs.js';
import {
  attachAgentJobRun,
  cancelAgentJob,
  completeAgentJob,
  createAgentJob,
  failAgentJob,
  leaseAgentJob,
  listActiveAgentJobsForRoom,
  recoverInterruptedAgentJobs,
  renewAgentJobLease,
  type AgentJob,
} from './repos/agent-jobs.js';
import {
  createCollaborationItem,
  listCollaborationItems as listCollaborationItemsRepo,
  type CollaborationItem,
} from './repos/collaboration.js';
import {
  createTaskPhase,
  getTaskPhase,
  listTaskPhases,
  updateTaskPhase,
  type CreateTaskPhaseInput,
  type TaskPhase,
  type UpdateTaskPhaseInput,
} from './repos/task-phases.js';
import {
  createTaskChecklistNote,
  createTaskChecklistItem,
  getTaskChecklistItem,
  listTaskChecklistItems,
  listTaskChecklistNotes,
  updateTaskChecklistItem,
  type CreateTaskChecklistItemInput,
  type TaskChecklistItem,
  type TaskChecklistNote,
  type UpdateTaskChecklistItemInput,
} from './repos/task-checklist.js';
import {
  createTaskPlan,
  getTaskPlan,
  listTaskPlans,
  updateTaskPlan,
  type CreateTaskPlanInput,
  type TaskPlan,
  type UpdateTaskPlanInput,
} from './repos/task-plans.js';
import {
  createAgentRunAction,
  listAgentRunActionsForRoom,
  listAgentRunActions,
  listRecentAgentRunActions,
  type AgentRunAction,
  type CreateAgentRunActionInput,
} from './repos/run-actions.js';
import {
  createMissionBriefing as createMissionBriefingRepo,
  getMissionBriefing,
  listMissionBriefings,
  type MissionBriefing,
  type MissionBriefingPayload,
  type MissionBriefingSummary,
} from './repos/briefings.js';
import { buildTaskPromptContext } from './task-summary.js';
import { decideRunRetry } from './run-lifecycle.js';
import { loadWorkflowProfile, type WorkflowProfile } from './workflow-profile.js';
import { getWorkspacePath } from './workspaces.js';
import type { AgentId, AgentReply, AgentSpec, AgentStreamEvent } from './agents/types.js';
import { logger } from './logger.js';
import { buildRunDiagnostics, type RunDiagnostics } from './run-diagnostics.js';
import { isVisibleProviderSignal, readableProviderSignalDetail } from './provider-signals.js';
import { codexContextUsage, formatContextUsage } from './context-usage.js';
import { extractCollaborationNotes, type ParsedCollaborationNote } from './collaboration-notes.js';
import { extractDraftArtifacts, writeDraftArtifact } from './draft-artifacts.js';
import { extractMissionTaskUpdates, type ParsedMissionTaskUpdate } from './mission-task-updates.js';
import {
  extractMissionPhaseUpdates,
  type ParsedMissionPhaseUpdate,
} from './mission-phase-updates.js';
import { extractMissionPlanUpdates, type ParsedMissionPlanUpdate } from './mission-plan-updates.js';
import {
  extractMissionCreateUpdates,
  type ParsedMissionCreateUpdate,
} from './mission-create-updates.js';
import { extractMissionReceipts, type ParsedMissionReceipt } from './mission-receipts.js';

export interface BrokerDeps {
  db: Database;
  runAgent: (
    spec: AgentSpec,
    prompt: string,
    sessionId: string | null,
    permission?: PermissionGrant,
    cancelSignal?: AbortSignal,
    onStreamEvent?: (event: AgentStreamEvent) => void,
    timeoutMs?: number | null,
  ) => Promise<AgentReply>;
  getSpec: (id: AgentId) => AgentSpec | undefined;
  maxHistory?: number;
  maxPromptChars?: number;
  largeMessageThresholdChars?: number;
  artifactExcerptChars?: number;
  maxRecapChars?: number;
  maxTranscriptChars?: number;
  maxAgentRepliesPerThread?: number;
  contextDir?: string;
  resumeCliSessions?: boolean;
}

const DEFAULT_MAX_AGENT_REPLIES_PER_THREAD = 5;
const YOLO_MAX_AGENT_REPLIES = 100;
const YOLO_PERMISSION_AUTO_APPROVAL_LIMIT = 3;
const DEFAULT_PROMPT_HISTORY = 16;
const DEFAULT_MAX_PROMPT_CHARS = 16_000;
const RUN_HEARTBEAT_MS = 10_000;
const RUN_STALL_AFTER_MS = 5 * 60 * 1000;
const RUN_SIGNAL_UPDATE_THROTTLE_MS = 2_500;
const STREAM_MESSAGE_THROTTLE_MS = 1_000;
const AGENT_JOB_LEASE_MS = 15 * 60 * 1000;
const COMPACT_PROMPT = '/compact';
const COMPACTABLE_AGENT_IDS = new Set<AgentId>(['claude', 'codex']);

interface DiscussionTurn {
  round: number;
  maxRounds: number;
  repliesUsed: number;
  maxRepliesPerAgent: number;
  mode?: 'normal' | 'yolo';
  totalRepliesUsed?: number;
  maxTotalReplies?: number;
}

interface WorkLaneAssignment {
  item: TaskChecklistItem;
}

interface WorkLaneScopeContract {
  itemId: string;
  title: string;
  agentId: AgentId | '';
  expectedTouches: string[];
  parallelism: TaskChecklistItem['parallelism'];
  conflictGroup: string;
  workRole: string;
  source: 'checklist' | 'active-job';
}

interface WorkflowProfilePromptItem {
  sourcePath: string;
  promptTemplate: string;
  maxTurns: number;
  maxConcurrentAgents: number;
}

export type AgentCompactionResult =
  | { ok: true; run: AgentRunSummary }
  | { ok: false; statusCode: number; error: string };

interface DiscussionThreadOptions {
  mode?: 'normal' | 'yolo';
  maxRepliesPerAgent?: number;
  maxTotalReplies?: number;
  permission?: PermissionGrant;
  yoloState?: YoloDiscussionState;
  responders?: AgentId[];
}

type PermissionDecision = 'approved' | 'denied';
type YoloCancelReason = 'manual' | 'human-interjection' | 'replacement';

interface YoloDiscussionState {
  id: string;
  roomId: string;
  startedBy: string;
  startedAt: number;
  maxTotalReplies: number;
  totalRepliesUsed: number;
  abortController: AbortController;
  cancelled: boolean;
  cancelledBy?: string;
  cancelledAt?: number;
  cancelReason?: YoloCancelReason;
}

export interface YoloStatus {
  roomId: string;
  active: boolean;
  id?: string;
  startedBy?: string;
  startedAt?: number;
  maxTotalReplies?: number;
  totalRepliesUsed?: number;
  remainingReplies?: number;
  cancelled?: boolean;
  cancelledBy?: string;
  stoppedAt?: number;
  reason?: string;
}

export interface MessageDeliveryUpdate {
  roomId: string;
  messageId: string;
  deliveryStatus: MessageDeliveryStatus;
  deliveredAt?: number;
}

export interface AgentRunDetail {
  run: AgentRun;
  triggerMessage: Message | null;
  replyMessage: Message | null;
  diagnostics: RunDiagnostics;
  actions: AgentRunAction[];
}

interface AgentTurnResult {
  message: Message | null;
  progressed: boolean;
  runId?: string;
}

interface MissionReconciliationResult {
  applied: number;
  receiptUpdates: number;
  laneUpdates: number;
}

export interface TaskControl {
  task: Task;
  phases: TaskPhase[];
  checklistItems: TaskChecklistItem[];
  checklistNotes: TaskChecklistNote[];
  plans: TaskPlan[];
  currentPhase: TaskPhase | null;
  openChecklistItems: TaskChecklistItem[];
  blockedChecklistItems: TaskChecklistItem[];
  activePlan: TaskPlan | null;
}

function cleanYoloTarget(target: unknown): string | undefined {
  if (typeof target !== 'string') return undefined;
  const trimmed = target.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : undefined;
}

function normalizeYoloPermissionProfile(
  profile?: YoloPermissionProfile,
): NormalizedYoloPermissionProfile {
  const rawScope = typeof profile?.filesystemScope === 'string' ? profile.filesystemScope : '';
  const filesystemScope = isYoloFilesystemScope(rawScope) ? rawScope : 'task';
  const rawMode = typeof profile?.mode === 'string' ? profile.mode : '';
  const mode =
    filesystemScope === 'unrestricted' ? 'full-auto' : isPermissionMode(rawMode) ? rawMode : 'edit';
  const target = cleanYoloTarget(profile?.target);
  return {
    mode,
    filesystemScope,
    ...(target !== undefined ? { target } : {}),
    web: profile?.web === true,
  };
}

function inferYoloPermissionProfileFromText(text: string): YoloPermissionProfile | null {
  const normalized = text.toLowerCase();
  if (!/\byolo\b/.test(normalized)) return null;
  if (
    !/\byolo\s+mode\b|\byolo\s+run\b|\byolo\s+collaboration\b|\bunrestricted\s+yolo\b/.test(
      normalized,
    )
  ) {
    return null;
  }
  if (/\b(no|not|never|don't|do not)\b.{0,32}\byolo\b/.test(normalized)) return null;

  const filesystemScope: YoloFilesystemScope = /\bunrestricted\b/.test(normalized)
    ? 'unrestricted'
    : /\bfireside\s+cwd\b|\bcwd\b/.test(normalized)
      ? 'cwd'
      : 'task';
  const mode =
    filesystemScope === 'unrestricted' ||
    /\bfull[-\s]?auto\b|\bskip permissions\b|\bdangerously\b/.test(normalized)
      ? 'full-auto'
      : /\bread[-\s]?only\b|\bplan\b/.test(normalized)
        ? 'plan'
        : 'edit';
  const web = /\b(web|webfetch|web fetch|internet|browse|browser|fetch)\b/.test(normalized);
  return { mode, filesystemScope, web };
}

function yoloScopeLabel(scope: YoloFilesystemScope): string {
  switch (scope) {
    case 'task':
      return 'active mission path';
    case 'cwd':
      return 'Fireside working directory';
    case 'custom':
      return 'custom path';
    case 'unrestricted':
      return 'unrestricted filesystem';
  }
}

function rawOutputFromError(err: unknown): { stdout: string; stderr: string } {
  if (!err || typeof err !== 'object') return { stdout: '', stderr: '' };
  const obj = err as { stdout?: unknown; stderr?: unknown };
  return {
    stdout: typeof obj.stdout === 'string' ? obj.stdout : '',
    stderr: typeof obj.stderr === 'string' ? obj.stderr : '',
  };
}

function cleanVisibleAgentMessage(agentId: AgentId, text: string): string {
  const escaped = agentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(`(?:\\n\\s*)+(?:[*_~\\s]*)${escaped}(?:[*_~\\s]*)(?::|,)?\\s*$`, 'i'), '')
    .trim();
}

function providerCompactionWarning(agentId: AgentId, stderr: string): string | null {
  if (
    agentId === 'codex' &&
    /codex_core::session: failed to record rollout items: thread .* not found/i.test(stderr)
  ) {
    return 'Codex CLI returned success, but stderr reported that it failed to record rollout items for the resumed thread. The local rollout may not fully reflect the compaction turn.';
  }
  return null;
}

function oneLine(text: string, maxChars = 280): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}...`;
}

function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (delayMs <= 0) return Promise.resolve(signal?.aborted !== true);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class Broker extends EventEmitter {
  private activeYoloDiscussions = new Map<string, YoloDiscussionState>();
  private activeRunAbortControllers = new Map<
    string,
    { roomId: string; controller: AbortController }
  >();
  private queuedHumanMessageIds = new Map<string, Set<string>>();
  private drainingQueuedRooms = new Set<string>();
  private yoloSequence = 0;

  constructor(private deps: BrokerDeps) {
    super();
    this.recoverInterruptedRuns();
    this.recoverInterruptedJobs();
    queueMicrotask(() => {
      for (const room of listRooms(this.deps.db)) {
        void this.drainQueuedHumanMessages(room.id);
      }
    });
  }

  async postHumanMessage(roomId: string, authorId: string, text: string): Promise<Message> {
    const room = getRoom(this.deps.db, roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);
    const activeYolo = this.activeYoloDiscussions.get(roomId);
    if (this.roomHasActiveWork(roomId) || (activeYolo && !activeYolo.cancelled)) {
      return this.appendQueuedHumanMessage(roomId, authorId, text);
    }
    const inlineYoloProfile = inferYoloPermissionProfileFromText(text);
    if (inlineYoloProfile) {
      return this.startYoloDiscussion(roomId, authorId, inlineYoloProfile, text);
    }
    const responders = this.pickResponders(room.agents, text, authorId);
    const yoloResponders = room.yoloAgents.filter((agent) => responders.includes(agent));
    if (yoloResponders.length > 0) {
      return this.startYoloDiscussion(
        roomId,
        authorId,
        {
          mode: 'full-auto',
          filesystemScope: 'unrestricted',
          web: true,
        },
        text,
        yoloResponders,
      );
    }
    return this.append(roomId, authorId, 'human', text);
  }

  stopRoomRuns(roomId: string, authorId: string): { stopped: number } {
    const room = getRoom(this.deps.db, roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);
    let stopped = 0;
    let cancelledYolo = false;
    const activeYolo = this.activeYoloDiscussions.get(roomId);
    if (activeYolo && !activeYolo.cancelled) {
      this.cancelYoloState(activeYolo, authorId, 'manual');
      cancelledYolo = true;
      stopped += 1;
    }
    for (const { roomId: activeRoomId, controller } of this.activeRunAbortControllers.values()) {
      if (activeRoomId !== roomId || controller.signal.aborted) continue;
      controller.abort();
      stopped += 1;
    }
    if (stopped === 0) {
      this.appendDirect(roomId, 'system', 'system', `No active agent runs to stop.`);
    } else if (!cancelledYolo) {
      this.appendDirect(
        roomId,
        'system',
        'system',
        `Agent work stopped: ${authorId} clicked stop. In-flight provider turns are interrupted where possible.`,
      );
    }
    return { stopped };
  }

  async startYoloDiscussion(
    roomId: string,
    authorId: string,
    profileInput?: YoloPermissionProfile,
    messageText?: string,
    respondersOverride?: AgentId[],
  ): Promise<Message> {
    const room = getRoom(this.deps.db, roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);
    const existing = this.activeYoloDiscussions.get(roomId);
    if (existing && !existing.cancelled) {
      this.cancelYoloState(existing, authorId, 'replacement');
    }
    const yoloState = this.createYoloState(roomId, authorId);
    this.activeYoloDiscussions.set(roomId, yoloState);
    this.emit('yoloStatusUpdated', this.yoloStatus(yoloState, true));
    const activeTask = getActiveTask(this.deps.db, roomId);
    const profile = normalizeYoloPermissionProfile(profileInput);
    const permission = this.buildYoloPermissionGrant(profile, activeTask);
    const yoloResponders =
      respondersOverride && respondersOverride.length > 0
        ? respondersOverride.filter((agent) => room.agents.includes(agent))
        : room.yoloAgents.length > 0
          ? room.yoloAgents.filter((agent) => room.agents.includes(agent))
          : room.agents;
    const scopeLabel = yoloScopeLabel(profile.filesystemScope);
    const targetLabel =
      profile.filesystemScope === 'unrestricted'
        ? permission.target
        : `${scopeLabel}: ${permission.target}`;
    const text =
      messageText ??
      [
        `YOLO collaboration mode: participating agents should keep working together on the active mission while the human is away.`,
        `You may exchange up to ${YOLO_MAX_AGENT_REPLIES} total agent messages before stopping for human intervention.`,
        `YOLO permissions: ${profile.mode}; filesystem scope: ${targetLabel}; web: ${profile.web ? 'requested' : 'not requested'}.`,
        `Stay concrete: plan, execute, review, hand off, and stop early if the useful work is exhausted.`,
      ].join(' ');
    try {
      return await this.append(roomId, authorId, 'human', text, {
        mode: 'yolo',
        maxRepliesPerAgent: yoloState.maxTotalReplies,
        maxTotalReplies: yoloState.maxTotalReplies,
        permission,
        yoloState,
        responders: yoloResponders,
      });
    } finally {
      if (this.activeYoloDiscussions.get(roomId)?.id === yoloState.id) {
        this.activeYoloDiscussions.delete(roomId);
      }
      if (!yoloState.cancelled) {
        this.emit('yoloStatusUpdated', this.yoloStatus(yoloState, false, 'completed'));
      }
    }
  }

  cancelYoloDiscussion(roomId: string, authorId: string): YoloStatus {
    const activeYolo = this.activeYoloDiscussions.get(roomId);
    if (!activeYolo || activeYolo.cancelled) {
      const status: YoloStatus = {
        roomId,
        active: false,
        cancelled: false,
        reason: 'no-active-yolo',
      };
      this.emit('yoloStatusUpdated', status);
      return status;
    }
    return this.cancelYoloState(activeYolo, authorId, 'manual');
  }

  addYoloTurns(roomId: string, authorId: string, additionalTurns: number): YoloStatus {
    const activeYolo = this.activeYoloDiscussions.get(roomId);
    if (!activeYolo || activeYolo.cancelled) {
      const status: YoloStatus = {
        roomId,
        active: false,
        cancelled: false,
        reason: 'no-active-yolo',
      };
      this.emit('yoloStatusUpdated', status);
      return status;
    }
    const turns = Math.max(1, Math.min(10_000, Math.floor(additionalTurns)));
    activeYolo.maxTotalReplies += turns;
    const status = this.yoloStatus(activeYolo, true, `turns-added:${authorId}:${turns}`);
    this.emit('yoloStatusUpdated', status);
    return status;
  }

  async postSystemMessage(roomId: string, text: string): Promise<Message> {
    return this.append(roomId, 'system', 'system', text);
  }

  deleteRoom(roomId: string): boolean {
    const ok = deleteRoomRepo(this.deps.db, roomId);
    if (ok) this.emit('roomDeleted', { roomId });
    return ok;
  }

  setAgents(roomId: string, agents: AgentId[], yoloAgents?: AgentId[]): Room | null {
    setRoomAgentsRepo(this.deps.db, roomId, agents, yoloAgents);
    const updated = getRoom(this.deps.db, roomId);
    if (updated) this.emit('roomUpdated', updated);
    return updated;
  }

  listTasks(roomId: string): Task[] {
    return listTasksRepo(this.deps.db, roomId);
  }

  listMissionBriefings(limit = 100): MissionBriefingSummary[] {
    return listMissionBriefings(this.deps.db, { limit });
  }

  getMissionBriefing(briefingId: string): MissionBriefing | null {
    return getMissionBriefing(this.deps.db, briefingId);
  }

  createMissionBriefing(input: {
    roomId: string;
    taskId?: string | null;
    title?: string;
    summary?: string;
    createdBy: string;
  }): MissionBriefing | null {
    const room = getRoom(this.deps.db, input.roomId);
    if (!room) return null;
    const task =
      input.taskId !== undefined && input.taskId !== null
        ? getTask(this.deps.db, input.taskId)
        : getActiveTask(this.deps.db, input.roomId);
    if (task && task.roomId !== input.roomId) return null;
    const control = task ? this.buildTaskControl(task) : null;
    const messages = listMessages(this.deps.db, input.roomId);
    const runs = listAllAgentRunsForRoom(this.deps.db, input.roomId);
    const runActions = listAgentRunActionsForRoom(this.deps.db, input.roomId);
    const collaboration = listCollaborationItemsRepo(this.deps.db, input.roomId, {
      limit: 10_000,
      ...(task ? { taskId: task.id } : {}),
    });
    const capturedAt = Date.now();
    const payload: MissionBriefingPayload = {
      version: 1,
      capturedAt,
      room,
      task: control?.task ?? task ?? null,
      currentPhase: control?.currentPhase ?? null,
      activePlan: control?.activePlan ?? null,
      phases: control?.phases ?? [],
      checklistItems: control?.checklistItems ?? [],
      checklistNotes: control?.checklistNotes ?? [],
      plans: control?.plans ?? [],
      collaboration,
      messages,
      runs,
      runActions,
    };
    const title = input.title?.trim() || `${task?.title ?? room.name} briefing`;
    const summary =
      input.summary?.trim() ||
      task?.summary ||
      task?.goal ||
      `Snapshot of ${room.name} captured ${new Date(capturedAt).toLocaleString()}.`;
    return createMissionBriefingRepo(this.deps.db, {
      roomId: input.roomId,
      taskId: task?.id ?? null,
      title,
      summary,
      createdBy: input.createdBy,
      payload,
    });
  }

  createTask(roomId: string, input: Omit<CreateTaskInput, 'roomId'>): Task | null {
    const room = getRoom(this.deps.db, roomId);
    if (!room) return null;
    const task = createTaskRepo(this.deps.db, {
      ...input,
      roomId,
      agents: input.agents ?? room.agents,
    });
    this.emitRoomTasks(roomId);
    return task;
  }

  updateTask(roomId: string, taskId: string, input: UpdateTaskInput): Task | null {
    const existing = getTask(this.deps.db, taskId);
    if (!existing || existing.roomId !== roomId) return null;
    const task = updateTaskRepo(this.deps.db, taskId, input);
    if (task) this.emitRoomTasks(roomId);
    return task;
  }

  getTaskControl(roomId: string, taskId: string): TaskControl | null {
    const task = getTask(this.deps.db, taskId);
    if (!task || task.roomId !== roomId) return null;
    return this.buildTaskControl(task);
  }

  createTaskPhase(
    roomId: string,
    taskId: string,
    input: Omit<CreateTaskPhaseInput, 'taskId'>,
  ): TaskPhase | null {
    const task = getTask(this.deps.db, taskId);
    if (!task || task.roomId !== roomId) return null;
    if (input.planId) {
      const plan = getTaskPlan(this.deps.db, input.planId);
      if (!plan || plan.taskId !== taskId) return null;
    }
    const phase = createTaskPhase(this.deps.db, { ...input, taskId });
    this.emit('taskUpdated', task);
    return phase;
  }

  updateTaskPhase(
    roomId: string,
    taskId: string,
    phaseId: string,
    input: UpdateTaskPhaseInput,
  ): TaskPhase | null {
    const task = getTask(this.deps.db, taskId);
    const phase = getTaskPhase(this.deps.db, phaseId);
    if (!task || task.roomId !== roomId || !phase || phase.taskId !== taskId) return null;
    if (input.planId) {
      const plan = getTaskPlan(this.deps.db, input.planId);
      if (!plan || plan.taskId !== taskId) return null;
    }
    const updated = updateTaskPhase(this.deps.db, phaseId, input);
    if (updated) this.emit('taskUpdated', task);
    return updated;
  }

  createTaskChecklistItem(
    roomId: string,
    taskId: string,
    input: Omit<CreateTaskChecklistItemInput, 'taskId'>,
  ): TaskChecklistItem | null {
    const task = getTask(this.deps.db, taskId);
    if (!task || task.roomId !== roomId) return null;
    const normalizedInput = { ...input };
    if (input.phaseId) {
      const phase = getTaskPhase(this.deps.db, input.phaseId);
      if (!phase || phase.taskId !== taskId) return null;
      if (normalizedInput.planId && phase.planId && normalizedInput.planId !== phase.planId) {
        return null;
      }
      if (phase.planId) normalizedInput.planId = phase.planId;
    }
    if (normalizedInput.planId) {
      const plan = getTaskPlan(this.deps.db, normalizedInput.planId);
      if (!plan || plan.taskId !== taskId) return null;
    }
    const item = createTaskChecklistItem(this.deps.db, { ...normalizedInput, taskId });
    this.emit('taskUpdated', task);
    return item;
  }

  updateTaskChecklistItem(
    roomId: string,
    taskId: string,
    itemId: string,
    input: UpdateTaskChecklistItemInput,
  ): TaskChecklistItem | null {
    const task = getTask(this.deps.db, taskId);
    const item = getTaskChecklistItem(this.deps.db, itemId);
    if (!task || task.roomId !== roomId || !item || item.taskId !== taskId) return null;
    const normalizedInput = { ...input };
    const effectivePhaseId = input.phaseId !== undefined ? input.phaseId : item.phaseId;
    if (effectivePhaseId) {
      const phase = getTaskPhase(this.deps.db, effectivePhaseId);
      if (!phase || phase.taskId !== taskId) return null;
      if (normalizedInput.planId && phase.planId && normalizedInput.planId !== phase.planId) {
        return null;
      }
      if (phase.planId && input.phaseId !== null) normalizedInput.planId = phase.planId;
    }
    if (normalizedInput.planId) {
      const plan = getTaskPlan(this.deps.db, normalizedInput.planId);
      if (!plan || plan.taskId !== taskId) return null;
    }
    const updated = updateTaskChecklistItem(this.deps.db, itemId, normalizedInput);
    if (updated) this.emit('taskUpdated', task);
    return updated;
  }

  createTaskPlan(
    roomId: string,
    taskId: string,
    input: Omit<CreateTaskPlanInput, 'taskId'>,
  ): TaskPlan | null {
    const task = getTask(this.deps.db, taskId);
    if (!task || task.roomId !== roomId) return null;
    const plan = createTaskPlan(this.deps.db, { ...input, taskId });
    this.emit('taskUpdated', task);
    return plan;
  }

  updateTaskPlan(
    roomId: string,
    taskId: string,
    planId: string,
    input: UpdateTaskPlanInput,
  ): TaskPlan | null {
    const task = getTask(this.deps.db, taskId);
    const plan = getTaskPlan(this.deps.db, planId);
    if (!task || task.roomId !== roomId || !plan || plan.taskId !== taskId) return null;
    const updated = updateTaskPlan(this.deps.db, planId, input);
    if (updated) this.emit('taskUpdated', task);
    return updated;
  }

  listAgentRuns(roomId: string, limit = 30): AgentRunSummary[] {
    return listAgentRunsRepo(this.deps.db, roomId, { limit });
  }

  getAgentRunDetail(roomId: string, runId: string): AgentRunDetail | null {
    const run = getAgentRun(this.deps.db, runId);
    if (!run || run.roomId !== roomId) return null;
    const triggerMessage = getMessage(this.deps.db, run.triggerMessageId);
    const replyMessage = run.replyMessageId ? getMessage(this.deps.db, run.replyMessageId) : null;
    return {
      run,
      triggerMessage,
      replyMessage,
      diagnostics: buildRunDiagnostics(run.agentId, run.stdout, run.stderr),
      actions: listAgentRunActions(this.deps.db, run.id).map((action) =>
        this.normalizeActionContextUsage(action),
      ),
    };
  }

  dismissAgentRun(roomId: string, runId: string, authorId: string): AgentRunSummary | null {
    const run = getAgentRun(this.deps.db, runId);
    if (!run || run.roomId !== roomId) return null;
    const updated =
      run.status === 'running'
        ? updateAgentRun(this.deps.db, run.id, {
            status: 'completed',
            completedAt: Date.now(),
            lifecycleState: 'released',
            lifecycleReason: `${authorId || 'human'} dismissed stale running cue`,
          })
        : (listAgentRunsRepo(this.deps.db, roomId, { limit: 200 }).find(
            (item) => item.id === run.id,
          ) ?? null);
    if (!updated) return null;
    this.recordRunAction({
      roomId,
      taskId: run.taskId,
      runId: run.id,
      agentId: run.agentId,
      kind: 'run',
      status: 'completed',
      label: 'run dismissed',
      detail: `${authorId || 'human'} dismissed stale running cue`,
    });
    this.emit('agentRunUpdated', updated);
    return updated;
  }

  startAgentCompaction(roomId: string, agentId: AgentId, authorId: string): AgentCompactionResult {
    const room = getRoom(this.deps.db, roomId);
    if (!room) return { ok: false, statusCode: 404, error: 'room not found' };
    if (!COMPACTABLE_AGENT_IDS.has(agentId)) {
      return {
        ok: false,
        statusCode: 400,
        error: 'manual compaction is only available for claude and codex',
      };
    }
    if (!room.agents.includes(agentId)) {
      return { ok: false, statusCode: 400, error: `${agentId} is not in this room` };
    }
    if (listRunningAgentRunsForRoom(this.deps.db, roomId).some((run) => run.agentId === agentId)) {
      return { ok: false, statusCode: 409, error: `${agentId} is already working` };
    }
    if (!this.deps.resumeCliSessions) {
      return {
        ok: false,
        statusCode: 409,
        error: 'CLI session resume is disabled, so there is no durable session to compact',
      };
    }
    const sessionId = this.getResumableCliSessionId(roomId, agentId);
    if (!sessionId) {
      return { ok: false, statusCode: 409, error: `${agentId} has no stored CLI session yet` };
    }
    const spec = this.deps.getSpec(agentId);
    if (!spec) return { ok: false, statusCode: 503, error: `no adapter for agent "${agentId}"` };
    const trigger = listMessages(this.deps.db, roomId, { limit: 1 }).at(-1);
    if (!trigger) {
      return {
        ok: false,
        statusCode: 409,
        error: 'manual compaction needs at least one room message to anchor the run',
      };
    }
    const task = getActiveTask(this.deps.db, roomId);
    const run = createAgentRun(this.deps.db, {
      roomId,
      taskId: task?.id ?? null,
      triggerMessageId: trigger.id,
      agentId,
      permissionMode: 'plan',
      promptChars: COMPACT_PROMPT.length,
      estimatedPromptTokens: 2,
      liveMessages: 0,
      contextArtifacts: 0,
      promptText: COMPACT_PROMPT,
      lifecycleState: 'launching_agent_process',
      lifecycleReason: 'manual compaction requested',
      maxTurns: 1,
    });
    this.emit('agentRunUpdated', run);
    this.recordRunAction({
      roomId,
      taskId: task?.id ?? null,
      runId: run.id,
      agentId,
      kind: 'run',
      status: 'info',
      label: 'manual compaction requested',
      detail: `${authorId || 'human'} requested context compaction for session ${sessionId}`,
    });
    this.recordRunAction({
      roomId,
      taskId: task?.id ?? null,
      runId: run.id,
      agentId,
      kind: 'adapter',
      status: 'running',
      label: 'agent process started',
      detail: `${spec.command} / compact`,
    });
    void this.runAgentCompaction({
      roomId,
      taskId: task?.id ?? null,
      runId: run.id,
      agentId,
      spec,
      sessionId,
    });
    return { ok: true, run };
  }

  private getResumableCliSessionId(roomId: string, agentId: AgentId): string | null {
    const stored = getCliSessionId(this.deps.db, roomId, agentId);
    if (stored) return stored;

    const fallback = listAgentRunsRepo(this.deps.db, roomId, { limit: 200 }).find(
      (run) => run.agentId === agentId && Boolean(run.cliSessionId),
    )?.cliSessionId;
    if (!fallback) return null;

    upsertCliSessionId(this.deps.db, roomId, agentId, fallback);
    return fallback;
  }

  listCollaborationItems(roomId: string, limit = 50, taskId?: string | null): CollaborationItem[] {
    return listCollaborationItemsRepo(this.deps.db, roomId, {
      limit,
      ...(taskId !== undefined ? { taskId } : {}),
    });
  }

  listAgentRunActions(roomId: string, limit = 60): AgentRunAction[] {
    return listRecentAgentRunActions(this.deps.db, roomId, limit).map((action) =>
      this.normalizeActionContextUsage(action),
    );
  }

  private normalizeActionContextUsage(action: AgentRunAction): AgentRunAction {
    const usage = action.contextUsage;
    if (!usage || usage.provider !== 'codex') return action;
    const run = getAgentRun(this.deps.db, action.runId);
    if (!run?.cliSessionId) return action;
    const corrected = codexContextUsage(
      {
        input_tokens: usage.inputTokens,
        cached_input_tokens: usage.cachedInputTokens,
        output_tokens: usage.outputTokens,
        reasoning_output_tokens: usage.reasoningOutputTokens,
      },
      { threadId: run.cliSessionId },
    );
    if (!corrected || corrected.source === usage.source) return action;
    return {
      ...action,
      contextUsage: corrected,
      detail:
        action.label === 'codex turn completed' ? formatContextUsage(corrected) : action.detail,
    };
  }

  listArtifacts(roomId: string): ConversationArtifactListing | null {
    const room = getRoom(this.deps.db, roomId);
    if (!room || !this.deps.contextDir) return null;
    return listConversationArtifacts({ contextDir: this.deps.contextDir, roomId });
  }

  attachFixture(roomId: string, sourcePath: string): ConversationFixture | null {
    const room = getRoom(this.deps.db, roomId);
    if (!room || !this.deps.contextDir) return null;
    const fixture = attachConversationFixture({
      contextDir: this.deps.contextDir,
      roomId,
      sourcePath,
    });
    this.emit('artifactsUpdated', { roomId });
    return fixture;
  }

  removeArtifact(
    roomId: string,
    kind: ConversationArtifactListing['files'][number]['kind'],
    artifactPath: string,
  ): boolean {
    const room = getRoom(this.deps.db, roomId);
    if (!room || !this.deps.contextDir) return false;
    removeConversationArtifact({
      contextDir: this.deps.contextDir,
      roomId,
      kind,
      artifactPath,
    });
    this.emit('artifactsUpdated', { roomId });
    return true;
  }

  resolvePermissionRequest(
    requestId: string,
    decision: PermissionDecision,
    decidedBy: string,
  ): PermissionRequest | null {
    const existing = getPermissionRequest(this.deps.db, requestId);
    if (!existing) return null;
    if (existing.status !== 'pending') return existing;

    const resolved = resolvePermissionRequestRepo(this.deps.db, {
      id: requestId,
      decision,
      decidedBy,
    });
    if (!resolved) return null;

    const verb = decision === 'approved' ? 'approved' : 'denied';
    const nextStep =
      decision === 'approved'
        ? `${resolved.agentId} should now perform the approved operation.`
        : `${resolved.agentId} should continue without that access.`;
    const targetState =
      resolved.targetExists === null
        ? resolved.targetKind
        : resolved.targetExists
          ? `existing ${resolved.targetKind}`
          : 'missing target';
    const capabilityText = resolved.capabilities.join(', ') || resolved.mode;
    const decisionMessage = this.appendDirect(
      resolved.roomId,
      'system',
      'system',
      `Permission ${verb} for ${resolved.agentId}: ${resolved.mode} access to ${resolved.target}. Effective capabilities: ${capabilityText}. Target: ${targetState}. ${nextStep}`,
    );
    this.emit('permissionRequestUpdated', resolved);

    const permission =
      decision === 'approved'
        ? buildPermissionGrant({
            agentId: resolved.agentId,
            requestId: resolved.id,
            source: 'request',
            mode: resolved.mode,
            ...(resolved.requestedMode ? { requestedMode: resolved.requestedMode } : {}),
            target: resolved.target,
            reason: resolved.reason,
          })
        : undefined;

    if (permission) {
      this.appendDirect(
        resolved.roomId,
        'system',
        'system',
        `(${resolved.agentId} started approved ${resolved.mode} turn for ${resolved.target}.)`,
      );
    }

    void this.runPermissionDecisionFollowup(resolved, decisionMessage, permission).catch(
      (err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.appendDirect(
          resolved.roomId,
          'system',
          'system',
          `(${resolved.agentId} failed: ${errMsg})`,
        );
      },
    );
    return resolved;
  }

  private async runPermissionDecisionFollowup(
    request: PermissionRequest,
    decisionMessage: Message,
    permission: PermissionGrant | undefined,
  ): Promise<void> {
    const result = await this.runAgentReply(
      request.roomId,
      request.agentId,
      decisionMessage,
      undefined,
      permission,
    );
    if (!result.message) {
      const mode = permission ? `approved ${permission.mode}` : 'denied permission';
      this.appendDirect(
        request.roomId,
        'system',
        'system',
        `(${request.agentId} finished the ${mode} follow-up without a visible chat message.)`,
      );
      await this.drainQueuedHumanMessages(request.roomId);
      return;
    }
    await this.runAgentHandoffs(request.roomId, request.agentId, result.message);
    await this.drainQueuedHumanMessages(request.roomId);
  }

  private buildYoloPermissionGrant(
    profile: NormalizedYoloPermissionProfile,
    activeTask: Task | null,
    agentId: AgentId = 'echo',
  ): PermissionGrant {
    const target = (() => {
      switch (profile.filesystemScope) {
        case 'task':
          return activeTask?.repoPath || process.cwd();
        case 'cwd':
          return process.cwd();
        case 'custom':
          return profile.target || activeTask?.repoPath || process.cwd();
        case 'unrestricted':
          return 'unrestricted filesystem';
      }
    })();
    const reason = [
      `YOLO collaboration permission profile (${profile.mode}, ${yoloScopeLabel(profile.filesystemScope)}).`,
      profile.web
        ? 'The human requested web lookup/fetch access for this YOLO run where supported.'
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    return {
      ...buildPermissionGrant({
        agentId,
        source: 'yolo',
        mode: profile.mode,
        target,
        reason,
        filesystemScope: profile.filesystemScope,
        ...(profile.web ? { web: true } : {}),
      }),
      source: 'yolo',
      mode: profile.mode,
      target,
      reason,
      filesystemScope: profile.filesystemScope,
      ...(profile.web ? { web: true } : {}),
    };
  }

  private buildYoloAutoApprovedPermissionGrant(
    agentId: AgentId,
    request: PermissionRequest | PermissionGrant,
    currentPermission: PermissionGrant,
  ): PermissionGrant {
    return buildPermissionGrant({
      agentId,
      source: 'yolo',
      mode: request.mode,
      ...(request.requestedMode ? { requestedMode: request.requestedMode } : {}),
      target: request.target,
      reason: request.reason,
      ...(currentPermission.filesystemScope
        ? { filesystemScope: currentPermission.filesystemScope }
        : {}),
      ...(currentPermission.web ? { web: true } : {}),
    });
  }

  private buildRoomYoloPermissionGrant(agentId: AgentId, activeTask: Task | null): PermissionGrant {
    return this.buildYoloPermissionGrant(
      {
        mode: 'full-auto',
        filesystemScope: 'unrestricted',
        web: true,
      },
      activeTask,
      agentId,
    );
  }

  private createYoloState(roomId: string, startedBy: string): YoloDiscussionState {
    return {
      id: `${Date.now()}-${++this.yoloSequence}`,
      roomId,
      startedBy,
      startedAt: Date.now(),
      maxTotalReplies: YOLO_MAX_AGENT_REPLIES,
      totalRepliesUsed: 0,
      abortController: new AbortController(),
      cancelled: false,
    };
  }

  private async runRoomAwareDiscussionThread(
    roomId: string,
    room: Room,
    responders: AgentId[],
    message: Message,
    options: DiscussionThreadOptions = {},
  ): Promise<void> {
    const uniqueResponders = responders.filter(
      (agentId, index) => responders.indexOf(agentId) === index,
    );
    if (uniqueResponders.length === 0) return;
    if (options.mode === 'yolo') {
      await this.runDiscussionThread(roomId, uniqueResponders, message, options);
      return;
    }

    const yoloResponders = uniqueResponders.filter((agent) => room.yoloAgents.includes(agent));
    const normalResponders = uniqueResponders.filter((agent) => !room.yoloAgents.includes(agent));

    if (yoloResponders.length > 0) {
      await this.runRoomYoloDiscussionThread(roomId, message.authorId, yoloResponders, message);
    }
    if (normalResponders.length > 0) {
      await this.runDiscussionThread(roomId, normalResponders, message, options);
    }
  }

  private async runRoomYoloDiscussionThread(
    roomId: string,
    startedBy: string,
    responders: AgentId[],
    message: Message,
  ): Promise<void> {
    const existing = this.activeYoloDiscussions.get(roomId);
    const yoloState =
      existing && !existing.cancelled ? existing : this.createYoloState(roomId, startedBy);
    const createdState = yoloState !== existing;
    if (createdState) {
      this.activeYoloDiscussions.set(roomId, yoloState);
      this.emit('yoloStatusUpdated', this.yoloStatus(yoloState, true));
    }

    try {
      await this.runDiscussionThread(roomId, responders, message, {
        mode: 'yolo',
        maxRepliesPerAgent: yoloState.maxTotalReplies,
        maxTotalReplies: yoloState.maxTotalReplies,
        yoloState,
        responders,
      });
    } finally {
      if (createdState && this.activeYoloDiscussions.get(roomId)?.id === yoloState.id) {
        this.activeYoloDiscussions.delete(roomId);
      }
      if (createdState && !yoloState.cancelled) {
        this.emit('yoloStatusUpdated', this.yoloStatus(yoloState, false, 'completed'));
      }
    }
  }

  private buildTaskControl(task: Task): TaskControl {
    const phases = listTaskPhases(this.deps.db, task.id);
    const checklistItems = listTaskChecklistItems(this.deps.db, task.id);
    const checklistNotes = listTaskChecklistNotes(this.deps.db, task.id);
    const plans = listTaskPlans(this.deps.db, task.id);
    const currentPhase =
      phases.find((phase) => phase.status === 'active') ??
      phases.find((phase) => phase.status === 'blocked') ??
      null;
    return {
      task,
      phases,
      checklistItems,
      checklistNotes,
      plans,
      currentPhase,
      openChecklistItems: checklistItems.filter((item) => item.status === 'open').slice(0, 12),
      blockedChecklistItems: checklistItems
        .filter((item) => item.status === 'blocked')
        .slice(0, 12),
      activePlan: plans.find((plan) => plan.status === 'active') ?? null,
    };
  }

  private loadWorkflowProfileForTask(task: Task | null): WorkflowProfile | null {
    if (!task?.repoPath) return null;
    try {
      return loadWorkflowProfile({ repoPath: task.repoPath });
    } catch (err) {
      logger.warn(
        {
          taskId: task.id,
          repoPath: task.repoPath,
          err: err instanceof Error ? err.message : String(err),
        },
        'failed to load workflow profile',
      );
      return null;
    }
  }

  private workflowProfilePromptItem(
    profile: WorkflowProfile | null,
  ): WorkflowProfilePromptItem | undefined {
    if (!profile) return undefined;
    return {
      sourcePath: profile.sourcePath ?? '',
      promptTemplate: profile.promptTemplate,
      maxTurns: profile.agent.maxTurns,
      maxConcurrentAgents: profile.agent.maxConcurrentAgents,
    };
  }

  private workflowWorkspacePath(
    profile: WorkflowProfile | null,
    task: Task | null,
    workLane?: WorkLaneAssignment,
  ): string {
    if (!profile || !task) return '';
    try {
      return getWorkspacePath(profile.workspace.root, {
        missionId: task.id,
        taskId: workLane?.item.id ?? null,
      });
    } catch (err) {
      logger.warn(
        {
          taskId: task.id,
          workspaceRoot: profile.workspace.root,
          err: err instanceof Error ? err.message : String(err),
        },
        'failed to resolve workflow workspace path',
      );
      return '';
    }
  }

  listMessages(roomId: string, opts: { limit?: number } = {}): Message[] {
    return listMessages(this.deps.db, roomId, opts).map((message) =>
      this.withDeliveryStatus(roomId, message),
    );
  }

  private emitRoomTasks(roomId: string): void {
    for (const task of listTasksRepo(this.deps.db, roomId)) {
      this.emit('taskUpdated', task);
    }
  }

  private workLanePromptItem(item: TaskChecklistItem): WorkLanePromptItem {
    return {
      id: item.id,
      title: item.title,
      detail: item.detail,
      status: item.status,
      planId: item.planId,
      phaseId: item.phaseId,
      dependencyIds: item.dependencyIds,
      expectedTouches: item.expectedTouches,
      parallelism: item.parallelism,
      conflictGroup: item.conflictGroup,
      workRole: item.workRole,
      ownerAgentId: item.ownerAgentId,
      statusNote: item.statusNote,
      blockedReason: item.blockedReason,
      councilRequired: item.councilRequired,
    };
  }

  private checklistDependenciesSatisfied(
    item: TaskChecklistItem,
    byId: Map<string, TaskChecklistItem>,
  ): boolean {
    return item.dependencyIds.every((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return dependency?.status === 'done' || dependency?.status === 'skipped';
    });
  }

  private workLaneScopeContract(
    item: TaskChecklistItem,
    agentId: AgentId | '' = '',
    source: WorkLaneScopeContract['source'] = 'checklist',
  ): WorkLaneScopeContract {
    return {
      itemId: item.id,
      title: item.title,
      agentId,
      expectedTouches: item.expectedTouches,
      parallelism: item.parallelism,
      conflictGroup: item.conflictGroup.trim().toLowerCase(),
      workRole: item.workRole,
      source,
    };
  }

  private workLaneScopeContractFromJob(job: AgentJob): WorkLaneScopeContract | null {
    const item = job.checklistItemId
      ? getTaskChecklistItem(this.deps.db, job.checklistItemId)
      : null;
    if (item) return this.workLaneScopeContract(item, job.agentId, 'active-job');
    try {
      const parsed = JSON.parse(job.workPacketJson) as {
        assignedItem?: {
          id?: unknown;
          title?: unknown;
          expectedTouches?: unknown;
          parallelism?: unknown;
          conflictGroup?: unknown;
          workRole?: unknown;
        } | null;
      };
      const assigned = parsed.assignedItem;
      if (!assigned || typeof assigned.id !== 'string') return null;
      const parallelism =
        assigned.parallelism === 'coordinate' || assigned.parallelism === 'exclusive'
          ? assigned.parallelism
          : 'parallel-safe';
      return {
        itemId: assigned.id,
        title: typeof assigned.title === 'string' ? assigned.title : assigned.id,
        agentId: job.agentId,
        expectedTouches: Array.isArray(assigned.expectedTouches)
          ? assigned.expectedTouches.filter((touch): touch is string => typeof touch === 'string')
          : [],
        parallelism,
        conflictGroup:
          typeof assigned.conflictGroup === 'string'
            ? assigned.conflictGroup.trim().toLowerCase()
            : '',
        workRole: typeof assigned.workRole === 'string' ? assigned.workRole : '',
        source: 'active-job',
      };
    } catch {
      return null;
    }
  }

  private activeWorkLaneContracts(roomId: string, taskId: string): WorkLaneScopeContract[] {
    return listActiveAgentJobsForRoom(this.deps.db, roomId)
      .filter((job) => job.taskId === taskId && Boolean(job.checklistItemId))
      .map((job) => this.workLaneScopeContractFromJob(job))
      .filter((contract): contract is WorkLaneScopeContract => Boolean(contract));
  }

  private normalizeTouchScope(value: string): string {
    return value
      .trim()
      .replace(/\\/g, '/')
      .replace(/^["']|["']$/g, '')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '')
      .toLowerCase();
  }

  private touchScopeRoot(value: string): string {
    const normalized = this.normalizeTouchScope(value);
    const globIndex = normalized.search(/[*{[]/);
    const base = globIndex >= 0 ? normalized.slice(0, globIndex) : normalized;
    return base.replace(/\/[^/]*$/, '').replace(/\/$/, '') || normalized;
  }

  private touchScopeHasGlob(value: string): boolean {
    return /[*{[]/.test(value);
  }

  private touchScopesOverlap(a: string, b: string): boolean {
    const left = this.normalizeTouchScope(a);
    const right = this.normalizeTouchScope(b);
    if (!left || !right) return false;
    if (left === right) return true;
    if (!this.touchScopeHasGlob(left) && !this.touchScopeHasGlob(right)) {
      return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
    }
    const leftRoot = this.touchScopeRoot(left);
    const rightRoot = this.touchScopeRoot(right);
    if (!leftRoot || !rightRoot) return false;
    return (
      leftRoot === rightRoot ||
      leftRoot.startsWith(`${rightRoot}/`) ||
      rightRoot.startsWith(`${leftRoot}/`)
    );
  }

  private workLaneConflictReason(
    candidate: TaskChecklistItem,
    activeContracts: WorkLaneScopeContract[],
  ): string {
    const candidateContract = this.workLaneScopeContract(candidate);
    for (const active of activeContracts) {
      if (active.itemId === candidate.id) {
        return `item already assigned to ${active.agentId || 'another active job'}`;
      }
      if (
        candidateContract.conflictGroup &&
        active.conflictGroup &&
        candidateContract.conflictGroup === active.conflictGroup
      ) {
        return `conflict group ${candidateContract.conflictGroup} is active`;
      }
      const touchesOverlap = candidateContract.expectedTouches.some((left) =>
        active.expectedTouches.some((right) => this.touchScopesOverlap(left, right)),
      );
      if (touchesOverlap) {
        return `expected touch scope overlaps with ${active.title}`;
      }
      const exclusiveWithoutScope =
        candidateContract.parallelism === 'exclusive' &&
        candidateContract.expectedTouches.length === 0 &&
        !candidateContract.conflictGroup;
      const activeExclusiveWithoutScope =
        active.parallelism === 'exclusive' &&
        active.expectedTouches.length === 0 &&
        !active.conflictGroup;
      if (exclusiveWithoutScope || activeExclusiveWithoutScope) {
        return `exclusive work is active`;
      }
    }
    return '';
  }

  private assignYoloWorkLanes(roomId: string, agents: AgentId[]): Map<AgentId, WorkLaneAssignment> {
    const uniqueAgents = agents.filter((agent, index) => agents.indexOf(agent) === index);
    if (uniqueAgents.length === 0) return new Map();
    const task = getActiveTask(this.deps.db, roomId);
    if (!task) return new Map();

    const activeJobs = listActiveAgentJobsForRoom(this.deps.db, roomId).filter(
      (job) => job.taskId === task.id,
    );
    const busyAgents = new Set(activeJobs.map((job) => job.agentId));
    const activeItemIds = new Set(
      activeJobs.map((job) => job.checklistItemId).filter((id): id is string => Boolean(id)),
    );
    const activeContracts = this.activeWorkLaneContracts(roomId, task.id);
    const reservedContracts = [...activeContracts];
    const assignableAgents = uniqueAgents.filter((agentId) => !busyAgents.has(agentId));
    const agentSet = new Set<AgentId>(assignableAgents);
    const items = listTaskChecklistItems(this.deps.db, task.id);
    const byId = new Map(items.map((item) => [item.id, item]));
    const eligibleItems = items.filter(
      (item) =>
        item.status === 'open' &&
        !activeItemIds.has(item.id) &&
        this.checklistDependenciesSatisfied(item, byId) &&
        (!item.ownerAgentId || agentSet.has(item.ownerAgentId as AgentId)),
    );
    const assignments = new Map<AgentId, WorkLaneAssignment>();
    const assignedItemIds = new Set<string>();

    for (const agentId of assignableAgents) {
      const owned = eligibleItems.find(
        (item) =>
          item.ownerAgentId === agentId &&
          !assignedItemIds.has(item.id) &&
          !this.workLaneConflictReason(item, reservedContracts),
      );
      if (owned) {
        assignments.set(agentId, { item: owned });
        assignedItemIds.add(owned.id);
        reservedContracts.push(this.workLaneScopeContract(owned, agentId));
      }
    }

    const unownedItems = eligibleItems.filter((item) => !item.ownerAgentId);
    const availableAgents = assignableAgents.filter((agentId) => !assignments.has(agentId));
    let changedOwner = false;
    for (const agentId of availableAgents) {
      const itemIndex = unownedItems.findIndex(
        (candidate) =>
          !assignedItemIds.has(candidate.id) &&
          !this.workLaneConflictReason(candidate, reservedContracts),
      );
      const item = itemIndex >= 0 ? unownedItems.splice(itemIndex, 1)[0] : undefined;
      if (!item) break;
      const updated =
        updateTaskChecklistItem(this.deps.db, item.id, {
          ownerAgentId: agentId,
          updatedBy: 'fireside',
        }) ?? item;
      assignments.set(agentId, { item: updated });
      byId.set(updated.id, updated);
      assignedItemIds.add(updated.id);
      reservedContracts.push(this.workLaneScopeContract(updated, agentId));
      changedOwner = true;
    }

    if (changedOwner) {
      const updatedTask = getTask(this.deps.db, task.id);
      if (updatedTask) this.emit('taskUpdated', updatedTask);
    }

    return assignments;
  }

  private async runAgentReply(
    roomId: string,
    agentId: AgentId,
    trigger: Message,
    discussion?: DiscussionTurn,
    permission?: PermissionGrant,
    cancelSignal?: AbortSignal,
    yoloPermissionAutoApprovals = 0,
    workLane?: WorkLaneAssignment,
    attempt = 1,
    retryOfRunId = '',
  ): Promise<AgentTurnResult> {
    if (cancelSignal?.aborted) return { message: null, progressed: false };
    const spec = this.deps.getSpec(agentId);
    if (!spec) {
      this.appendDirect(roomId, 'system', 'system', `(no adapter for agent "${agentId}")`);
      return { message: null, progressed: false };
    }
    const room = getRoom(this.deps.db, roomId);
    if (!room) {
      // The room was created before this call ran; it should still exist. Defensive guard.
      throw new Error(`unknown room: ${roomId}`);
    }
    const allMessages = listMessages(this.deps.db, roomId);
    const triggerIndex = allMessages.findIndex((m) => m.id === trigger.id);
    const history =
      triggerIndex >= 0 ? allMessages.slice(0, triggerIndex) : allMessages.slice(0, -1);
    const maxHistory = this.deps.maxHistory ?? DEFAULT_PROMPT_HISTORY;
    const promptHistory = history.slice(-maxHistory);
    this.markQueuedMessagesDelivered(roomId, [...promptHistory, trigger]);
    const contextFiles = this.deps.contextDir
      ? writeConversationContextFiles({
          contextDir: this.deps.contextDir,
          roomId,
          roomName: room.name,
          messages: allMessages,
          recentMessages: promptHistory.length + 1,
          ...(this.deps.largeMessageThresholdChars !== undefined
            ? { largeMessageThresholdChars: this.deps.largeMessageThresholdChars }
            : {}),
          ...(this.deps.artifactExcerptChars !== undefined
            ? { artifactExcerptChars: this.deps.artifactExcerptChars }
            : {}),
          ...(this.deps.maxRecapChars !== undefined
            ? { maxRecapChars: this.deps.maxRecapChars }
            : {}),
          ...(this.deps.maxTranscriptChars !== undefined
            ? { maxTranscriptChars: this.deps.maxTranscriptChars }
            : {}),
        })
      : undefined;
    const promptContextFiles = contextFiles
      ? {
          ...contextFiles,
          artifactCount: Object.keys(contextFiles.messageArtifacts).length,
          fixtureCount: contextFiles.fixtureCount,
          fixtureManifestPath: contextFiles.fixtureManifestPath,
          fixtureSummary: contextFiles.fixtureSummary,
        }
      : undefined;
    const activeTask = getActiveTask(this.deps.db, roomId);
    const workflowProfile = this.loadWorkflowProfileForTask(activeTask ?? null);
    const collaborationItems = listCollaborationItemsRepo(this.deps.db, roomId, {
      limit: 10,
      ...(activeTask ? { taskId: activeTask.id } : {}),
    });
    const taskContext = activeTask
      ? buildTaskPromptContext({
          task: activeTask,
          recentMessages: allMessages.slice(-8),
          recentRuns: listRecentAgentRunsForTask(this.deps.db, roomId, activeTask.id, 6),
          missionControl: this.buildTaskControl(activeTask),
        })
      : undefined;
    const explicitPermission: PermissionGrant | undefined = permission
      ? buildPermissionGrant({
          agentId,
          mode: permission.mode,
          target: permission.target,
          reason: permission.reason,
          ...(permission.requestedMode ? { requestedMode: permission.requestedMode } : {}),
          ...(permission.source ? { source: permission.source } : {}),
          ...(permission.requestId ? { requestId: permission.requestId } : {}),
          ...(permission.filesystemScope ? { filesystemScope: permission.filesystemScope } : {}),
          ...(permission.web ? { web: true } : {}),
        })
      : undefined;
    const roomYoloPermission: PermissionGrant | undefined =
      !explicitPermission && room.yoloAgents.includes(agentId)
        ? this.buildRoomYoloPermissionGrant(agentId, activeTask)
        : undefined;
    const taskPermission: PermissionGrant | undefined =
      !explicitPermission &&
      !roomYoloPermission &&
      activeTask &&
      activeTask.capabilityProfile !== 'plan'
        ? buildPermissionGrant({
            agentId,
            source: 'task',
            mode: activeTask.capabilityProfile,
            target: activeTask.repoPath || process.cwd(),
            reason: `Task capability profile "${activeTask.capabilityProfile}" for mission "${activeTask.title}".`,
          })
        : undefined;
    const workflowPermission: PermissionGrant | undefined =
      !explicitPermission &&
      !roomYoloPermission &&
      !taskPermission &&
      workflowProfile &&
      workflowProfile.permissions.mode !== 'plan'
        ? buildPermissionGrant({
            agentId,
            source: 'task',
            mode: workflowProfile.permissions.mode,
            target:
              workflowProfile.permissions.target ||
              this.workflowWorkspacePath(workflowProfile, activeTask ?? null, workLane) ||
              activeTask?.repoPath ||
              process.cwd(),
            reason: `Workflow profile permission default${workflowProfile.sourcePath ? ` from ${workflowProfile.sourcePath}` : ''}.`,
            ...(workflowProfile.permissions.filesystemScope
              ? { filesystemScope: workflowProfile.permissions.filesystemScope }
              : {}),
            ...(workflowProfile.permissions.web ? { web: true } : {}),
          })
        : undefined;
    const effectivePermission =
      explicitPermission ?? roomYoloPermission ?? taskPermission ?? workflowPermission;
    const workflowWorkspacePath = this.workflowWorkspacePath(
      workflowProfile,
      activeTask ?? null,
      workLane,
    );
    const workflowProfilePromptItem = this.workflowProfilePromptItem(workflowProfile);
    const promptResult = buildTurnPromptResult({
      agentId,
      roomName: room.name,
      roomAgents: room.agents,
      history: promptHistory.map((m) => ({
        authorId: m.authorId,
        authorKind: m.authorKind,
        text: messageTextForPrompt(m, contextFiles),
      })),
      newMessage: {
        authorId: trigger.authorId,
        authorKind: trigger.authorKind,
        text: messageTextForPrompt(trigger, contextFiles),
      },
      maxHistory,
      maxPromptChars:
        workflowProfile?.promptBudgetChars ?? this.deps.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
      ...(promptContextFiles !== undefined ? { contextFiles: promptContextFiles } : {}),
      ...(discussion !== undefined ? { discussion } : {}),
      ...(effectivePermission !== undefined ? { permission: effectivePermission } : {}),
      ...(taskContext !== undefined ? { task: taskContext } : {}),
      ...(workLane !== undefined ? { workLane: this.workLanePromptItem(workLane.item) } : {}),
      ...(workflowProfilePromptItem !== undefined
        ? { workflowProfile: workflowProfilePromptItem }
        : {}),
      collaboration: collaborationItems,
    });
    const prompt = promptResult.prompt;
    const sessionId = this.deps.resumeCliSessions
      ? this.getResumableCliSessionId(roomId, agentId)
      : null;
    const liveMessageChars = [
      ...promptHistory.map((m) => messageTextForPrompt(m, contextFiles).length),
      messageTextForPrompt(trigger, contextFiles).length,
    ];
    const contextArtifactCount = contextFiles
      ? Object.keys(contextFiles.messageArtifacts).length + contextFiles.fixtureCount
      : 0;

    logger.info(
      {
        roomId,
        roomName: room.name,
        agentId,
        promptChars: promptResult.stats.promptChars,
        estimatedPromptTokens: promptResult.stats.estimatedPromptTokens,
        maxPromptChars: promptResult.stats.maxPromptChars,
        totalMessages: allMessages.length,
        liveHistoryMessages: promptResult.stats.historyMessagesIncluded,
        messagesDroppedByCount: promptResult.stats.historyMessagesDroppedByCount,
        messagesDroppedByBudget: promptResult.stats.historyMessagesDroppedByBudget,
        latestMessageTruncated: promptResult.stats.latestMessageTruncated,
        largestLiveMessageChars: Math.max(0, ...liveMessageChars),
        contextArtifacts: contextArtifactCount,
        resumeCliSession: Boolean(sessionId),
        taskId: activeTask?.id ?? null,
      },
      'agent prompt context',
    );

    const agentJob = createAgentJob(this.deps.db, {
      roomId,
      taskId: activeTask?.id ?? null,
      checklistItemId: workLane?.item.id ?? null,
      agentId,
      triggerMessageId: trigger.id,
      workPacketJson: JSON.stringify(
        this.buildAgentJobWorkPacket({
          task: activeTask ?? null,
          taskContext,
          workLane,
          permission: effectivePermission,
          discussion,
          promptStats: promptResult.stats,
        }),
      ),
      permissionJson: JSON.stringify(effectivePermission ?? null),
      attempt,
      maxAttempts: discussion?.mode === 'yolo' ? 3 : 1,
    });
    leaseAgentJob(this.deps.db, agentJob.id, {
      leaseOwner: this.agentJobLeaseOwner(),
      leaseMs: AGENT_JOB_LEASE_MS,
    });

    const run = createAgentRun(this.deps.db, {
      agentJobId: agentJob.id,
      roomId,
      taskId: activeTask?.id ?? null,
      triggerMessageId: trigger.id,
      agentId,
      permissionMode: effectivePermission?.mode ?? 'plan',
      promptChars: promptResult.stats.promptChars,
      estimatedPromptTokens: promptResult.stats.estimatedPromptTokens,
      liveMessages: promptResult.stats.historyMessagesIncluded + 1,
      contextArtifacts: contextArtifactCount,
      promptText: prompt,
      permissionSource: effectivePermission?.source ?? '',
      permissionTarget: effectivePermission?.target ?? '',
      permissionReason: effectivePermission?.reason ?? '',
      permissionFilesystemScope: effectivePermission?.filesystemScope ?? '',
      permissionWeb: effectivePermission?.web === true,
      permissionCapabilities: effectivePermission?.capabilities ?? [],
      permissionTargetExists: effectivePermission?.targetExists ?? null,
      permissionTargetKind: effectivePermission?.targetKind ?? 'unknown',
      permissionTargetResolvedPath: effectivePermission?.targetResolvedPath ?? '',
      permissionTargetCheckedAt: effectivePermission?.targetCheckedAt ?? 0,
      permissionProviderProfile: effectivePermission?.providerProfile ?? '',
      lifecycleState: 'launching_agent_process',
      lifecycleReason: 'prompt prepared; launching agent process',
      continuationTurn: (discussion?.repliesUsed ?? 0) + 1,
      maxTurns: discussion?.maxRepliesPerAgent ?? 1,
      workspacePath:
        workflowWorkspacePath ||
        effectivePermission?.targetResolvedPath ||
        effectivePermission?.target ||
        '',
      attempt,
      retryOfRunId,
    });
    attachAgentJobRun(this.deps.db, agentJob.id, run.id, {
      leaseOwner: this.agentJobLeaseOwner(),
      leaseMs: AGENT_JOB_LEASE_MS,
    });
    this.emit('agentRunUpdated', run);
    this.recordRunAction({
      roomId,
      taskId: activeTask?.id ?? null,
      runId: run.id,
      agentId,
      kind: 'prompt',
      status: 'completed',
      label: 'prompt prepared',
      detail: `${promptResult.stats.estimatedPromptTokens} estimated tokens, ${promptResult.stats.historyMessagesIncluded + 1} live messages, ${contextArtifactCount} artifacts`,
    });
    this.recordRunAction({
      roomId,
      taskId: activeTask?.id ?? null,
      runId: run.id,
      agentId,
      kind: effectivePermission ? 'permission' : 'run',
      status: 'info',
      label: effectivePermission
        ? `${effectivePermission.mode} permission active`
        : 'read-only turn',
      detail: effectivePermission
        ? `${effectivePermission.source} permission for ${effectivePermission.target}; capabilities: ${effectivePermission.capabilities?.join(', ') || 'none'}`
        : 'no write/full-auto permission grant for this turn',
    });
    if (workLane) {
      this.recordRunAction({
        roomId,
        taskId: activeTask?.id ?? null,
        runId: run.id,
        agentId,
        kind: 'ledger',
        status: 'info',
        label: 'YOLO lane assigned',
        detail: `${workLane.item.title} [id=${workLane.item.id}]`,
      });
    }
    this.recordMissionWorkPacket({
      roomId,
      task: activeTask ?? null,
      runId: run.id,
      agentId,
      permission: effectivePermission,
      workLane,
      discussion,
    });
    this.recordRunAction({
      roomId,
      taskId: activeTask?.id ?? null,
      runId: run.id,
      agentId,
      kind: 'adapter',
      status: 'running',
      label: 'agent process started',
      detail: spec.command,
    });
    let lastProviderSignalAt = 0;
    const recordProviderSignal = this.buildProviderSignalRecorder({
      roomId,
      taskId: activeTask?.id ?? null,
      runId: run.id,
      agentId,
      onSignal: () => {
        lastProviderSignalAt = Date.now();
      },
    });
    const stopHeartbeat = this.startRunHeartbeat({
      roomId,
      taskId: activeTask?.id ?? null,
      runId: run.id,
      agentJobId: agentJob.id,
      agentId,
      startedAt: run.startedAt,
      latestProviderSignalAt: () => lastProviderSignalAt,
    });

    let reply: AgentReply;
    const runAbortController = new AbortController();
    const relayCancel = (): void => runAbortController.abort();
    if (cancelSignal?.aborted) {
      runAbortController.abort();
    } else {
      cancelSignal?.addEventListener('abort', relayCancel, { once: true });
    }
    this.activeRunAbortControllers.set(run.id, { roomId, controller: runAbortController });
    try {
      reply = await this.deps.runAgent(
        spec,
        prompt,
        sessionId,
        effectivePermission,
        runAbortController.signal,
        recordProviderSignal,
        effectivePermission?.source === 'yolo' ? null : undefined,
      );
    } catch (err) {
      this.activeRunAbortControllers.delete(run.id);
      cancelSignal?.removeEventListener('abort', relayCancel);
      stopHeartbeat();
      const errMsg = err instanceof Error ? err.message : String(err);
      const raw = rawOutputFromError(err);
      const canceled =
        cancelSignal?.aborted || (err instanceof Error && err.name === 'SubprocessCanceledError');
      const failedRun = updateAgentRun(this.deps.db, run.id, {
        status: 'failed',
        completedAt: Date.now(),
        error: errMsg,
        stdout: raw.stdout,
        stderr: raw.stderr,
        lifecycleState: canceled ? 'canceled_by_reconciliation' : 'failed',
        lifecycleReason: errMsg,
      });
      if (failedRun) this.emit('agentRunUpdated', failedRun);
      this.recordDiagnosticActions(
        roomId,
        activeTask?.id ?? null,
        run.id,
        agentId,
        raw.stdout,
        raw.stderr,
      );
      this.recordRunAction({
        roomId,
        taskId: activeTask?.id ?? null,
        runId: run.id,
        agentId,
        kind: 'error',
        status: 'failed',
        label: canceled ? 'run canceled' : 'run failed',
        detail: errMsg,
      });
      if (canceled) {
        cancelAgentJob(this.deps.db, agentJob.id, errMsg);
      } else {
        failAgentJob(this.deps.db, agentJob.id, errMsg);
      }
      const retryDecision =
        !canceled && discussion?.mode === 'yolo'
          ? decideRunRetry({ state: 'failed', attempt }, { maxAttempts: 3 })
          : null;
      if (retryDecision?.shouldRetry && retryDecision.nextAttempt !== null) {
        const retryAfter = Date.now() + retryDecision.delayMs;
        const retryRun = updateAgentRun(this.deps.db, run.id, {
          lifecycleState: 'retry_queued',
          lifecycleReason: `${retryDecision.reason}: retrying attempt ${retryDecision.nextAttempt}`,
          retryAfter,
        });
        if (retryRun) this.emit('agentRunUpdated', retryRun);
        this.recordRunAction({
          roomId,
          taskId: activeTask?.id ?? null,
          runId: run.id,
          agentId,
          kind: 'run',
          status: 'info',
          label: 'retry scheduled',
          detail: `attempt ${retryDecision.nextAttempt} in ${Math.round(retryDecision.delayMs / 1000)}s`,
        });
        const shouldContinue = await waitForRetryDelay(retryDecision.delayMs, cancelSignal);
        if (!shouldContinue) return { message: null, progressed: false, runId: run.id };
        return this.runAgentReply(
          roomId,
          agentId,
          trigger,
          discussion,
          permission,
          cancelSignal,
          yoloPermissionAutoApprovals,
          workLane,
          retryDecision.nextAttempt,
          run.id,
        );
      }
      this.appendDirect(
        roomId,
        'system',
        'system',
        canceled ? `(${agentId} canceled: run was interrupted.)` : `(${agentId} failed: ${errMsg})`,
      );
      return { message: null, progressed: false, runId: run.id };
    }
    this.activeRunAbortControllers.delete(run.id);
    cancelSignal?.removeEventListener('abort', relayCancel);
    stopHeartbeat();
    this.updateRunLifecycle({
      runId: run.id,
      state: 'finishing',
      reason: 'provider process completed; parsing response',
    });

    if (this.deps.resumeCliSessions && reply.sessionId) {
      upsertCliSessionId(this.deps.db, roomId, agentId, reply.sessionId);
    }
    const rawText = reply.text.trim();
    this.recordRunAction({
      roomId,
      taskId: activeTask?.id ?? null,
      runId: run.id,
      agentId,
      kind: 'adapter',
      status: 'completed',
      label: 'agent process completed',
      detail: `${rawText.length} reply chars`,
    });
    this.recordDiagnosticActions(
      roomId,
      activeTask?.id ?? null,
      run.id,
      agentId,
      reply.raw.stdout,
      reply.raw.stderr,
    );
    const extractedDrafts = extractDraftArtifacts(rawText);
    const text = extractedDrafts.visibleText;
    if (extractedDrafts.drafts.length > 0) {
      for (const draft of extractedDrafts.drafts) {
        if (!this.deps.contextDir) {
          this.recordRunAction({
            roomId,
            taskId: activeTask?.id ?? null,
            runId: run.id,
            agentId,
            kind: 'diagnostic',
            status: 'failed',
            label: 'draft artifact dropped',
            detail: `${draft.name}: context artifact directory is disabled`,
          });
          continue;
        }
        const stored = writeDraftArtifact({
          contextDir: this.deps.contextDir,
          roomId,
          agentId,
          runId: run.id,
          draft,
        });
        this.recordRunAction({
          roomId,
          taskId: activeTask?.id ?? null,
          runId: run.id,
          agentId,
          kind: 'diagnostic',
          status: 'completed',
          label: 'draft artifact stored',
          detail: `${stored.chars} chars for ${stored.target || stored.name}: ${stored.path}`,
        });
      }
    }
    const extractedMissionCreates = extractMissionCreateUpdates(text);
    const createdMission = this.applyMissionCreateUpdates({
      roomId,
      activeTask: activeTask ?? null,
      runId: run.id,
      agentId,
      updates: extractedMissionCreates.updates,
    });
    const missionTask = createdMission ?? activeTask ?? null;
    const extractedMissionPlans = extractMissionPlanUpdates(extractedMissionCreates.visibleText);
    const sameTurnPlan = this.applyMissionPlanUpdates({
      roomId,
      task: missionTask,
      runId: run.id,
      agentId,
      updates: extractedMissionPlans.updates,
    });
    const defaultPlan =
      sameTurnPlan ??
      (missionTask
        ? (listTaskPlans(this.deps.db, missionTask.id).find((plan) => plan.status === 'active') ??
          null)
        : null);
    const extractedMissionPhases = extractMissionPhaseUpdates(extractedMissionPlans.visibleText);
    this.applyMissionPhaseUpdates({
      roomId,
      task: missionTask,
      runId: run.id,
      agentId,
      updates: extractedMissionPhases.updates,
      defaultPlanId: defaultPlan?.id ?? null,
      forcePlanOnUpdates: sameTurnPlan !== null,
    });
    const extractedMissionTasks = extractMissionTaskUpdates(extractedMissionPhases.visibleText);
    this.applyMissionTaskUpdates({
      roomId,
      task: missionTask,
      runId: run.id,
      agentId,
      updates: extractedMissionTasks.updates,
      defaultPlanId: defaultPlan?.id ?? null,
      forcePlanOnUpdates: sameTurnPlan !== null,
    });
    const extractedMissionReceipts = extractMissionReceipts(extractedMissionTasks.visibleText);
    this.recordMissionReceipts({
      roomId,
      task: missionTask,
      runId: run.id,
      agentId,
      receipts: extractedMissionReceipts.receipts,
    });
    const missionStateUpdateCount =
      extractedMissionCreates.updates.length +
      extractedMissionPlans.updates.length +
      extractedMissionPhases.updates.length +
      extractedMissionTasks.updates.length;
    const missionReceiptCount = extractedMissionReceipts.receipts.length;
    const textAfterMissionReceipts = extractedMissionReceipts.visibleText;
    const reconciliation = this.reconcileMissionState({
      roomId,
      task: missionTask,
      runId: run.id,
      agentId,
      receipts: extractedMissionReceipts.receipts,
      visibleText: textAfterMissionReceipts,
      workLane,
      explicitMissionUpdates: missionStateUpdateCount,
    });
    if (textAfterMissionReceipts.length === 0) {
      const hiddenMissionUpdateCount =
        missionStateUpdateCount + missionReceiptCount + reconciliation.applied;
      const status = hiddenMissionUpdateCount > 0 ? 'completed' : 'empty';
      const emptyRun = updateAgentRun(this.deps.db, run.id, {
        status,
        completedAt: Date.now(),
        stdout: reply.raw.stdout,
        stderr: reply.raw.stderr,
        replyText: rawText,
        cliSessionId: reply.sessionId,
        lifecycleState: 'succeeded',
        lifecycleReason:
          hiddenMissionUpdateCount > 0
            ? 'mission control updates stored without visible chat text'
            : 'agent declined to add a chat message',
      });
      if (emptyRun) this.emit('agentRunUpdated', emptyRun);
      this.recordRunAction({
        roomId,
        taskId: missionTask?.id ?? null,
        runId: run.id,
        agentId,
        kind: hiddenMissionUpdateCount > 0 ? 'ledger' : 'message',
        status: 'info',
        label: hiddenMissionUpdateCount > 0 ? 'mission control update only' : 'empty reply',
        detail:
          hiddenMissionUpdateCount > 0
            ? 'mission control updates stored without visible chat text'
            : 'agent declined to add a chat message',
      });
      completeAgentJob(this.deps.db, agentJob.id);
      return {
        message: null,
        progressed: hiddenMissionUpdateCount > 0 || extractedDrafts.drafts.length > 0,
        runId: run.id,
      };
    }
    const extractedPermission = extractPermissionRequest(textAfterMissionReceipts, agentId);
    if (extractedPermission) {
      const permissionRequest = extractedPermission.request;
      const visiblePermissionText = extractCollaborationNotes(extractedPermission.visibleText);
      const cleanedVisibleText = cleanVisibleAgentMessage(
        agentId,
        visiblePermissionText.visibleText,
      );
      const message = cleanedVisibleText
        ? this.appendDirect(roomId, agentId, 'agent', cleanedVisibleText)
        : null;
      this.storeCollaborationNotes({
        roomId,
        taskId: missionTask?.id ?? null,
        runId: run.id,
        messageId: message?.id ?? null,
        agentId,
        notes: visiblePermissionText.notes,
      });
      if (message) {
        this.recordRunAction({
          roomId,
          taskId: missionTask?.id ?? null,
          runId: run.id,
          agentId,
          kind: 'message',
          status: 'completed',
          label: 'message emitted',
          detail: message.text,
        });
      }
      if (effectivePermission?.source === 'yolo') {
        const completedRun = updateAgentRun(this.deps.db, run.id, {
          status: 'completed',
          replyMessageId: message?.id ?? null,
          completedAt: Date.now(),
          stdout: reply.raw.stdout,
          stderr: reply.raw.stderr,
          replyText: rawText,
          cliSessionId: reply.sessionId,
          lifecycleState: 'succeeded',
          lifecycleReason: 'YOLO permission request auto-approved',
        });
        if (completedRun) this.emit('agentRunUpdated', completedRun);
        this.recordRunAction({
          roomId,
          taskId: missionTask?.id ?? null,
          runId: run.id,
          agentId,
          kind: 'permission',
          status: 'completed',
          label: `${permissionRequest.mode} permission auto-approved in YOLO`,
          detail: `${permissionRequest.target}: ${permissionRequest.reason}`,
        });
        completeAgentJob(this.deps.db, agentJob.id);
        if (yoloPermissionAutoApprovals >= YOLO_PERMISSION_AUTO_APPROVAL_LIMIT) {
          this.recordRunAction({
            roomId,
            taskId: missionTask?.id ?? null,
            runId: run.id,
            agentId,
            kind: 'permission',
            status: 'failed',
            label: 'YOLO auto-approval limit reached',
            detail: `Stopped auto-following permission requests after ${YOLO_PERMISSION_AUTO_APPROVAL_LIMIT} consecutive YOLO approvals for this turn.`,
          });
          return {
            message,
            progressed: Boolean(message) || reconciliation.applied > 0,
            runId: run.id,
          };
        }
        const autoPermission = this.buildYoloAutoApprovedPermissionGrant(
          agentId,
          permissionRequest,
          effectivePermission,
        );
        return this.runAgentReply(
          roomId,
          agentId,
          trigger,
          discussion,
          autoPermission,
          cancelSignal,
          yoloPermissionAutoApprovals + 1,
          workLane,
          attempt,
          retryOfRunId,
        );
      }
      const request = addPermissionRequest(this.deps.db, {
        roomId,
        agentId,
        ...permissionRequest,
      });
      const permissionRun = updateAgentRun(this.deps.db, run.id, {
        status: 'permission-requested',
        replyMessageId: message?.id ?? null,
        completedAt: Date.now(),
        stdout: reply.raw.stdout,
        stderr: reply.raw.stderr,
        replyText: rawText,
        cliSessionId: reply.sessionId,
        lifecycleState: 'released',
        lifecycleReason: `${permissionRequest.mode} permission requested; waiting on human approval`,
      });
      if (permissionRun) this.emit('agentRunUpdated', permissionRun);
      this.recordRunAction({
        roomId,
        taskId: missionTask?.id ?? null,
        runId: run.id,
        agentId,
        kind: 'permission',
        status: 'info',
        label: `${permissionRequest.mode} permission requested`,
        detail: `${permissionRequest.target}: ${permissionRequest.reason}`,
      });
      this.emit('permissionRequestCreated', request);
      completeAgentJob(this.deps.db, agentJob.id);
      return { message: null, progressed: false, runId: run.id };
    }
    if (
      missionTask &&
      missionStateUpdateCount === 0 &&
      missionReceiptCount === 0 &&
      reconciliation.applied === 0
    ) {
      this.recordMissingMissionReceipt({
        roomId,
        task: missionTask,
        runId: run.id,
        agentId,
      });
    }
    const extracted = extractCollaborationNotes(textAfterMissionReceipts);
    const visibleText = cleanVisibleAgentMessage(agentId, extracted.visibleText);
    const message = visibleText ? this.appendDirect(roomId, agentId, 'agent', visibleText) : null;
    this.storeCollaborationNotes({
      roomId,
      taskId: missionTask?.id ?? null,
      runId: run.id,
      messageId: message?.id ?? null,
      agentId,
      notes: extracted.notes,
    });
    const completedRun = updateAgentRun(this.deps.db, run.id, {
      status: 'completed',
      replyMessageId: message?.id ?? null,
      completedAt: Date.now(),
      stdout: reply.raw.stdout,
      stderr: reply.raw.stderr,
      replyText: rawText,
      cliSessionId: reply.sessionId,
      lifecycleState: 'succeeded',
      lifecycleReason: message
        ? 'message emitted'
        : 'collaboration note stored without visible chat text',
    });
    if (completedRun) this.emit('agentRunUpdated', completedRun);
    this.recordRunAction({
      roomId,
      taskId: missionTask?.id ?? null,
      runId: run.id,
      agentId,
      kind: message ? 'message' : 'ledger',
      status: 'completed',
      label: message ? 'message emitted' : 'ledger-only reply',
      detail: message ? message.text : 'collaboration note stored without visible chat text',
    });
    completeAgentJob(this.deps.db, agentJob.id);
    return {
      message,
      progressed: Boolean(message) || extracted.notes.length > 0 || reconciliation.applied > 0,
      runId: run.id,
    };
  }

  private async runAgentCompaction(input: {
    roomId: string;
    taskId: string | null;
    runId: string;
    agentId: AgentId;
    spec: AgentSpec;
    sessionId: string;
  }): Promise<void> {
    let lastProviderSignalAt = 0;
    const recordProviderSignal = this.buildProviderSignalRecorder({
      roomId: input.roomId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      onSignal: () => {
        lastProviderSignalAt = Date.now();
      },
    });
    const stopHeartbeat = this.startRunHeartbeat({
      roomId: input.roomId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      startedAt: Date.now(),
      latestProviderSignalAt: () => lastProviderSignalAt,
    });
    const runAbortController = new AbortController();
    this.activeRunAbortControllers.set(input.runId, {
      roomId: input.roomId,
      controller: runAbortController,
    });

    let reply: AgentReply;
    try {
      reply = await this.deps.runAgent(
        input.spec,
        COMPACT_PROMPT,
        input.sessionId,
        undefined,
        runAbortController.signal,
        recordProviderSignal,
      );
    } catch (err) {
      this.activeRunAbortControllers.delete(input.runId);
      stopHeartbeat();
      const errMsg = err instanceof Error ? err.message : String(err);
      const raw = rawOutputFromError(err);
      const canceled = err instanceof Error && err.name === 'SubprocessCanceledError';
      const failedRun = updateAgentRun(this.deps.db, input.runId, {
        status: 'failed',
        completedAt: Date.now(),
        error: errMsg,
        stdout: raw.stdout,
        stderr: raw.stderr,
        lifecycleState: canceled ? 'canceled_by_reconciliation' : 'failed',
        lifecycleReason: errMsg,
      });
      if (failedRun) this.emit('agentRunUpdated', failedRun);
      this.recordDiagnosticActions(
        input.roomId,
        input.taskId,
        input.runId,
        input.agentId,
        raw.stdout,
        raw.stderr,
      );
      this.recordRunAction({
        roomId: input.roomId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'error',
        status: 'failed',
        label: canceled ? 'compaction canceled' : 'compaction failed',
        detail: errMsg,
      });
      void this.drainQueuedHumanMessages(input.roomId);
      return;
    }

    this.activeRunAbortControllers.delete(input.runId);
    stopHeartbeat();
    this.updateRunLifecycle({
      runId: input.runId,
      state: 'finishing',
      reason: 'provider process completed; parsing compaction result',
    });
    if (this.deps.resumeCliSessions && reply.sessionId) {
      upsertCliSessionId(this.deps.db, input.roomId, input.agentId, reply.sessionId);
    }
    const completedRun = updateAgentRun(this.deps.db, input.runId, {
      status: 'completed',
      completedAt: Date.now(),
      stdout: reply.raw.stdout,
      stderr: reply.raw.stderr,
      replyText: reply.text.trim(),
      cliSessionId: reply.sessionId,
      lifecycleState: 'succeeded',
      lifecycleReason: 'context compacted',
    });
    if (completedRun) this.emit('agentRunUpdated', completedRun);
    this.recordDiagnosticActions(
      input.roomId,
      input.taskId,
      input.runId,
      input.agentId,
      reply.raw.stdout,
      reply.raw.stderr,
    );
    const warning = providerCompactionWarning(input.agentId, reply.raw.stderr);
    this.recordRunAction({
      roomId: input.roomId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'run',
      status: 'completed',
      label: warning ? 'context compacted with provider warning' : 'context compacted',
      detail: warning
        ? warning
        : reply.sessionId
          ? `session ${reply.sessionId} compacted`
          : 'provider completed compaction without returning a session id',
    });
    void this.drainQueuedHumanMessages(input.roomId);
  }

  private recordRunAction(input: CreateAgentRunActionInput): AgentRunAction {
    const action = createAgentRunAction(this.deps.db, input);
    this.emit('agentRunActionCreated', action);
    return action;
  }

  private agentJobLeaseOwner(): string {
    return `fireside:${process.pid}`;
  }

  private buildAgentJobWorkPacket(input: {
    task: Task | null;
    taskContext: unknown;
    workLane: WorkLaneAssignment | undefined;
    permission: PermissionGrant | undefined;
    discussion: DiscussionTurn | undefined;
    promptStats: {
      promptChars: number;
      estimatedPromptTokens: number;
      historyMessagesIncluded: number;
      historyMessagesDroppedByCount: number;
      historyMessagesDroppedByBudget: number;
      latestMessageChars: number;
      maxPromptChars: number | null;
      latestMessageTruncated: boolean;
    };
  }): unknown {
    return {
      mission: input.task
        ? {
            id: input.task.id,
            title: input.task.title,
            status: input.task.status,
            repoPath: input.task.repoPath,
            capabilityProfile: input.task.capabilityProfile,
          }
        : null,
      taskContext: input.taskContext,
      assignedItem: input.workLane
        ? {
            id: input.workLane.item.id,
            title: input.workLane.item.title,
            status: input.workLane.item.status,
            phaseId: input.workLane.item.phaseId,
            planId: input.workLane.item.planId,
            ownerAgentId: input.workLane.item.ownerAgentId,
            dependencyIds: input.workLane.item.dependencyIds,
            expectedTouches: input.workLane.item.expectedTouches,
            parallelism: input.workLane.item.parallelism,
            conflictGroup: input.workLane.item.conflictGroup,
            workRole: input.workLane.item.workRole,
          }
        : null,
      permission: input.permission
        ? {
            mode: input.permission.mode,
            source: input.permission.source ?? 'explicit',
            target: input.permission.target,
            capabilities: input.permission.capabilities ?? [],
            filesystemScope: input.permission.filesystemScope ?? '',
            web: input.permission.web === true,
          }
        : { mode: 'plan', source: 'default', capabilities: ['read'] },
      discussion: input.discussion ?? null,
      promptStats: input.promptStats,
      expected: [
        'provider run should either emit a visible message or an empty/no-op reply',
        'mission state changes should reconcile into checklist, phase, plan, receipt, or collaboration records',
      ],
    };
  }

  private recordMissionWorkPacket(input: {
    roomId: string;
    task: Task | null;
    runId: string;
    agentId: AgentId;
    permission: PermissionGrant | undefined;
    workLane: WorkLaneAssignment | undefined;
    discussion: DiscussionTurn | undefined;
  }): void {
    if (!input.task) return;
    const control = this.buildTaskControl(input.task);
    this.recordRunAction({
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: 'info',
      label: 'mission work packet',
      detail: JSON.stringify({
        mission: {
          id: input.task.id,
          title: input.task.title,
          status: input.task.status,
        },
        phase: control.currentPhase
          ? {
              id: control.currentPhase.id,
              title: control.currentPhase.title,
              status: control.currentPhase.status,
            }
          : null,
        assignedItem: input.workLane
          ? {
              id: input.workLane.item.id,
              title: input.workLane.item.title,
              status: input.workLane.item.status,
              expectedTouches: input.workLane.item.expectedTouches,
              parallelism: input.workLane.item.parallelism,
              conflictGroup: input.workLane.item.conflictGroup,
              workRole: input.workLane.item.workRole,
            }
          : null,
        permission: input.permission
          ? {
              mode: input.permission.mode,
              source: input.permission.source ?? 'explicit',
              capabilities: input.permission.capabilities ?? [],
              target: input.permission.target,
            }
          : { mode: 'plan', source: 'default', capabilities: ['read'] },
        turn: input.discussion
          ? {
              mode: input.discussion.mode ?? 'normal',
              round: input.discussion.round,
              maxRounds: input.discussion.maxRounds,
              repliesUsed: input.discussion.repliesUsed,
              maxRepliesPerAgent: input.discussion.maxRepliesPerAgent,
              totalRepliesUsed: input.discussion.totalRepliesUsed ?? 0,
              maxTotalReplies:
                input.discussion.maxTotalReplies ?? input.discussion.maxRepliesPerAgent,
            }
          : null,
        expected: [
          'send a visible status when useful work occurred',
          'update Mission Control when checklist, phase, blocker, or plan state changes',
        ],
      }),
    });
  }

  private updateRunLifecycle(input: {
    runId: string;
    state: AgentRunLifecycleState;
    reason?: string;
    lastSignalAt?: number;
    retryAfter?: number;
  }): AgentRunSummary | null {
    const updated = updateAgentRun(this.deps.db, input.runId, {
      lifecycleState: input.state,
      lifecycleReason: input.reason ?? '',
      lifecycleUpdatedAt: Date.now(),
      ...(input.lastSignalAt !== undefined ? { lastSignalAt: input.lastSignalAt } : {}),
      ...(input.retryAfter !== undefined ? { retryAfter: input.retryAfter } : {}),
    });
    if (updated) this.emit('agentRunUpdated', updated);
    return updated;
  }

  private recordMissionReceipts(input: {
    roomId: string;
    task: Task | null;
    runId: string;
    agentId: AgentId;
    receipts: ParsedMissionReceipt[];
  }): void {
    if (input.receipts.length === 0) return;
    if (!input.task) {
      for (const receipt of input.receipts) {
        this.recordRunAction({
          roomId: input.roomId,
          taskId: null,
          runId: input.runId,
          agentId: input.agentId,
          kind: 'diagnostic',
          status: 'failed',
          label: 'mission receipt ignored',
          detail: this.missionReceiptDetail(receipt, 'No active mission exists for this receipt.'),
        });
      }
      return;
    }

    for (const receipt of input.receipts) {
      const actionStatus: CreateAgentRunActionInput['status'] =
        receipt.status === 'completed'
          ? 'completed'
          : receipt.status === 'blocked'
            ? 'failed'
            : 'info';
      this.recordRunAction({
        roomId: input.roomId,
        taskId: input.task.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'ledger',
        status: actionStatus,
        label: `mission receipt: ${receipt.status}`,
        detail: this.missionReceiptDetail(receipt),
      });
    }
  }

  private reconcileMissionState(input: {
    roomId: string;
    task: Task | null;
    runId: string;
    agentId: AgentId;
    receipts: ParsedMissionReceipt[];
    visibleText: string;
    workLane: WorkLaneAssignment | undefined;
    explicitMissionUpdates: number;
  }): MissionReconciliationResult {
    const result: MissionReconciliationResult = {
      applied: 0,
      receiptUpdates: 0,
      laneUpdates: 0,
    };
    if (!input.task) return result;
    const task = input.task;

    const receiptTouchedItems = new Set<string>();
    for (const receipt of input.receipts) {
      const item = this.resolveReceiptChecklistItem(task, receipt, input.workLane);
      if (item) {
        const updated = this.reconcileChecklistItemFromReceipt({
          roomId: input.roomId,
          task,
          runId: input.runId,
          agentId: input.agentId,
          item,
          receipt,
        });
        if (updated > 0) {
          result.applied += updated;
          result.receiptUpdates += updated;
          receiptTouchedItems.add(item.id);
        }
      }

      const phase = receipt.phaseRef
        ? this.resolvePhase(listTaskPhases(this.deps.db, task.id), receipt.phaseRef)
        : null;
      if (phase) {
        const updated = this.reconcilePhaseFromReceipt({
          roomId: input.roomId,
          task,
          runId: input.runId,
          agentId: input.agentId,
          phase,
          receipt,
        });
        if (updated > 0) {
          result.applied += updated;
          result.receiptUpdates += updated;
        }
      }
    }

    if (
      input.workLane &&
      input.explicitMissionUpdates === 0 &&
      !receiptTouchedItems.has(input.workLane.item.id)
    ) {
      const updated = this.reconcileWorkLaneFromVisibleText(input);
      if (updated > 0) {
        result.applied += updated;
        result.laneUpdates += updated;
      }
    }

    const phaseUpdates = this.reconcilePhasesFromChecklist(input);
    if (phaseUpdates > 0) {
      result.applied += phaseUpdates;
      result.receiptUpdates += phaseUpdates;
    }

    if (result.applied > 0) {
      this.recordRunAction({
        roomId: input.roomId,
        taskId: task.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'ledger',
        status: 'completed',
        label: 'mission state reconciled',
        detail: JSON.stringify(result),
      });
      const updatedTask = getTask(this.deps.db, task.id);
      if (updatedTask) this.emit('taskUpdated', updatedTask);
    }

    return result;
  }

  private resolveReceiptChecklistItem(
    task: Task,
    receipt: ParsedMissionReceipt,
    workLane: WorkLaneAssignment | undefined,
  ): TaskChecklistItem | null {
    const items = listTaskChecklistItems(this.deps.db, task.id);
    if (receipt.itemRef) return this.resolveChecklistItem(items, receipt.itemRef);
    const canUseAssignedLane =
      workLane &&
      !receipt.phaseRef &&
      !receipt.planRef &&
      ['completed', 'blocked', 'needs_review', 'continuing'].includes(receipt.status);
    if (!canUseAssignedLane) return null;
    return getTaskChecklistItem(this.deps.db, workLane.item.id);
  }

  private reconcileChecklistItemFromReceipt(input: {
    roomId: string;
    task: Task;
    runId: string;
    agentId: AgentId;
    receipt: ParsedMissionReceipt;
    item: TaskChecklistItem;
  }): number {
    const note = this.missionReceiptPlainNote(input.receipt);
    const patch: UpdateTaskChecklistItemInput = { updatedBy: input.agentId };
    let noteKind: 'status' | 'completion' | 'blocker' | 'council' = 'status';
    let label = '';

    if (input.receipt.status === 'completed') {
      if (input.item.status === 'done') return 0;
      patch.status = 'done';
      patch.statusNote = note || `${input.item.title}: completed`;
      patch.blockedReason = '';
      patch.councilRequired = false;
      noteKind = 'completion';
      label = 'reconciled checklist completion';
    } else if (input.receipt.status === 'blocked') {
      if (input.item.status === 'blocked' && !note) return 0;
      patch.status = 'blocked';
      patch.blockedReason = note || `${input.item.title}: blocked`;
      patch.councilRequired = this.receiptNeedsCouncil(input.receipt);
      noteKind = patch.councilRequired ? 'council' : 'blocker';
      label = 'reconciled checklist blocker';
    } else if (input.receipt.status === 'continuing' || input.receipt.status === 'needs_review') {
      if (!note && input.item.ownerAgentId) return 0;
      if (!input.item.ownerAgentId) patch.ownerAgentId = input.agentId;
      if (note) patch.statusNote = note;
      noteKind = 'status';
      label =
        input.receipt.status === 'needs_review'
          ? 'reconciled checklist review note'
          : 'reconciled checklist status note';
    } else {
      return 0;
    }

    const updated = updateTaskChecklistItem(this.deps.db, input.item.id, patch);
    if (!updated) return 0;
    if (note || input.receipt.status === 'completed' || input.receipt.status === 'blocked') {
      createTaskChecklistNote(this.deps.db, {
        taskId: input.task.id,
        itemId: updated.id,
        authorId: input.agentId,
        kind: noteKind,
        body: (note || `${updated.title}: ${updated.status}`).slice(0, 4000),
      });
    }
    this.recordRunAction({
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: input.receipt.status === 'blocked' ? 'failed' : 'completed',
      label,
      detail: `${updated.title} (${updated.status})`,
    });
    return 1;
  }

  private reconcilePhaseFromReceipt(input: {
    roomId: string;
    task: Task;
    runId: string;
    agentId: AgentId;
    receipt: ParsedMissionReceipt;
    phase: TaskPhase;
  }): number {
    const status =
      input.receipt.status === 'completed'
        ? 'done'
        : input.receipt.status === 'blocked'
          ? 'blocked'
          : null;
    if (!status || input.phase.status === status) return 0;
    const updated = updateTaskPhase(this.deps.db, input.phase.id, { status });
    if (!updated) return 0;
    this.recordRunAction({
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: status === 'blocked' ? 'failed' : 'completed',
      label: status === 'done' ? 'reconciled phase completion' : 'reconciled phase blocker',
      detail: `${updated.title} (${updated.status})`,
    });
    if (status === 'done') {
      this.autoAdvancePhase({
        roomId: input.roomId,
        task: input.task,
        runId: input.runId,
        agentId: input.agentId,
        completedPhase: updated,
      });
    }
    return 1;
  }

  private reconcileWorkLaneFromVisibleText(input: {
    roomId: string;
    task: Task | null;
    runId: string;
    agentId: AgentId;
    visibleText: string;
    workLane: WorkLaneAssignment | undefined;
  }): number {
    if (!input.task || !input.workLane) return 0;
    const item = getTaskChecklistItem(this.deps.db, input.workLane.item.id);
    if (!item || item.status === 'done' || item.status === 'skipped') return 0;
    const signal = this.workLaneSignal(input.visibleText);
    if (signal === 'none') return 0;
    const note = oneLine(input.visibleText || `${item.title}: ${signal}`, 500);
    const patch: UpdateTaskChecklistItemInput = {
      updatedBy: input.agentId,
      ownerAgentId: item.ownerAgentId || input.agentId,
    };
    if (signal === 'done') {
      patch.status = 'done';
      patch.statusNote = note || `${item.title}: completed`;
      patch.blockedReason = '';
      patch.councilRequired = false;
    } else {
      patch.status = 'blocked';
      patch.blockedReason = note || `${item.title}: blocked`;
      patch.councilRequired =
        /\b(human|council|decision|intervene|intervention|approval|permission)\b/i.test(
          input.visibleText,
        );
    }
    const updated = updateTaskChecklistItem(this.deps.db, item.id, patch);
    if (!updated) return 0;
    createTaskChecklistNote(this.deps.db, {
      taskId: input.task.id,
      itemId: updated.id,
      authorId: input.agentId,
      kind: signal === 'done' ? 'completion' : patch.councilRequired ? 'council' : 'blocker',
      body: (note || `${updated.title}: ${updated.status}`).slice(0, 4000),
    });
    this.recordRunAction({
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: signal === 'done' ? 'completed' : 'failed',
      label: signal === 'done' ? 'reconciled lane completion' : 'reconciled lane blocker',
      detail: `${updated.title} (${updated.status})`,
    });
    return 1;
  }

  private reconcilePhasesFromChecklist(input: {
    roomId: string;
    task: Task | null;
    runId: string;
    agentId: AgentId;
  }): number {
    if (!input.task) return 0;
    const phases = listTaskPhases(this.deps.db, input.task.id);
    const items = listTaskChecklistItems(this.deps.db, input.task.id);
    let applied = 0;
    for (const phase of phases) {
      if (phase.status === 'done' || phase.status === 'planned') continue;
      const phaseItems = items.filter((item) => item.phaseId === phase.id);
      if (phaseItems.length === 0) continue;
      if (!phaseItems.every((item) => item.status === 'done' || item.status === 'skipped')) {
        continue;
      }
      const updated = updateTaskPhase(this.deps.db, phase.id, { status: 'done' });
      if (!updated) continue;
      applied += 1;
      this.recordRunAction({
        roomId: input.roomId,
        taskId: input.task.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'ledger',
        status: 'completed',
        label: 'reconciled phase from checklist',
        detail: `${updated.title} done; all ${phaseItems.length} checklist item(s) are closed`,
      });
      this.autoAdvancePhase({
        roomId: input.roomId,
        task: input.task,
        runId: input.runId,
        agentId: input.agentId,
        completedPhase: updated,
      });
    }
    return applied;
  }

  private missionReceiptPlainNote(receipt: ParsedMissionReceipt): string {
    return [
      receipt.summary,
      receipt.evidence ? `Evidence: ${receipt.evidence}` : '',
      receipt.next ? `Next: ${receipt.next}` : '',
    ]
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  private receiptNeedsCouncil(receipt: ParsedMissionReceipt): boolean {
    return /\b(human|council|decision|intervene|intervention|approval|permission|blocked by matt|waiting for matt)\b/i.test(
      [receipt.summary, receipt.evidence, receipt.next].filter(Boolean).join(' '),
    );
  }

  private workLaneSignal(text: string): 'done' | 'blocked' | 'none' {
    const normalized = text.toLowerCase();
    if (!normalized.trim()) return 'none';
    if (
      /\b(blocked|stuck|unable|can't|cannot|could not|failed|failing|waiting on|waiting for|needs human|need human|requires human|requires council|permission denied)\b/.test(
        normalized,
      )
    ) {
      return 'blocked';
    }
    if (
      /\b(not done|not complete|not completed|incomplete|still pending|still open|remaining|remains|needs work|will continue|continuing next)\b/.test(
        normalized,
      )
    ) {
      return 'none';
    }
    if (
      /\b(done|complete|completed|finished|resolved|accepted|settled|merged|landed|implemented|verified|tests? pass(?:ed)?|green)\b/.test(
        normalized,
      )
    ) {
      return 'done';
    }
    return 'none';
  }

  private recordMissingMissionReceipt(input: {
    roomId: string;
    task: Task;
    runId: string;
    agentId: AgentId;
  }): void {
    this.recordRunAction({
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: 'failed',
      label: 'mission receipt missing',
      detail: JSON.stringify({
        message:
          'Agent replied during an active mission without a /mission-receipt or a mission plan, phase, checklist, or mission-create update. Mission Control could not reconcile progress from this turn.',
        status: 'missing',
      }),
    });
  }

  private missionReceiptDetail(
    receipt: ParsedMissionReceipt,
    fallback = 'Mission receipt recorded.',
  ): string {
    const refs = [
      receipt.planRef ? `plan ${receipt.planRef}` : '',
      receipt.phaseRef ? `phase ${receipt.phaseRef}` : '',
      receipt.itemRef ? `item ${receipt.itemRef}` : '',
    ].filter(Boolean);
    const message = [
      refs.length ? refs.join(' / ') : '',
      receipt.summary || receipt.evidence || receipt.next || fallback,
    ]
      .filter(Boolean)
      .join(': ');
    return JSON.stringify({
      message,
      status: receipt.status,
      ...(receipt.planRef ? { plan: receipt.planRef } : {}),
      ...(receipt.phaseRef ? { phase: receipt.phaseRef } : {}),
      ...(receipt.itemRef ? { item: receipt.itemRef } : {}),
      ...(receipt.summary ? { summary: receipt.summary } : {}),
      ...(receipt.evidence ? { evidence: receipt.evidence } : {}),
      ...(receipt.next ? { next: receipt.next } : {}),
    });
  }

  private recoverInterruptedRuns(): void {
    const recovered = recoverInterruptedAgentRuns(this.deps.db);
    for (const run of recovered) {
      createAgentRunAction(this.deps.db, {
        roomId: run.roomId,
        taskId: run.taskId,
        runId: run.id,
        agentId: run.agentId,
        kind: 'error',
        status: 'failed',
        label: 'run interrupted',
        detail: 'Fireside restarted or reloaded before this provider turn completed.',
      });
    }
  }

  private recoverInterruptedJobs(): void {
    const recovered = recoverInterruptedAgentJobs(this.deps.db);
    for (const job of recovered) {
      if (!job.runId) continue;
      createAgentRunAction(this.deps.db, {
        roomId: job.roomId,
        taskId: job.taskId,
        runId: job.runId,
        agentId: job.agentId,
        kind: 'error',
        status: 'failed',
        label: 'job lease recovered',
        detail: 'Fireside restarted before this durable agent job completed.',
      });
    }
  }

  private buildProviderSignalRecorder(input: {
    roomId: string;
    taskId: string | null;
    runId: string;
    agentId: AgentId;
    onSignal: () => void;
  }): (event: AgentStreamEvent) => void {
    let lastMessageActionAt = 0;
    let lastLabel = '';
    let lastDetail = '';
    let lastDuplicateAt = 0;
    let lastRunSignalUpdateAt = 0;
    return (event: AgentStreamEvent): void => {
      const now = Date.now();
      const label = event.label.trim() || 'provider signal';
      const detail = (event.detail ?? '').trim();
      input.onSignal();
      if (now - lastRunSignalUpdateAt >= RUN_SIGNAL_UPDATE_THROTTLE_MS) {
        lastRunSignalUpdateAt = now;
        this.updateRunLifecycle({
          runId: input.runId,
          state: 'streaming_turn',
          reason: label,
          lastSignalAt: now,
        });
      }
      if (!isVisibleProviderSignal({ label, detail })) {
        return;
      }
      const visibleDetail = readableProviderSignalDetail(detail) || detail;
      if (event.kind === 'message' && event.status === 'running') {
        if (now - lastMessageActionAt < STREAM_MESSAGE_THROTTLE_MS) return;
        lastMessageActionAt = now;
      }
      if (label === lastLabel && visibleDetail === lastDetail && now - lastDuplicateAt < 750) {
        return;
      }
      lastLabel = label;
      lastDetail = visibleDetail;
      lastDuplicateAt = now;
      this.recordRunAction({
        roomId: input.roomId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        kind: this.actionKindForProviderSignal(event),
        status: event.status,
        label,
        detail: visibleDetail,
        ...(event.contextUsage ? { contextUsage: event.contextUsage } : {}),
      });
    };
  }

  private actionKindForProviderSignal(event: AgentStreamEvent): CreateAgentRunActionInput['kind'] {
    switch (event.kind) {
      case 'message':
        return 'message';
      case 'stderr':
        return 'diagnostic';
      case 'tool':
      case 'usage':
      case 'event':
        return 'adapter';
    }
  }

  private startRunHeartbeat(input: {
    roomId: string;
    taskId: string | null;
    runId: string;
    agentJobId?: string;
    agentId: AgentId;
    startedAt: number;
    latestProviderSignalAt: () => number;
  }): () => void {
    let stopped = false;
    let stalledRecorded = false;
    const timer = setInterval(() => {
      if (stopped) return;
      const now = Date.now();
      const elapsedSeconds = Math.max(0, Math.round((now - input.startedAt) / 1000));
      const latestProviderSignalAt = input.latestProviderSignalAt();
      const idleMs =
        latestProviderSignalAt > 0 ? now - latestProviderSignalAt : now - input.startedAt;
      const detail =
        latestProviderSignalAt > 0
          ? `last provider signal ${Math.max(0, Math.round((now - latestProviderSignalAt) / 1000))}s ago; process still running`
          : `${elapsedSeconds}s elapsed; no provider stream output yet`;
      if (!stalledRecorded && idleMs >= RUN_STALL_AFTER_MS) {
        stalledRecorded = true;
        this.updateRunLifecycle({
          runId: input.runId,
          state: 'stalled',
          reason: detail,
        });
      }
      if (input.agentJobId) {
        renewAgentJobLease(this.deps.db, input.agentJobId, {
          leaseOwner: this.agentJobLeaseOwner(),
          leaseMs: AGENT_JOB_LEASE_MS,
        });
      }
      this.recordRunAction({
        roomId: input.roomId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'run',
        status: 'running',
        label: 'still working',
        detail,
      });
    }, RUN_HEARTBEAT_MS);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private recordDiagnosticActions(
    roomId: string,
    taskId: string | null,
    runId: string,
    agentId: AgentId,
    stdout: string,
    stderr: string,
  ): void {
    const diagnostics = buildRunDiagnostics(agentId, stdout, stderr);
    for (const signal of diagnostics.signals.slice(0, 12)) {
      this.recordRunAction({
        roomId,
        taskId,
        runId,
        agentId,
        kind: 'diagnostic',
        status: signal.kind === 'stderr' ? 'failed' : 'info',
        label: signal.label,
        detail: signal.detail,
      });
    }
  }

  private storeCollaborationNotes(input: {
    roomId: string;
    taskId: string | null;
    runId: string;
    messageId: string | null;
    agentId: AgentId;
    notes: ParsedCollaborationNote[];
  }): void {
    for (const note of input.notes) {
      const item = createCollaborationItem(this.deps.db, {
        roomId: input.roomId,
        taskId: input.taskId,
        messageId: input.messageId,
        runId: input.runId,
        agentId: input.agentId,
        kind: note.kind,
        status: note.status,
        confidence: note.confidence,
        title: note.title,
        target: note.target,
        body: note.body,
        evidence: note.evidence,
      });
      this.emit('collaborationItemCreated', item);
      this.recordRunAction({
        roomId: input.roomId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'ledger',
        status: 'completed',
        label: `recorded ${note.kind}`,
        detail: note.title,
      });
    }
  }

  private resolveChecklistItem(items: TaskChecklistItem[], ref: string): TaskChecklistItem | null {
    const trimmed = ref.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    return (
      items.find((item) => item.id === trimmed) ??
      items.find((item) => item.title.toLowerCase() === lower) ??
      items.find((item) => item.title.toLowerCase().startsWith(lower)) ??
      null
    );
  }

  private resolvePhaseId(phases: TaskPhase[], ref: string): string | null {
    const trimmed = ref.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    return (
      phases.find((phase) => phase.id === trimmed)?.id ??
      phases.find((phase) => phase.title.toLowerCase() === lower)?.id ??
      phases.find((phase) => phase.title.toLowerCase().startsWith(lower))?.id ??
      null
    );
  }

  private resolvePhase(phases: TaskPhase[], ref: string): TaskPhase | null {
    const phaseId = this.resolvePhaseId(phases, ref);
    return phaseId ? (phases.find((phase) => phase.id === phaseId) ?? null) : null;
  }

  private resolvePlan(plans: TaskPlan[], ref: string): TaskPlan | null {
    const trimmed = ref.trim();
    if (!trimmed) return plans.find((plan) => plan.status === 'active') ?? null;
    const lower = trimmed.toLowerCase();
    if (['active', 'current', 'current active'].includes(lower)) {
      return plans.find((plan) => plan.status === 'active') ?? null;
    }
    if (['none', 'unassigned', 'no plan'].includes(lower)) return null;
    return (
      plans.find((plan) => plan.id === trimmed) ??
      plans.find((plan) => plan.title.toLowerCase() === lower) ??
      plans.find((plan) => plan.title.toLowerCase().startsWith(lower)) ??
      null
    );
  }

  private resolvePlanId(plans: TaskPlan[], ref: string): string | null {
    return this.resolvePlan(plans, ref)?.id ?? null;
  }

  private isPlanClearRef(ref: string): boolean {
    return ['none', 'unassigned', 'no plan'].includes(ref.trim().toLowerCase());
  }

  private resolveDependencyIds(
    items: TaskChecklistItem[],
    refs: string[],
    currentItemId = '',
  ): string[] {
    return [
      ...new Set(
        refs
          .map((ref) => this.resolveChecklistItem(items, ref)?.id ?? '')
          .filter((id) => id && id !== currentItemId),
      ),
    ];
  }

  private noteKindForMissionUpdate(
    update: ParsedMissionTaskUpdate,
  ): 'status' | 'completion' | 'blocker' | 'council' {
    if (update.councilRequired === true) return 'council';
    if (this.inferChecklistCompletion(update)) return 'completion';
    return update.noteKind;
  }

  private nextPlannedPhaseAfter(phases: TaskPhase[], completedPhase: TaskPhase): TaskPhase | null {
    return (
      phases.find(
        (phase) =>
          phase.status === 'planned' &&
          (phase.sortOrder > completedPhase.sortOrder ||
            (phase.sortOrder === completedPhase.sortOrder &&
              phase.createdAt > completedPhase.createdAt)),
      ) ??
      phases.find((phase) => phase.status === 'planned') ??
      null
    );
  }

  private autoAdvancePhase(input: {
    roomId: string;
    task: Task;
    runId: string;
    agentId: AgentId;
    completedPhase: TaskPhase | null;
  }): void {
    if (!input.completedPhase) return;
    const phases = listTaskPhases(this.deps.db, input.task.id);
    if (phases.some((phase) => phase.status === 'active')) return;
    const refreshedCompleted =
      phases.find((phase) => phase.id === input.completedPhase?.id) ?? input.completedPhase;
    const nextPhase = this.nextPlannedPhaseAfter(phases, refreshedCompleted);
    if (!nextPhase) return;
    const advanced = updateTaskPhase(this.deps.db, nextPhase.id, { status: 'active' });
    if (!advanced) return;
    this.recordRunAction({
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: 'completed',
      label: 'mission phase auto-advance',
      detail: `${refreshedCompleted.title} done; ${advanced.title} active`,
    });
  }

  private inferChecklistCompletion(update: ParsedMissionTaskUpdate): boolean {
    if (update.status) return update.status === 'done';
    if (update.noteKind === 'completion') return true;
    const text = [update.note, update.statusNote].filter(Boolean).join(' ').toLowerCase();
    if (!text) return false;
    if (
      /\b(blocked|blocking|gated|gate|waiting|pending|queued|not done|not complete|incomplete|remaining|remains|needs|requires|required)\b/.test(
        text,
      )
    ) {
      return false;
    }
    return /\b(done|complete|completed|finished|resolved|accepted|settled|merged|landed)\b/.test(
      text,
    );
  }

  private applyMissionCreateUpdates(input: {
    roomId: string;
    activeTask: Task | null;
    runId: string;
    agentId: AgentId;
    updates: ParsedMissionCreateUpdate[];
  }): Task | null {
    if (input.updates.length === 0) return null;
    if (input.activeTask) {
      this.recordRunAction({
        roomId: input.roomId,
        taskId: input.activeTask.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission create ignored',
        detail: `active mission already exists: ${input.activeTask.title}`,
      });
      return null;
    }

    let created: Task | null = null;
    for (const update of input.updates) {
      if (created) {
        this.recordRunAction({
          roomId: input.roomId,
          taskId: created.id,
          runId: input.runId,
          agentId: input.agentId,
          kind: 'diagnostic',
          status: 'failed',
          label: 'mission create ignored',
          detail: `mission already created this turn: ${created.title}`,
        });
        continue;
      }

      created = this.createTask(input.roomId, {
        title: update.title.slice(0, 200),
        goal: update.goal.slice(0, 4000),
        repoPath: update.repoPath.slice(0, 2000),
        acceptanceCriteria: update.acceptanceCriteria.slice(0, 4000),
        ...(update.agents ? { agents: update.agents } : {}),
        ...(update.capabilityProfile ? { capabilityProfile: update.capabilityProfile } : {}),
        summary: update.summary.slice(0, 2000),
      });

      if (!created) {
        this.recordRunAction({
          roomId: input.roomId,
          taskId: null,
          runId: input.runId,
          agentId: input.agentId,
          kind: 'diagnostic',
          status: 'failed',
          label: 'mission create ignored',
          detail: update.title,
        });
        continue;
      }

      this.recordRunAction({
        roomId: input.roomId,
        taskId: created.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'ledger',
        status: 'completed',
        label: 'mission created',
        detail: `${created.title} (${created.capabilityProfile})`,
      });
    }

    return created;
  }

  private applyMissionPlanUpdates(input: {
    roomId: string;
    task: Task | null;
    runId: string;
    agentId: AgentId;
    updates: ParsedMissionPlanUpdate[];
  }): TaskPlan | null {
    if (input.updates.length === 0) return null;
    if (!input.task) {
      this.recordRunAction({
        roomId: input.roomId,
        taskId: null,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission plan update ignored',
        detail: 'no active mission',
      });
      return null;
    }

    let plans = listTaskPlans(this.deps.db, input.task.id);
    let lastActivePlan: TaskPlan | null = null;
    for (const update of input.updates) {
      const existing =
        update.action === 'create' ? null : this.resolvePlan(plans, update.id || update.title);
      const shouldCreate = update.action === 'create' || (!existing && update.title);
      const appliedAction = shouldCreate ? 'create' : update.action;
      const patch: UpdateTaskPlanInput = {
        ...(update.title ? { title: update.title.slice(0, 180) } : {}),
        ...(update.body ? { body: update.body.slice(0, 20_000) } : {}),
        ...(update.status ? { status: update.status } : {}),
      };

      const plan = shouldCreate
        ? createTaskPlan(this.deps.db, {
            taskId: input.task.id,
            title: update.title.slice(0, 180),
            body: update.body.slice(0, 20_000),
            status: update.status ?? 'active',
          })
        : existing
          ? updateTaskPlan(this.deps.db, existing.id, patch)
          : null;

      if (!plan) {
        this.recordRunAction({
          roomId: input.roomId,
          taskId: input.task.id,
          runId: input.runId,
          agentId: input.agentId,
          kind: 'diagnostic',
          status: 'failed',
          label: 'mission plan update ignored',
          detail: update.id || update.title || 'active plan',
        });
        continue;
      }

      plans = listTaskPlans(this.deps.db, input.task.id);
      if (plan.status === 'active') lastActivePlan = plan;
      this.recordRunAction({
        roomId: input.roomId,
        taskId: input.task.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'ledger',
        status: 'completed',
        label: `mission plan ${appliedAction}`,
        detail: `${plan.title} (${plan.status})`,
      });
    }

    const updatedTask = getTask(this.deps.db, input.task.id);
    if (updatedTask) this.emit('taskUpdated', updatedTask);
    return lastActivePlan;
  }

  private applyMissionPhaseUpdates(input: {
    roomId: string;
    task: Task | null;
    runId: string;
    agentId: AgentId;
    updates: ParsedMissionPhaseUpdate[];
    defaultPlanId: string | null;
    forcePlanOnUpdates: boolean;
  }): void {
    if (input.updates.length === 0) return;
    if (!input.task) {
      this.recordRunAction({
        roomId: input.roomId,
        taskId: null,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission phase update ignored',
        detail: 'no active mission',
      });
      return;
    }

    let phases = listTaskPhases(this.deps.db, input.task.id);
    const plans = listTaskPlans(this.deps.db, input.task.id);
    let lastCompletedPhase: TaskPhase | null = null;
    for (const update of input.updates) {
      const existing =
        update.action === 'create' ? null : this.resolvePhase(phases, update.id || update.title);
      const shouldCreate = update.action === 'create' || (!existing && update.title);
      const appliedAction = shouldCreate ? 'create' : update.action;
      const hasPlanRef = update.planRef.trim().length > 0;
      const explicitPlanId = hasPlanRef ? this.resolvePlanId(plans, update.planRef) : null;
      if (hasPlanRef && !explicitPlanId && !this.isPlanClearRef(update.planRef)) {
        this.recordRunAction({
          roomId: input.roomId,
          taskId: input.task.id,
          runId: input.runId,
          agentId: input.agentId,
          kind: 'diagnostic',
          status: 'failed',
          label: 'mission phase plan unresolved',
          detail: update.planRef,
        });
        continue;
      }
      const planId = hasPlanRef
        ? explicitPlanId
        : shouldCreate || input.forcePlanOnUpdates
          ? input.defaultPlanId
          : null;
      const patch: UpdateTaskPhaseInput = {
        ...(hasPlanRef || input.forcePlanOnUpdates ? { planId } : {}),
        ...(update.title ? { title: update.title.slice(0, 160) } : {}),
        ...(update.description ? { description: update.description.slice(0, 2000) } : {}),
        ...(update.status ? { status: update.status } : {}),
        ...(update.gate ? { gate: update.gate.slice(0, 2000) } : {}),
        ...(update.sortOrder !== null ? { sortOrder: update.sortOrder } : {}),
      };

      const phase = shouldCreate
        ? createTaskPhase(this.deps.db, {
            taskId: input.task.id,
            planId,
            title: update.title.slice(0, 160),
            description: update.description.slice(0, 2000),
            status: update.status ?? (phases.length === 0 ? 'active' : 'planned'),
            gate: update.gate.slice(0, 2000),
            sortOrder: update.sortOrder ?? phases.length + 1,
          })
        : existing
          ? updateTaskPhase(this.deps.db, existing.id, patch)
          : null;

      if (!phase) {
        this.recordRunAction({
          roomId: input.roomId,
          taskId: input.task.id,
          runId: input.runId,
          agentId: input.agentId,
          kind: 'diagnostic',
          status: 'failed',
          label: 'mission phase update ignored',
          detail: update.id || update.title || 'unknown phase',
        });
        continue;
      }

      phases = listTaskPhases(this.deps.db, input.task.id);
      if (phase.status === 'done') lastCompletedPhase = phase;
      this.recordRunAction({
        roomId: input.roomId,
        taskId: input.task.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'ledger',
        status: 'completed',
        label: `mission phase ${appliedAction}`,
        detail: `${phase.title} (${phase.status})`,
      });
    }

    this.autoAdvancePhase({
      roomId: input.roomId,
      task: input.task,
      runId: input.runId,
      agentId: input.agentId,
      completedPhase: lastCompletedPhase,
    });

    const updatedTask = getTask(this.deps.db, input.task.id);
    if (updatedTask) this.emit('taskUpdated', updatedTask);
  }

  private applyMissionTaskUpdates(input: {
    roomId: string;
    task: Task | null;
    runId: string;
    agentId: AgentId;
    updates: ParsedMissionTaskUpdate[];
    defaultPlanId: string | null;
    forcePlanOnUpdates: boolean;
  }): void {
    if (input.updates.length === 0) return;
    if (!input.task) {
      this.recordRunAction({
        roomId: input.roomId,
        taskId: null,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission task update ignored',
        detail: 'no active mission',
      });
      return;
    }

    let anyCouncilBlock = false;
    let currentItems = listTaskChecklistItems(this.deps.db, input.task.id);
    const phases = listTaskPhases(this.deps.db, input.task.id);
    const plans = listTaskPlans(this.deps.db, input.task.id);

    for (const update of input.updates) {
      const existing =
        update.action === 'create'
          ? null
          : this.resolveChecklistItem(currentItems, update.id || update.title);
      const phaseId = this.resolvePhaseId(phases, update.phaseRef);
      const phase =
        (phaseId ? (phases.find((candidate) => candidate.id === phaseId) ?? null) : null) ??
        (!update.phaseRef && existing?.phaseId
          ? (phases.find((candidate) => candidate.id === existing.phaseId) ?? null)
          : null);
      const hasPlanRef = update.planRef.trim().length > 0;
      const explicitPlanId = hasPlanRef ? this.resolvePlanId(plans, update.planRef) : null;
      if (hasPlanRef && !explicitPlanId && !this.isPlanClearRef(update.planRef)) {
        this.recordRunAction({
          roomId: input.roomId,
          taskId: input.task.id,
          runId: input.runId,
          agentId: input.agentId,
          kind: 'diagnostic',
          status: 'failed',
          label: 'mission task plan unresolved',
          detail: update.planRef,
        });
        continue;
      }
      if (hasPlanRef && explicitPlanId && phase?.planId && explicitPlanId !== phase.planId) {
        this.recordRunAction({
          roomId: input.roomId,
          taskId: input.task.id,
          runId: input.runId,
          agentId: input.agentId,
          kind: 'diagnostic',
          status: 'failed',
          label: 'mission task plan mismatch',
          detail: `${update.title || update.id}: phase belongs to ${phase.planId}, request used ${explicitPlanId}`,
        });
        continue;
      }
      const planId =
        phase?.planId ??
        (hasPlanRef
          ? explicitPlanId
          : update.action === 'create' || input.forcePlanOnUpdates
            ? input.defaultPlanId
            : null);
      const dependencyIds = this.resolveDependencyIds(
        currentItems,
        update.dependencyRefs,
        existing?.id ?? '',
      );
      const effectiveStatus =
        update.status ?? (this.inferChecklistCompletion(update) ? 'done' : null);
      const basePatch: UpdateTaskChecklistItemInput = {
        ...(hasPlanRef || phase?.planId || input.forcePlanOnUpdates ? { planId } : {}),
        ...(update.title ? { title: update.title.slice(0, 240) } : {}),
        ...(update.detail ? { detail: update.detail.slice(0, 2000) } : {}),
        ...(effectiveStatus ? { status: effectiveStatus } : {}),
        ...(update.dependencyRefs.length > 0 ? { dependencyIds } : {}),
        ...(update.expectedTouches.length > 0 ? { expectedTouches: update.expectedTouches } : {}),
        ...(update.parallelism ? { parallelism: update.parallelism } : {}),
        ...(update.conflictGroup ? { conflictGroup: update.conflictGroup.slice(0, 160) } : {}),
        ...(update.workRole ? { workRole: update.workRole.slice(0, 80) } : {}),
        ...(update.ownerAgentId ? { ownerAgentId: update.ownerAgentId.slice(0, 80) } : {}),
        ...(update.statusNote ? { statusNote: update.statusNote.slice(0, 2000) } : {}),
        ...(update.blockedReason ? { blockedReason: update.blockedReason.slice(0, 2000) } : {}),
        ...(update.councilRequired !== null ? { councilRequired: update.councilRequired } : {}),
        ...(phaseId ? { phaseId } : {}),
        updatedBy: input.agentId,
      };

      const item =
        update.action === 'create'
          ? createTaskChecklistItem(this.deps.db, {
              taskId: input.task.id,
              planId,
              phaseId,
              title: update.title.slice(0, 240),
              detail: update.detail.slice(0, 2000),
              status: effectiveStatus ?? 'open',
              dependencyIds,
              expectedTouches: update.expectedTouches,
              ...(update.parallelism ? { parallelism: update.parallelism } : {}),
              conflictGroup: update.conflictGroup.slice(0, 160),
              workRole: update.workRole.slice(0, 80),
              ownerAgentId: update.ownerAgentId.slice(0, 80),
              statusNote: update.statusNote.slice(0, 2000),
              blockedReason: update.blockedReason.slice(0, 2000),
              councilRequired: update.councilRequired === true,
              updatedBy: input.agentId,
              sortOrder: currentItems.length + 1,
            })
          : existing
            ? updateTaskChecklistItem(this.deps.db, existing.id, basePatch)
            : null;

      if (!item) {
        this.recordRunAction({
          roomId: input.roomId,
          taskId: input.task.id,
          runId: input.runId,
          agentId: input.agentId,
          kind: 'diagnostic',
          status: 'failed',
          label: 'mission task update ignored',
          detail: update.id || update.title || 'unknown item',
        });
        continue;
      }

      const noteBody =
        update.note ||
        update.statusNote ||
        update.blockedReason ||
        (effectiveStatus ? `${item.title}: ${effectiveStatus}` : '');
      if (noteBody) {
        createTaskChecklistNote(this.deps.db, {
          taskId: input.task.id,
          itemId: item.id,
          authorId: input.agentId,
          kind: this.noteKindForMissionUpdate(update),
          body: noteBody.slice(0, 4000),
        });
      }
      if (item.status === 'blocked' && item.councilRequired) anyCouncilBlock = true;
      currentItems = listTaskChecklistItems(this.deps.db, input.task.id);
      this.recordRunAction({
        roomId: input.roomId,
        taskId: input.task.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'ledger',
        status: 'completed',
        label: `mission task ${update.action}`,
        detail: `${item.title} (${item.status})`,
      });
    }

    if (anyCouncilBlock && input.task.status !== 'blocked') {
      updateTaskRepo(this.deps.db, input.task.id, {
        status: 'blocked',
        summary: input.task.summary || 'Blocked checklist item requires council action.',
      });
    }
    const updatedTask = getTask(this.deps.db, input.task.id);
    if (updatedTask) this.emit('taskUpdated', updatedTask);
  }

  private yoloStatus(state: YoloDiscussionState, active: boolean, reason?: string): YoloStatus {
    const remainingReplies = Math.max(0, state.maxTotalReplies - state.totalRepliesUsed);
    return {
      roomId: state.roomId,
      active,
      id: state.id,
      startedBy: state.startedBy,
      startedAt: state.startedAt,
      maxTotalReplies: state.maxTotalReplies,
      totalRepliesUsed: state.totalRepliesUsed,
      remainingReplies,
      cancelled: state.cancelled,
      ...(state.cancelledBy !== undefined ? { cancelledBy: state.cancelledBy } : {}),
      ...(!active ? { stoppedAt: state.cancelledAt ?? Date.now() } : {}),
      ...((reason ?? state.cancelReason) ? { reason: reason ?? state.cancelReason } : {}),
    };
  }

  private cancelYoloState(
    state: YoloDiscussionState,
    authorId: string,
    reason: YoloCancelReason,
  ): YoloStatus {
    state.cancelled = true;
    state.cancelledBy = authorId;
    state.cancelledAt = Date.now();
    state.cancelReason = reason;
    state.abortController.abort();
    const status = this.yoloStatus(state, false, reason);
    this.emit('yoloStatusUpdated', status);
    const reasonText =
      reason === 'human-interjection'
        ? `${authorId} posted a new message`
        : reason === 'replacement'
          ? `${authorId} started a new YOLO run`
          : `${authorId} clicked stop`;
    this.appendDirect(
      state.roomId,
      'system',
      'system',
      `YOLO collaboration stopped: ${reasonText}. In-flight agent turns are interrupted where possible; no further YOLO rounds will start.`,
    );
    return status;
  }

  private async append(
    roomId: string,
    authorId: string,
    authorKind: AuthorKind,
    text: string,
    discussionOptions?: DiscussionThreadOptions,
  ): Promise<Message> {
    const room = getRoom(this.deps.db, roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);

    const message = this.appendDirect(roomId, authorId, authorKind, text);

    // Direct agent appends are persisted only. Human/system messages start a
    // bounded discussion thread managed below.
    if (authorKind === 'agent') return message;

    const responders =
      discussionOptions?.responders ?? this.pickResponders(room.agents, text, authorId);
    await this.runRoomAwareDiscussionThread(roomId, room, responders, message, discussionOptions);
    return message;
  }

  /**
   * Persist a message and emit `messageAppended` without dispatching agent replies.
   * Used for broker-internal system messages (failure notifications) where fanning
   * out would create a recursion loop.
   */
  private appendDirect(
    roomId: string,
    authorId: string,
    authorKind: AuthorKind,
    text: string,
  ): Message {
    const message = addMessage(this.deps.db, { roomId, authorId, authorKind, text });
    this.emit('messageAppended', message);
    return message;
  }

  private appendQueuedHumanMessage(roomId: string, authorId: string, text: string): Message {
    const message = addMessage(this.deps.db, {
      roomId,
      authorId,
      authorKind: 'human',
      text,
      deliveryStatus: 'queued',
    });
    const queued = this.queuedHumanMessageIds.get(roomId) ?? new Set<string>();
    queued.add(message.id);
    this.queuedHumanMessageIds.set(roomId, queued);
    this.emit('messageAppended', message);
    return message;
  }

  private roomHasActiveWork(roomId: string): boolean {
    if (listRunningAgentRunsForRoom(this.deps.db, roomId).length > 0) return true;
    if (listActiveAgentJobsForRoom(this.deps.db, roomId).length > 0) return true;
    for (const active of this.activeRunAbortControllers.values()) {
      if (active.roomId === roomId && !active.controller.signal.aborted) return true;
    }
    return false;
  }

  private markQueuedMessagesDelivered(roomId: string, messages: Message[]): void {
    const queued = this.queuedHumanMessageIds.get(roomId) ?? new Set<string>();
    const deliveredIds: string[] = [];
    for (const message of messages) {
      const wasQueuedInMemory = queued.delete(message.id);
      if (wasQueuedInMemory || message.deliveryStatus === 'queued') {
        updateMessageDeliveryStatus(this.deps.db, message.id, 'delivered');
        deliveredIds.push(message.id);
      }
    }
    if (queued.size === 0) this.queuedHumanMessageIds.delete(roomId);
    const deliveredAt = Date.now();
    for (const messageId of deliveredIds) {
      this.emit('messageDeliveryUpdated', {
        roomId,
        messageId,
        deliveryStatus: 'delivered',
        deliveredAt,
      } satisfies MessageDeliveryUpdate);
    }
  }

  private withDeliveryStatus(roomId: string, message: Message): Message {
    if (
      message.authorKind === 'human' &&
      (message.deliveryStatus === 'queued' ||
        this.queuedHumanMessageIds.get(roomId)?.has(message.id))
    ) {
      return { ...message, deliveryStatus: 'queued' };
    }
    return { ...message, deliveryStatus: 'delivered' };
  }

  private latestQueuedHumanMessage(roomId: string): Message | null {
    const queuedMessages = listQueuedHumanMessages(this.deps.db, roomId);
    return queuedMessages.at(-1) ?? null;
  }

  private async drainQueuedHumanMessages(roomId: string): Promise<void> {
    if (this.drainingQueuedRooms.has(roomId) || this.roomHasActiveWork(roomId)) return;
    this.drainingQueuedRooms.add(roomId);
    try {
      const maxQueuedDrains = listQueuedHumanMessages(this.deps.db, roomId).length;
      for (
        let drained = 0;
        drained < maxQueuedDrains && !this.roomHasActiveWork(roomId);
        drained += 1
      ) {
        const message = this.latestQueuedHumanMessage(roomId);
        if (!message) return;
        const room = getRoom(this.deps.db, roomId);
        if (!room) return;
        const responders = this.pickResponders(room.agents, message.text, message.authorId);
        if (responders.length === 0) {
          this.markQueuedMessagesDelivered(roomId, [message]);
          continue;
        }
        await this.runRoomAwareDiscussionThread(roomId, room, responders, message);
      }
    } finally {
      this.drainingQueuedRooms.delete(roomId);
    }
  }

  private pickResponders(roomAgents: AgentId[], text: string, authorId: string): AgentId[] {
    const mentions = parseAgentReferences(text);
    if (mentions.length > 0) {
      return mentions.filter((m) => roomAgents.includes(m) && m !== authorId);
    }
    return roomAgents.filter((a) => a !== authorId);
  }

  private pickAgentHandoffResponders(
    roomAgents: AgentId[],
    text: string,
    authorId: AgentId,
    allowedAgents?: Set<AgentId>,
  ): AgentId[] {
    return parseAgentReferences(text).filter(
      (agentId) =>
        agentId !== authorId &&
        roomAgents.includes(agentId) &&
        (allowedAgents ? allowedAgents.has(agentId) : true),
    );
  }

  private async runAgentHandoffs(
    roomId: string,
    authorId: AgentId,
    message: Message,
  ): Promise<void> {
    const room = getRoom(this.deps.db, roomId);
    if (!room) return;
    const responders = this.pickAgentHandoffResponders(room.agents, message.text, authorId);
    if (responders.length === 0) return;
    await this.runRoomAwareDiscussionThread(roomId, room, responders, message);
  }

  private maxAgentRepliesPerThread(): number {
    const configured = this.deps.maxAgentRepliesPerThread ?? DEFAULT_MAX_AGENT_REPLIES_PER_THREAD;
    return Math.max(1, Math.floor(configured));
  }

  private latestMessage(roomId: string, fallback: Message): Message {
    const messages = listMessages(this.deps.db, roomId);
    return messages[messages.length - 1] ?? fallback;
  }

  private async runDiscussionThread(
    roomId: string,
    responders: AgentId[],
    initialTrigger: Message,
    options: DiscussionThreadOptions = {},
  ): Promise<void> {
    if (responders.length === 0) return;
    const isCancelled = (): boolean => options.yoloState?.cancelled === true;
    const room = getRoom(this.deps.db, roomId);
    const roomAgents = room?.agents ?? responders;
    const handoffPool = options.mode === 'yolo' && options.responders ? responders : roomAgents;
    const uniqueResponders = responders.filter(
      (agentId, index) => responders.indexOf(agentId) === index,
    );
    const openFloor = options.mode === 'yolo' || uniqueResponders.length > 1;

    const maxReplies = Math.max(
      1,
      Math.floor(options.maxRepliesPerAgent ?? this.maxAgentRepliesPerThread()),
    );
    const configuredMaxTotalReplies = Math.max(
      1,
      Math.floor(options.maxTotalReplies ?? maxReplies * Math.max(1, handoffPool.length)),
    );
    if (options.yoloState) {
      options.yoloState.maxTotalReplies = Math.max(
        options.yoloState.maxTotalReplies,
        configuredMaxTotalReplies,
      );
      this.emit('yoloStatusUpdated', this.yoloStatus(options.yoloState, true));
    }
    const currentMaxTotalReplies = (): number =>
      options.yoloState?.maxTotalReplies ?? configuredMaxTotalReplies;
    const currentMaxRepliesPerAgent = (): number =>
      options.mode === 'yolo' ? currentMaxTotalReplies() : maxReplies;
    const currentMaxPromptRounds = (): number =>
      options.mode === 'yolo' || handoffPool.length > 1
        ? Math.max(1, Math.min(currentMaxRepliesPerAgent(), currentMaxTotalReplies()))
        : 1;
    const knownAgents = new Set<AgentId>([...handoffPool, ...uniqueResponders]);
    const allowedAgents = new Set<AgentId>(uniqueResponders);
    const replyCounts = new Map<AgentId, number>(Array.from(knownAgents).map((id) => [id, 0]));
    let candidates = [...uniqueResponders];
    let totalReplies = options.yoloState?.totalRepliesUsed ?? 0;

    try {
      for (
        let round = 1;
        candidates.length > 0 && totalReplies < currentMaxTotalReplies();
        round++
      ) {
        if (isCancelled()) return;
        const laneAssignments =
          options.mode === 'yolo'
            ? this.assignYoloWorkLanes(
                roomId,
                handoffPool.filter(
                  (id) => (replyCounts.get(id) ?? 0) < currentMaxRepliesPerAgent(),
                ),
              )
            : new Map<AgentId, WorkLaneAssignment>();
        for (const agentId of laneAssignments.keys()) {
          allowedAgents.add(agentId);
        }
        const trigger = this.latestMessage(roomId, initialTrigger);
        const remainingTotal = currentMaxTotalReplies() - totalReplies;
        const candidateSet = new Set<AgentId>([...candidates, ...laneAssignments.keys()]);
        const eligible = Array.from(candidateSet)
          .filter((id) => (replyCounts.get(id) ?? 0) < currentMaxRepliesPerAgent())
          .slice(0, remainingTotal);
        if (eligible.length === 0) return;
        if (isCancelled()) return;

        const results = await Promise.all(
          eligible.map(async (agentId) => ({
            agentId,
            result: await this.runAgentReply(
              roomId,
              agentId,
              trigger,
              {
                round: Math.min(round, currentMaxPromptRounds()),
                maxRounds: currentMaxPromptRounds(),
                repliesUsed: replyCounts.get(agentId) ?? 0,
                maxRepliesPerAgent: currentMaxRepliesPerAgent(),
                mode: options.mode ?? 'normal',
                totalRepliesUsed: totalReplies,
                maxTotalReplies: currentMaxTotalReplies(),
              },
              options.permission,
              options.yoloState?.abortController.signal,
              0,
              laneAssignments.get(agentId),
            ),
          })),
        );
        if (isCancelled()) return;

        const activeAgents: AgentId[] = [];
        const directedAgents: AgentId[] = [];
        for (const { agentId, result } of results) {
          if (!result.progressed && !result.message) continue;
          activeAgents.push(agentId);
          replyCounts.set(agentId, (replyCounts.get(agentId) ?? 0) + 1);
          totalReplies += 1;
          if (options.yoloState) {
            options.yoloState.totalRepliesUsed = totalReplies;
            this.emit('yoloStatusUpdated', this.yoloStatus(options.yoloState, true));
          }
          if (!result.message) continue;
          const handoffs = this.pickAgentHandoffResponders(
            handoffPool,
            result.message.text,
            agentId,
          );
          for (const agentId of handoffs) {
            allowedAgents.add(agentId);
            if (!directedAgents.includes(agentId)) directedAgents.push(agentId);
          }
        }

        if (activeAgents.length === 0) return;

        const underLimit = Array.from(allowedAgents).filter(
          (id) => (replyCounts.get(id) ?? 0) < currentMaxRepliesPerAgent(),
        );
        const directedUnderLimit = directedAgents.filter(
          (id) => (replyCounts.get(id) ?? 0) < currentMaxRepliesPerAgent(),
        );
        const directedYoloAgents =
          options.mode === 'yolo'
            ? []
            : directedUnderLimit.filter((id) => room?.yoloAgents.includes(id));
        if (directedYoloAgents.length > 0) {
          const handoffTrigger = this.latestMessage(roomId, initialTrigger);
          await this.runRoomYoloDiscussionThread(
            roomId,
            handoffTrigger.authorId,
            directedYoloAgents,
            handoffTrigger,
          );
        }
        const directedNormalAgents =
          directedYoloAgents.length > 0
            ? directedUnderLimit.filter((id) => !directedYoloAgents.includes(id))
            : directedUnderLimit;
        if (directedUnderLimit.length > 0) {
          candidates = directedNormalAgents;
        } else if (!openFloor) {
          candidates = [];
        } else {
          candidates =
            options.mode !== 'yolo' && activeAgents.length === 1
              ? underLimit.filter((id) => id !== activeAgents[0])
              : underLimit;
        }
      }
    } finally {
      if (options.mode !== 'yolo' && !isCancelled()) {
        await this.drainQueuedHumanMessages(roomId);
      }
    }
  }
}
