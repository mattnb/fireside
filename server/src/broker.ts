// server/src/broker.ts
import { EventEmitter } from 'node:events';
import type { Database } from 'better-sqlite3';
import {
  addMessage,
  deleteQueuedHumanMessage,
  getMessage,
  listQueuedHumanMessages,
  listMessages,
  updateQueuedHumanMessageText,
  updateMessageDeliveryStatus,
  type Message,
  type AuthorKind,
  type MessageDeliveryStatus,
} from './repos/messages.js';
import {
  listSeenAgentsByMessage,
  recordMessageReadReceipts as recordMessageReadReceiptsRepo,
} from './repos/message-read-receipts.js';
import {
  getRoom,
  deleteRoom as deleteRoomRepo,
  listRooms,
  setRoomLeadAgent as setRoomLeadAgentRepo,
  setRoomAgents as setRoomAgentsRepo,
  type Room,
} from './repos/rooms.js';
import {
  deleteProjectRow,
  getProject,
  listRoomIdsByProject,
  setProjectArchivedAt,
  type Project,
} from './repos/projects.js';
import { deleteCliSessionId, getCliSession, upsertCliSessionId } from './repos/sessions.js';
import type { WorkLanePromptItem } from './transcript.js';
import {
  listConversationArtifacts,
  attachConversationFixture,
  removeConversationArtifact,
  type ConversationArtifactListing,
  type ConversationFixture,
} from './context-files.js';
import {
  buildPermissionGrant,
  extractPermissionRequest,
  type PermissionGrant,
  type PermissionRequest,
  type YoloPermissionProfile,
} from './permissions.js';
import {
  buildYoloPermissionGrant,
  inferYoloPermissionProfileFromText,
  normalizeYoloPermissionProfile,
  planPermissionRequestContinuation,
  yoloScopeLabel,
} from './orchestration/permission-orchestrator.js';
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
  getAgentJobByRunId,
  leaseAgentJob,
  listActiveAgentJobsForRoom,
  recoverInterruptedAgentJobs,
  renewAgentJobLease,
  type AgentJob,
} from './repos/agent-jobs.js';
import {
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
  createRoutingDecision,
  listRoutingDecisionsForRoom,
  type RoutingDecisionRecord,
} from './repos/routing-decisions.js';
import {
  createMissionCommandEvent,
  listMissionCommandEventsForRoom,
  type MissionCommandEvent,
  type MissionCommandKind,
  type MissionCommandStatus,
} from './repos/mission-command-events.js';
import {
  getAgentTurnOutcome,
  listAgentTurnOutcomesForRoom,
  recordAgentTurnOutcome,
  type AgentTurnOutcome,
  type AgentTurnOutcomeStatus,
  type RecordAgentTurnOutcomeInput,
} from './repos/turn-outcomes.js';
import {
  createMissionBriefing as createMissionBriefingRepo,
  getMissionBriefing,
  listMissionBriefings,
  type MissionBriefing,
  type MissionBriefingPayload,
  type MissionBriefingSummary,
} from './repos/briefings.js';
import { loadWorkflowProfile, type WorkflowProfile } from './workflow-profile.js';
import { getWorkspacePath } from './workspaces.js';
import type {
  AgentId,
  AgentReply,
  AgentSpec,
  AgentStreamEvent,
  ProviderId,
  RoomAgentProfile,
} from './agents/types.js';
import { logger } from './logger.js';
import { buildRunDiagnostics, type RunDiagnostics } from './run-diagnostics.js';
import { codexContextUsage, formatContextUsage } from './context-usage.js';
import { maybeSampleGeminiStatsModelQuota } from './agents/gemini-quota.js';
import { mentionAliasSlug, resolveRoomAgentReferences } from './routing/agent-references.js';
import { routeAgentMessage } from './routing/agent-message-router.js';
import { routeHumanMessage, type HumanRoutingDecision } from './routing/human-message-router.js';
import {
  routeMissionWorkUpdates,
  type MissionWorkDispatch,
} from './routing/mission-work-router.js';
import {
  applyDiscussionRoundResults,
  createDiscussionScheduler,
  currentMaxRepliesPerAgent,
  currentMaxTotalReplies,
  planDiscussionRound,
  syncDiscussionTotalBudget,
  type DiscussionResultSummary,
} from './orchestration/discussion-scheduler.js';
import {
  buildTaskParallelismSummary,
  checklistDependenciesSatisfied,
  planWorkLanes,
  workLaneConflictReason,
  workLaneScopeContract,
  type TaskParallelismSummary,
  type WorkLaneAssignment,
  type WorkLaneScopeContract,
} from './orchestration/work-lane-planner.js';
import {
  createProviderSignalProcessingState,
  describeRunHeartbeat,
  processProviderSignalEvent,
} from './orchestration/run-activity.js';
import {
  executeProviderTurn,
  rawOutputFromError,
  waitForRetryDelay,
} from './orchestration/agent-turn-executor.js';
import { prepareAgentTurnContext } from './orchestration/agent-turn-context.js';
import {
  inferRunExecutionSnapshot,
  type RunExecutionSnapshot,
} from './orchestration/run-state-machine.js';
import { evaluateMissionLiveness } from './orchestration/liveness-policy.js';
import {
  applyMissionTaskUpdates as applyMissionTaskUpdatesState,
  type MissionTaskApplyResult,
} from './mission-state/mission-task-applicator.js';
import { applyMissionCreateUpdates as applyMissionCreateUpdatesState } from './mission-state/mission-create-applicator.js';
import { applyMissionPlanUpdates as applyMissionPlanUpdatesState } from './mission-state/mission-plan-applicator.js';
import { applyMissionPhaseUpdates as applyMissionPhaseUpdatesState } from './mission-state/mission-phase-applicator.js';
import {
  autoAdvancePhase as autoAdvanceMissionPhase,
  reconcileMissionState as reconcileMissionStateReceipts,
  recordMissionReceipts as recordMissionReceiptsState,
  workLaneSignal,
  type MissionReconciliationResult,
} from './mission-state/mission-receipt-applicator.js';
import { storeCollaborationNotes as storeCollaborationNotesState } from './mission-state/collaboration-note-applicator.js';
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
import { extractAgentRosterUpdates, type ParsedAgentRosterUpdate } from './agent-roster-updates.js';
import { defaultAgentProfile, providerIdFromAgentId } from './agents/profiles.js';
import { getAgentPersona, isProviderId, providerDisplayName } from './agents/personas.js';

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
  temporaryAgentLimitPerLead?: number;
  temporaryAgentMaxTurns?: number;
  contextDir?: string;
  resumeCliSessions?: boolean;
}

const DEFAULT_MAX_AGENT_REPLIES_PER_THREAD = 5;
const YOLO_MAX_AGENT_REPLIES = 100;
const DEFAULT_TEMPORARY_AGENT_LIMIT_PER_LEAD = 3;
const DEFAULT_TEMPORARY_AGENT_MAX_TURNS = 25;
const TEMPORARY_AGENT_ORCHESTRATOR_PERSONAS = new Set(['engineering-manager', 'qa-lead']);
const DEFAULT_PROMPT_HISTORY = 16;
const DEFAULT_MAX_PROMPT_CHARS = 16_000;
const RUN_HEARTBEAT_MS = 10_000;
const RUN_STALL_AFTER_MS = 5 * 60 * 1000;
const RUN_SIGNAL_UPDATE_THROTTLE_MS = 2_500;
const STREAM_MESSAGE_THROTTLE_MS = 1_000;
const AGENT_JOB_LEASE_MS = 15 * 60 * 1000;
const COMPACT_PROMPT = '/compact';
const ACTIVE_TASK_STATUSES = new Set<Task['status']>(['active', 'blocked', 'verifying']);

interface DiscussionTurn {
  round: number;
  maxRounds: number;
  repliesUsed: number;
  maxRepliesPerAgent: number;
  mode?: 'normal' | 'yolo';
  totalRepliesUsed?: number;
  maxTotalReplies?: number;
}

interface WorkflowProfilePromptItem {
  sourcePath: string;
  promptTemplate: string;
  maxTurns: number;
  maxConcurrentAgents: number;
}

interface AgentRosterApplyResult {
  applied: number;
  followups: Array<{ agentId: AgentId; text: string; maxTurns: number }>;
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
  handoffPool?: AgentId[];
  bypassRoomYolo?: boolean;
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
  loopActive: boolean;
  cancelled: boolean;
  cancelledBy?: string;
  cancelledAt?: number;
  cancelReason?: YoloCancelReason;
  stoppedAt?: number;
  stoppedReason?: string;
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

export interface MessageReadReceiptUpdate {
  roomId: string;
  messageId: string;
  seenBy: AgentId[];
  agentId: AgentId;
  runId: string;
  seenAt: number;
}

export interface MessageRetractionUpdate {
  roomId: string;
  messageId: string;
  authorId: string;
  retractedAt: number;
}

export class QueuedMessageMutationError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'QueuedMessageMutationError';
  }
}

export interface AgentRunDetail {
  run: AgentRun;
  execution: RunExecutionSnapshot;
  outcome: AgentTurnOutcome | null;
  triggerMessage: Message | null;
  replyMessage: Message | null;
  diagnostics: RunDiagnostics;
  actions: AgentRunAction[];
}

interface AgentTurnResult {
  message: Message | null;
  progressed: boolean;
  runId?: string;
  failed?: boolean;
  error?: string;
  workDispatches?: MissionWorkDispatch[];
}

interface WorkflowContractValidation {
  violations: string[];
  repairPrompt: string;
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
  parallelism: TaskParallelismSummary;
}

function cleanVisibleAgentMessage(agentId: AgentId, text: string): string {
  const escaped = agentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(`(?:\\n\\s*)+(?:[*_~\\s]*)${escaped}(?:[*_~\\s]*)(?::|,)?\\s*$`, 'i'), '')
    .trim();
}

function isBrokerInternalSystemMessage(message: Message): boolean {
  if (message.authorKind !== 'system') return false;
  return (
    /^Permission (approved|denied) for /i.test(message.text) ||
    /^\([a-z0-9-]+ started approved /i.test(message.text) ||
    /^\([a-z0-9-]+ finished the .* follow-up without a visible chat message\.\)$/i.test(
      message.text,
    ) ||
    /^\(fireside workflow contract repair for /i.test(message.text)
  );
}

function providerCompactionWarning(agentId: AgentId, stderr: string): string | null {
  if (
    providerIdFromAgentId(agentId) === 'codex' &&
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

function compactInline(text: string, maxChars = 220): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 1)}...`;
}

function workflowRepairTaskUpdateIsProgress(update: ParsedMissionTaskUpdate): boolean {
  return update.status !== null && update.status !== 'open';
}

function missionCommandField(update: unknown, keys: string[]): string {
  if (!update || typeof update !== 'object') return '';
  const record = update as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function missionCommandAction(update: unknown): string {
  return missionCommandField(update, ['action', 'status']) || 'record';
}

function missionCommandTargetRef(update: unknown): string {
  return missionCommandField(update, [
    'id',
    'title',
    'name',
    'itemRef',
    'phaseRef',
    'planRef',
    'target',
  ]);
}

export class Broker extends EventEmitter {
  private activeYoloDiscussions = new Map<string, YoloDiscussionState>();
  private activeRunAbortControllers = new Map<
    string,
    { roomId: string; controller: AbortController }
  >();
  private queuedHumanMessageIds = new Map<string, Set<string>>();
  private drainingQueuedRooms = new Set<string>();
  private yoloLaunchRepairInFlight = new Set<string>();
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
    const inlineYoloProfile = inferYoloPermissionProfileFromText(text);
    const decision = routeHumanMessage({
      room,
      authorId,
      text,
      roomHasActiveWork: this.roomHasActiveWork(roomId),
      activeYolo: Boolean(activeYolo && !activeYolo.cancelled && !activeYolo.stoppedReason),
      busyAgents: this.busyAgentsInRoom(roomId),
      ...(inlineYoloProfile ? { inlineYoloProfile } : {}),
    });
    this.logHumanRoutingDecision(roomId, authorId, decision);

    switch (decision.action) {
      case 'direct-agent-turn':
        return this.append(roomId, authorId, 'human', text, {
          responders: decision.responders,
          bypassRoomYolo: decision.bypassRoomYolo,
        });
      case 'group-discussion':
        return this.append(roomId, authorId, 'human', text, {
          responders: decision.responders,
        });
      case 'start-yolo':
        return this.startYoloDiscussion(
          roomId,
          authorId,
          inlineYoloProfile ?? {
            mode: 'full-auto',
            filesystemScope: 'unrestricted',
            web: true,
          },
          text,
          inlineYoloProfile ? undefined : decision.yoloResponders,
        );
      case 'queue-human-message':
        return this.appendQueuedHumanMessage(roomId, authorId, text);
      case 'append-only':
        return this.append(roomId, authorId, 'human', text, {
          responders: [],
          bypassRoomYolo: true,
        });
    }
  }

  private logHumanRoutingDecision(
    roomId: string,
    authorId: string,
    decision: HumanRoutingDecision,
  ): void {
    logger.info(
      {
        roomId,
        action: decision.action,
        reason: decision.reason,
        responders: decision.responders,
        yoloResponders: decision.yoloResponders,
        bypassRoomYolo: decision.bypassRoomYolo,
        references: {
          agentIds: decision.references.agentIds,
          ambiguousAliases: decision.references.ambiguousAliases,
          explicitTokens: decision.references.explicitTokens,
        },
        trace: decision.trace,
      },
      'human message routing decision',
    );
    createRoutingDecision(this.deps.db, {
      roomId,
      authorId,
      kind: 'human-message',
      action: decision.action,
      reason: decision.reason,
      responders: decision.responders,
      trace: decision.trace,
    });
  }

  editQueuedHumanMessage(
    roomId: string,
    messageId: string,
    authorId: string,
    text: string,
  ): Message {
    const room = getRoom(this.deps.db, roomId);
    if (!room) throw new QueuedMessageMutationError(404, 'room not found');
    const trimmed = text.trim();
    if (!trimmed) throw new QueuedMessageMutationError(400, 'message text required');
    this.assertQueuedHumanMessageMutable(roomId, messageId, authorId);
    const updated = updateQueuedHumanMessageText(this.deps.db, {
      roomId,
      messageId,
      authorId,
      text: trimmed,
    });
    if (!updated) {
      throw new QueuedMessageMutationError(409, 'queued message is no longer editable');
    }
    const message = this.withDeliveryStatus(roomId, updated);
    this.emit('messageUpdated', message);
    return message;
  }

  retractQueuedHumanMessage(
    roomId: string,
    messageId: string,
    authorId: string,
  ): MessageRetractionUpdate {
    const room = getRoom(this.deps.db, roomId);
    if (!room) throw new QueuedMessageMutationError(404, 'room not found');
    this.assertQueuedHumanMessageMutable(roomId, messageId, authorId);
    const deleted = deleteQueuedHumanMessage(this.deps.db, { roomId, messageId, authorId });
    if (!deleted) {
      throw new QueuedMessageMutationError(409, 'queued message is no longer retractable');
    }
    const queued = this.queuedHumanMessageIds.get(roomId);
    queued?.delete(messageId);
    if (queued?.size === 0) this.queuedHumanMessageIds.delete(roomId);
    const update = { roomId, messageId, authorId, retractedAt: Date.now() };
    this.emit('messageRetracted', update satisfies MessageRetractionUpdate);
    return update;
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
    const launchBlocker = await this.blockYoloLaunchIfInvalid(roomId);
    if (launchBlocker) {
      return launchBlocker;
    }
    const existing = this.activeYoloDiscussions.get(roomId);
    if (existing && !existing.cancelled) {
      this.cancelYoloState(existing, authorId, 'replacement');
    }
    const yoloState = this.createYoloState(roomId, authorId);
    this.activeYoloDiscussions.set(roomId, yoloState);
    this.emit('yoloStatusUpdated', this.yoloStatus(yoloState, true));
    const activeTask = getActiveTask(this.deps.db, roomId);
    const profile = normalizeYoloPermissionProfile(profileInput);
    const permission = buildYoloPermissionGrant({ profile, activeTask });
    const yoloPool =
      room.yoloAgents.length > 0
        ? room.yoloAgents.filter((agent) => room.agents.includes(agent))
        : room.agents;
    const yoloResponders =
      respondersOverride && respondersOverride.length > 0
        ? respondersOverride.filter((agent) => yoloPool.includes(agent))
        : yoloPool;
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
        handoffPool: yoloPool,
      });
    } finally {
      if (this.activeYoloDiscussions.get(roomId)?.id === yoloState.id) {
        this.activeYoloDiscussions.delete(roomId);
      }
      if (!yoloState.cancelled && !yoloState.stoppedReason) {
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

  setProjectArchived(projectId: string, archivedAt: number | null): Project | null {
    const updated = setProjectArchivedAt(this.deps.db, projectId, archivedAt);
    if (updated) this.emit('projectUpdated', updated);
    return updated;
  }

  deleteProject(projectId: string): boolean {
    if (!getProject(this.deps.db, projectId)) return false;
    // Cascade: delete each room (their downstream tables CASCADE off rooms.id),
    // emit roomDeleted per room so attached clients drop them, then delete the
    // project row and emit projectDeleted.
    const roomIds = listRoomIdsByProject(this.deps.db, projectId);
    for (const roomId of roomIds) {
      const removed = deleteRoomRepo(this.deps.db, roomId);
      if (removed) this.emit('roomDeleted', { roomId });
    }
    const ok = deleteProjectRow(this.deps.db, projectId);
    if (ok) this.emit('projectDeleted', { projectId });
    return ok;
  }

  setAgents(
    roomId: string,
    agents: AgentId[],
    yoloAgents?: AgentId[],
    agentProfiles?: RoomAgentProfile[],
    leadAgentId?: AgentId | null,
  ): Room | null {
    setRoomAgentsRepo(this.deps.db, roomId, agents, yoloAgents, agentProfiles, leadAgentId);
    const updated = getRoom(this.deps.db, roomId);
    if (updated) {
      this.reconcileActiveTaskAgents(roomId, updated.agents);
      this.emit('roomUpdated', updated);
    }
    return updated;
  }

  setRoomLeadAgent(roomId: string, leadAgentId: AgentId | null): Room | null {
    const updated = setRoomLeadAgentRepo(this.deps.db, roomId, leadAgentId);
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
    const job = getAgentJobByRunId(this.deps.db, run.id);
    const triggerMessage = getMessage(this.deps.db, run.triggerMessageId);
    const replyMessage = run.replyMessageId ? getMessage(this.deps.db, run.replyMessageId) : null;
    return {
      run,
      execution: inferRunExecutionSnapshot({ job, run }),
      outcome: getAgentTurnOutcome(this.deps.db, run.id),
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
    const agentProfile =
      room.agentProfiles.find((profile) => profile.id === agentId) ?? defaultAgentProfile(agentId);
    if (agentProfile.providerId !== 'claude' && agentProfile.providerId !== 'codex') {
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
    const trigger = listMessages(this.deps.db, roomId, { limit: 1 }).at(-1);
    if (!trigger) {
      return {
        ok: false,
        statusCode: 409,
        error: 'manual compaction needs at least one room message to anchor the run',
      };
    }
    const task = getActiveTask(this.deps.db, roomId);
    const spec = this.deps.getSpec(agentProfile.providerId);
    if (!spec) {
      return { ok: false, statusCode: 503, error: `no adapter for agent "${agentId}"` };
    }
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
      providerId: agentProfile.providerId,
    });
    return { ok: true, run };
  }

  private getResumableCliSessionId(roomId: string, agentId: AgentId): string | null {
    const room = getRoom(this.deps.db, roomId);
    const currentProviderId =
      room?.agentProfiles.find((profile) => profile.id === agentId)?.providerId ??
      providerIdFromAgentId(agentId);
    const stored = getCliSession(this.deps.db, roomId, agentId);
    if (stored?.cliSessionId) {
      if (!stored.providerId || !currentProviderId || stored.providerId === currentProviderId) {
        return stored.cliSessionId;
      }
      deleteCliSessionId(this.deps.db, roomId, agentId);
    }

    const inferredProviderId = providerIdFromAgentId(agentId);
    if (currentProviderId && inferredProviderId && currentProviderId !== inferredProviderId) {
      return null;
    }
    const fallback = listAgentRunsRepo(this.deps.db, roomId, { limit: 200 }).find(
      (run) => run.agentId === agentId && Boolean(run.cliSessionId),
    )?.cliSessionId;
    if (!fallback) return null;

    upsertCliSessionId(this.deps.db, roomId, agentId, fallback, currentProviderId ?? '');
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

  listRoutingDecisions(roomId: string, limit = 100): RoutingDecisionRecord[] {
    return listRoutingDecisionsForRoom(this.deps.db, roomId, limit);
  }

  listMissionCommandEvents(roomId: string, limit = 100): MissionCommandEvent[] {
    return listMissionCommandEventsForRoom(this.deps.db, roomId, limit);
  }

  listTurnOutcomes(roomId: string, limit = 100): AgentTurnOutcome[] {
    return listAgentTurnOutcomesForRoom(this.deps.db, roomId, limit);
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

  private createYoloState(roomId: string, startedBy: string): YoloDiscussionState {
    return {
      id: `${Date.now()}-${++this.yoloSequence}`,
      roomId,
      startedBy,
      startedAt: Date.now(),
      maxTotalReplies: YOLO_MAX_AGENT_REPLIES,
      totalRepliesUsed: 0,
      abortController: new AbortController(),
      loopActive: false,
      cancelled: false,
    };
  }

  currentYoloStatus(roomId: string): YoloStatus | null {
    const activeYolo = this.activeYoloDiscussions.get(roomId);
    if (!activeYolo) return null;
    return this.yoloStatus(activeYolo, !activeYolo.cancelled && !activeYolo.stoppedReason);
  }

  private emptyOpenMissionPhases(task: Task): TaskPhase[] {
    const phases = listTaskPhases(this.deps.db, task.id);
    if (phases.length === 0) return [];
    const checklistItems = listTaskChecklistItems(this.deps.db, task.id);
    const itemCountsByPhase = new Map<string, number>();
    for (const item of checklistItems) {
      if (!item.phaseId) continue;
      itemCountsByPhase.set(item.phaseId, (itemCountsByPhase.get(item.phaseId) ?? 0) + 1);
    }
    return phases.filter(
      (phase) => phase.status !== 'done' && (itemCountsByPhase.get(phase.id) ?? 0) === 0,
    );
  }

  private yoloLaunchBlocker(roomId: string): string {
    const task = getActiveTask(this.deps.db, roomId);
    if (!task) return '';
    const emptyPhases = this.emptyOpenMissionPhases(task);
    if (emptyPhases.length === 0) return '';
    const phaseList = emptyPhases
      .map((phase) => `${phase.title || phase.id} [${phase.status}, id=${phase.id}]`)
      .join('; ');
    return `YOLO did not start because the active mission has empty open phase(s). Add checklist items to these phases or mark them done with evidence: ${phaseList}. Lead agent action: repair Mission Control now by adding concrete checklist items to each empty phase or closing genuinely complete phases with evidence, then report what changed.`;
  }

  private async blockYoloLaunchIfInvalid(roomId: string): Promise<Message | null> {
    const blocker = this.yoloLaunchBlocker(roomId);
    if (!blocker) return null;
    const message = this.appendDirect(roomId, 'system', 'system', blocker);
    this.emit('yoloStatusUpdated', {
      roomId,
      active: false,
      cancelled: false,
      stoppedAt: Date.now(),
      reason: 'blocked-empty-phases',
    } satisfies YoloStatus);
    await this.dispatchYoloLaunchRepair(roomId, message);
    return message;
  }

  private yoloLaunchRepairLead(room: Room): AgentId | null {
    const busy = this.busyAgentsInRoom(room.id);
    if (room.leadAgentId && room.agents.includes(room.leadAgentId) && !busy.has(room.leadAgentId)) {
      return room.leadAgentId;
    }
    const priority = new Map<string, number>([
      ['project-manager', 0],
      ['engineering-manager', 1],
      ['qa-lead', 2],
      ['technical-lead', 3],
      ['product-manager', 4],
      ['principal-software-engineer', 5],
    ]);
    const yoloSet = new Set(room.yoloAgents);
    const candidateIds = [
      ...room.yoloAgents.filter((agentId) => room.agents.includes(agentId)),
      ...room.agents,
    ];
    const candidates = candidateIds
      .filter((agentId, index) => candidateIds.indexOf(agentId) === index)
      .filter((agentId) => !busy.has(agentId))
      .map((agentId) => {
        const profile = room.agentProfiles.find((item) => item.id === agentId);
        const personaPriority = priority.get(profile?.personaId ?? '') ?? 50;
        return {
          agentId,
          priority: personaPriority + (yoloSet.has(agentId) ? 0 : 0.5),
        };
      })
      .sort((a, b) => a.priority - b.priority);
    return candidates[0]?.agentId ?? null;
  }

  private async dispatchYoloLaunchRepair(roomId: string, trigger: Message): Promise<void> {
    const room = getRoom(this.deps.db, roomId);
    const task = getActiveTask(this.deps.db, roomId);
    if (!room || !task) return;
    const key = `${roomId}:${task.id}:blocked-empty-phases`;
    if (this.yoloLaunchRepairInFlight.has(key)) return;
    const leadAgentId = this.yoloLaunchRepairLead(room);
    if (!leadAgentId) return;
    this.yoloLaunchRepairInFlight.add(key);
    try {
      const result = await this.runAgentReply(roomId, leadAgentId, trigger);
      if (result.message) {
        await this.runAgentHandoffs(roomId, leadAgentId, result.message);
      }
      await this.drainQueuedHumanMessages(roomId);
    } finally {
      this.yoloLaunchRepairInFlight.delete(key);
    }
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
    if (options.mode === 'yolo' || options.bypassRoomYolo) {
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
    if (await this.blockYoloLaunchIfInvalid(roomId)) return;
    const room = getRoom(this.deps.db, roomId);
    const yoloPool =
      room && room.yoloAgents.length > 0
        ? room.yoloAgents.filter((agent) => room.agents.includes(agent))
        : responders;
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
        handoffPool: yoloPool,
      });
    } finally {
      if (createdState && this.activeYoloDiscussions.get(roomId)?.id === yoloState.id) {
        this.activeYoloDiscussions.delete(roomId);
      }
      if (createdState && !yoloState.cancelled && !yoloState.stoppedReason) {
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
      parallelism: buildTaskParallelismSummary({
        phaseId: currentPhase?.id ?? null,
        phaseTitle: currentPhase?.title ?? 'All open work',
        agentCount: task.agents.length,
        checklistItems,
      }),
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

  private reconcileActiveTaskAgents(roomId: string, roomAgents: AgentId[]): void {
    const uniqueRoomAgents = roomAgents.filter(
      (agentId, index) => roomAgents.indexOf(agentId) === index,
    );
    for (const task of listTasksRepo(this.deps.db, roomId)) {
      if (!ACTIVE_TASK_STATUSES.has(task.status)) continue;
      if (
        task.agents.length === uniqueRoomAgents.length &&
        task.agents.every((agentId, index) => agentId === uniqueRoomAgents[index])
      ) {
        continue;
      }
      const updated = updateTaskRepo(this.deps.db, task.id, { agents: uniqueRoomAgents });
      if (updated) this.emit('taskUpdated', updated);
    }
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

  private workLaneScopeContractFromJob(job: AgentJob): WorkLaneScopeContract | null {
    const item = job.checklistItemId
      ? getTaskChecklistItem(this.deps.db, job.checklistItemId)
      : null;
    if (item) return workLaneScopeContract(item, job.agentId, 'active-job');
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
    const items = listTaskChecklistItems(this.deps.db, task.id);
    const plan = planWorkLanes({
      agents: uniqueAgents,
      items,
      activeItemIds,
      activeContracts,
      busyAgents,
    });
    let changedOwner = false;
    for (const ownerUpdate of plan.ownerUpdates) {
      const updated =
        updateTaskChecklistItem(this.deps.db, ownerUpdate.item.id, {
          ownerAgentId: ownerUpdate.agentId,
          updatedBy: 'fireside',
        }) ?? ownerUpdate.item;
      plan.assignments.set(ownerUpdate.agentId, { item: updated });
      changedOwner = true;
    }

    if (changedOwner) {
      const updatedTask = getTask(this.deps.db, task.id);
      if (updatedTask) this.emit('taskUpdated', updatedTask);
    }

    return plan.assignments;
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
    workflowRepair = false,
  ): Promise<AgentTurnResult> {
    if (cancelSignal?.aborted) return { message: null, progressed: false };
    const room = getRoom(this.deps.db, roomId);
    if (!room) {
      // The room was created before this call ran; it should still exist. Defensive guard.
      throw new Error(`unknown room: ${roomId}`);
    }
    const agentProfile =
      room.agentProfiles.find((profile) => profile.id === agentId) ?? defaultAgentProfile(agentId);
    const spec = this.deps.getSpec(agentProfile.providerId);
    if (!spec) {
      this.appendDirect(roomId, 'system', 'system', `(no adapter for agent "${agentId}")`);
      return { message: null, progressed: false };
    }
    const activeReason = this.activeAgentWorkReason(roomId, agentId);
    if (activeReason) {
      const activeTask = getActiveTask(this.deps.db, roomId);
      logger.info(
        { roomId, taskId: activeTask?.id ?? null, agentId, reason: activeReason },
        'agent turn suppressed by single-flight guard',
      );
      createRoutingDecision(this.deps.db, {
        roomId,
        taskId: activeTask?.id ?? null,
        authorId: 'fireside',
        kind: 'agent-message',
        action: 'single-flight-skip',
        reason: `${agentId} already has active work: ${activeReason}`,
        responders: [agentId],
        trace: [
          {
            id: 'agent-single-flight',
            result: 'blocked',
            reason: activeReason,
            agents: [agentId],
          },
        ],
      });
      return { message: null, progressed: false };
    }
    const maxHistory = this.deps.maxHistory ?? DEFAULT_PROMPT_HISTORY;
    const preparedContext = prepareAgentTurnContext({
      db: this.deps.db,
      room,
      agentId,
      trigger,
      ...(discussion ? { discussion } : {}),
      ...(permission ? { permission } : {}),
      ...(workLane ? { workLane } : {}),
      maxHistory,
      maxPromptChars: this.deps.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
      ...(this.deps.contextDir ? { contextDir: this.deps.contextDir } : {}),
      ...(this.deps.largeMessageThresholdChars !== undefined
        ? { largeMessageThresholdChars: this.deps.largeMessageThresholdChars }
        : {}),
      ...(this.deps.artifactExcerptChars !== undefined
        ? { artifactExcerptChars: this.deps.artifactExcerptChars }
        : {}),
      ...(this.deps.maxRecapChars !== undefined ? { maxRecapChars: this.deps.maxRecapChars } : {}),
      ...(this.deps.maxTranscriptChars !== undefined
        ? { maxTranscriptChars: this.deps.maxTranscriptChars }
        : {}),
      resumeCliSessions: this.deps.resumeCliSessions === true,
      getResumableCliSessionId: (targetRoomId, targetAgentId) =>
        this.getResumableCliSessionId(targetRoomId, targetAgentId),
      loadWorkflowProfileForTask: (task) => this.loadWorkflowProfileForTask(task),
      buildTaskControl: (task) => this.buildTaskControl(task),
      workflowWorkspacePath: (profile, task, lane) =>
        this.workflowWorkspacePath(profile, task, lane),
      workflowProfilePromptItem: (profile) => this.workflowProfilePromptItem(profile),
      workLanePromptItem: (item) => this.workLanePromptItem(item),
    });
    const {
      allMessages,
      promptHistory,
      activeTask,
      taskContext,
      effectivePermission,
      workflowWorkspacePath,
      prompt,
      sessionId,
      liveMessageChars,
      contextArtifactCount,
    } = preparedContext;
    const promptResult = { prompt, stats: preparedContext.promptStats };
    this.markQueuedMessagesDelivered(roomId, [...promptHistory, trigger]);

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
        promptDetailLevel: promptResult.stats.detailLevel,
        overBudgetChars: promptResult.stats.overBudgetChars,
        budgetNotices: promptResult.stats.budgetNotices,
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
    const promptMessagesSeen = [
      ...promptHistory.slice(-promptResult.stats.historyMessagesIncluded),
      trigger,
    ];
    this.recordMessageReadReceipts({
      roomId,
      agentId,
      runId: run.id,
      messages: promptMessagesSeen,
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
      detail: JSON.stringify({
        estimatedTokens: promptResult.stats.estimatedPromptTokens,
        promptChars: promptResult.stats.promptChars,
        maxPromptChars: promptResult.stats.maxPromptChars,
        overBudgetChars: promptResult.stats.overBudgetChars,
        detailLevel: promptResult.stats.detailLevel,
        liveMessages: promptResult.stats.historyMessagesIncluded + 1,
        historyMessagesAvailable: promptResult.stats.historyMessagesAvailable,
        historyMessagesDroppedByCount: promptResult.stats.historyMessagesDroppedByCount,
        historyMessagesDroppedByBudget: promptResult.stats.historyMessagesDroppedByBudget,
        latestMessageOriginalChars: promptResult.stats.latestMessageOriginalChars,
        latestMessageChars: promptResult.stats.latestMessageChars,
        latestMessageTruncated: promptResult.stats.latestMessageTruncated,
        contextArtifacts: contextArtifactCount,
        notices: promptResult.stats.budgetNotices,
      }),
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

    const providerTurn = await executeProviderTurn({
      runAgent: this.deps.runAgent,
      spec,
      prompt,
      sessionId,
      ...(effectivePermission ? { permission: effectivePermission } : {}),
      ...(cancelSignal ? { cancelSignal } : {}),
      onStreamEvent: recordProviderSignal,
      registerAbortController: (controller) => {
        this.activeRunAbortControllers.set(run.id, { roomId, controller });
      },
      unregisterAbortController: () => {
        this.activeRunAbortControllers.delete(run.id);
      },
      startHeartbeat: () => stopHeartbeat,
      yoloMode: discussion?.mode === 'yolo',
      attempt,
      maxRetryAttempts: 3,
    });
    if (!providerTurn.ok) {
      const errMsg = providerTurn.error;
      const raw = { stdout: providerTurn.stdout, stderr: providerTurn.stderr };
      const canceled = providerTurn.canceled;
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
      const retryDecision = providerTurn.retryDecision;
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
        this.recordTurnOutcome({
          roomId,
          taskId: activeTask?.id ?? null,
          runId: run.id,
          agentId,
          status: 'retry-scheduled',
          failed: true,
          error: errMsg,
          summary: `provider turn failed; retrying attempt ${retryDecision.nextAttempt}`,
          nextAgents: [agentId],
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
          workflowRepair,
        );
      }
      this.appendDirect(
        roomId,
        'system',
        'system',
        canceled ? `(${agentId} canceled: run was interrupted.)` : `(${agentId} failed: ${errMsg})`,
      );
      this.recordTurnOutcome({
        roomId,
        taskId: activeTask?.id ?? null,
        runId: run.id,
        agentId,
        status: canceled ? 'canceled' : 'failed',
        failed: !canceled,
        error: errMsg,
        summary: canceled ? 'provider turn canceled' : 'provider turn failed',
      });
      return { message: null, progressed: false, runId: run.id, failed: !canceled, error: errMsg };
    }
    const reply = providerTurn.reply;
    this.updateRunLifecycle({
      runId: run.id,
      state: 'finishing',
      reason: 'provider process completed; parsing response',
    });

    if (this.deps.resumeCliSessions && reply.sessionId) {
      upsertCliSessionId(this.deps.db, roomId, agentId, reply.sessionId, agentProfile.providerId);
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
    if (agentProfile.providerId === 'gemini') {
      void maybeSampleGeminiStatsModelQuota().then((quotaUsage) => {
        if (!quotaUsage) return;
        this.recordRunAction({
          roomId,
          taskId: activeTask?.id ?? null,
          runId: run.id,
          agentId,
          kind: 'adapter',
          status: 'completed',
          label: 'gemini quota sampled',
          detail: formatContextUsage(quotaUsage),
          contextUsage: quotaUsage,
        });
      });
    }
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
    this.recordMissionCommandEvents({
      roomId,
      taskId: createdMission?.id ?? activeTask?.id ?? null,
      runId: run.id,
      agentId,
      commandKind: 'mission-create',
      updates: extractedMissionCreates.updates,
      status: createdMission ? 'applied' : 'rejected',
      summary: createdMission
        ? `mission created: ${createdMission.title}`
        : activeTask
          ? `mission create rejected because active mission exists: ${activeTask.title}`
          : 'mission create did not produce a mission',
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
    this.recordMissionCommandEvents({
      roomId,
      taskId: missionTask?.id ?? null,
      runId: run.id,
      agentId,
      commandKind: 'mission-plan',
      updates: extractedMissionPlans.updates,
      status: missionTask ? 'applied' : 'rejected',
      summary: missionTask ? 'mission plan command processed' : 'mission plan rejected: no mission',
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
    this.recordMissionCommandEvents({
      roomId,
      taskId: missionTask?.id ?? null,
      runId: run.id,
      agentId,
      commandKind: 'mission-phase',
      updates: extractedMissionPhases.updates,
      status: missionTask ? 'applied' : 'rejected',
      summary: missionTask
        ? 'mission phase command processed'
        : 'mission phase rejected: no mission',
    });
    const extractedMissionTasks = extractMissionTaskUpdates(extractedMissionPhases.visibleText);
    const missionTaskResult = this.applyMissionTaskUpdates({
      roomId,
      task: missionTask,
      runId: run.id,
      agentId,
      updates: extractedMissionTasks.updates,
      defaultPlanId: defaultPlan?.id ?? null,
      forcePlanOnUpdates: sameTurnPlan !== null,
    });
    this.recordMissionCommandEvents({
      roomId,
      taskId: missionTask?.id ?? null,
      runId: run.id,
      agentId,
      commandKind: 'mission-task',
      updates: extractedMissionTasks.updates,
      status: missionTaskResult.applied > 0 ? 'applied' : 'rejected',
      summary:
        missionTaskResult.applied > 0
          ? `${missionTaskResult.applied} checklist command(s) applied`
          : missionTask
            ? 'checklist command did not apply'
            : 'checklist command rejected: no mission',
    });
    const extractedAgentRoster = extractAgentRosterUpdates(extractedMissionTasks.visibleText);
    const rosterResult = this.applyAgentRosterUpdates({
      roomId,
      task: missionTask,
      runId: run.id,
      agentId,
      updates: extractedAgentRoster.updates,
    });
    this.recordMissionCommandEvents({
      roomId,
      taskId: missionTask?.id ?? null,
      runId: run.id,
      agentId,
      commandKind: 'agent-roster',
      updates: extractedAgentRoster.updates,
      status: rosterResult.applied > 0 ? 'applied' : 'rejected',
      summary:
        rosterResult.applied > 0
          ? `${rosterResult.applied} roster command(s) applied`
          : 'roster command did not apply',
    });
    const missionWorkDispatches = this.routeMissionWorkDispatches({
      roomId,
      task: missionTask,
      runId: run.id,
      agentId,
      changedItems: missionTaskResult.dispatchCandidates,
    });
    const extractedMissionReceipts = extractMissionReceipts(extractedAgentRoster.visibleText);
    this.recordMissionReceipts({
      roomId,
      task: missionTask,
      runId: run.id,
      agentId,
      receipts: extractedMissionReceipts.receipts,
    });
    this.recordMissionCommandEvents({
      roomId,
      taskId: missionTask?.id ?? null,
      runId: run.id,
      agentId,
      commandKind: 'mission-receipt',
      updates: extractedMissionReceipts.receipts,
      status: missionTask ? 'reconciled' : 'rejected',
      summary: missionTask ? 'mission receipt recorded' : 'mission receipt rejected: no mission',
    });
    const missionStateUpdateCount =
      extractedMissionCreates.updates.length +
      extractedMissionPlans.updates.length +
      extractedMissionPhases.updates.length +
      extractedMissionTasks.updates.length +
      rosterResult.applied;
    const missionReceiptCount = extractedMissionReceipts.receipts.length;
    const productiveMissionReceiptCount = this.productiveMissionReceiptCount(
      extractedMissionReceipts.receipts,
    );
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
    const hiddenMissionProgressCount = this.hiddenMissionProgressCount({
      workflowRepair,
      missionStateUpdateCount,
      missionCreateCount: extractedMissionCreates.updates.length,
      missionPlanCount: extractedMissionPlans.updates.length,
      missionPhaseCount: extractedMissionPhases.updates.length,
      missionTaskUpdates: extractedMissionTasks.updates,
      rosterApplied: rosterResult.applied,
      productiveMissionReceiptCount,
      reconciliation,
    });
    if (textAfterMissionReceipts.length === 0) {
      const hiddenMissionRecordCount =
        missionStateUpdateCount + missionReceiptCount + reconciliation.applied;
      const status = hiddenMissionRecordCount > 0 ? 'completed' : 'empty';
      const emptyRun = updateAgentRun(this.deps.db, run.id, {
        status,
        completedAt: Date.now(),
        stdout: reply.raw.stdout,
        stderr: reply.raw.stderr,
        replyText: rawText,
        cliSessionId: reply.sessionId,
        lifecycleState: 'succeeded',
        lifecycleReason:
          hiddenMissionProgressCount > 0
            ? 'mission control progress stored without visible chat text'
            : hiddenMissionRecordCount > 0
              ? 'mission receipt stored without progress'
              : 'agent declined to add a chat message',
      });
      if (emptyRun) this.emit('agentRunUpdated', emptyRun);
      this.recordRunAction({
        roomId,
        taskId: missionTask?.id ?? null,
        runId: run.id,
        agentId,
        kind: hiddenMissionRecordCount > 0 ? 'ledger' : 'message',
        status: 'info',
        label: hiddenMissionRecordCount > 0 ? 'mission control update only' : 'empty reply',
        detail:
          hiddenMissionProgressCount > 0
            ? 'mission control progress stored without visible chat text'
            : hiddenMissionRecordCount > 0
              ? 'mission receipt stored without progress'
              : 'agent declined to add a chat message',
      });
      completeAgentJob(this.deps.db, agentJob.id);
      const repairResult = await this.maybeRunWorkflowContractRepair({
        roomId,
        agentId,
        trigger,
        discussion,
        permission,
        cancelSignal,
        yoloPermissionAutoApprovals,
        workLane,
        attempt,
        retryOfRunId,
        workflowRepair,
        runId: run.id,
        task: missionTask,
        missionStateUpdateCount,
        missionReceiptCount,
        reconciliation,
        visibleText: textAfterMissionReceipts,
      });
      await this.runAgentRosterFollowups(roomId, rosterResult.followups);
      const finalWorkDispatches = this.evaluateMissionLivenessDispatches({
        roomId,
        task: missionTask,
        runId: run.id,
        agentId,
        existingDispatches: missionWorkDispatches,
        allowLiveness: workLane === undefined,
      });
      const progressed =
        hiddenMissionProgressCount > 0 ||
        extractedDrafts.drafts.length > 0 ||
        finalWorkDispatches.length > 0 ||
        repairResult?.progressed === true;
      this.recordTurnOutcome({
        roomId,
        taskId: missionTask?.id ?? null,
        runId: run.id,
        agentId,
        status: hiddenMissionRecordCount > 0 ? 'completed' : 'empty',
        progressed,
        missionUpdates: missionStateUpdateCount,
        missionReceipts: missionReceiptCount,
        missionReconciliations: reconciliation.applied,
        draftArtifacts: extractedDrafts.drafts.length,
        workDispatches: finalWorkDispatches,
        summary:
          hiddenMissionProgressCount > 0
            ? 'mission control progress stored without visible chat text'
            : hiddenMissionRecordCount > 0
              ? 'mission receipt stored without progress'
              : 'agent declined to add a chat message',
      });
      return {
        message: null,
        progressed,
        runId: run.id,
        workDispatches: finalWorkDispatches,
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
      const permissionContinuation = planPermissionRequestContinuation({
        agentId,
        request: permissionRequest,
        effectivePermission,
        yoloPermissionAutoApprovals,
      });
      if (permissionContinuation.kind !== 'manual-approval') {
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
        if (permissionContinuation.kind === 'yolo-auto-approval-limit') {
          this.recordRunAction({
            roomId,
            taskId: missionTask?.id ?? null,
            runId: run.id,
            agentId,
            kind: 'permission',
            status: 'failed',
            label: 'YOLO auto-approval limit reached',
            detail: `Stopped auto-following permission requests after ${permissionContinuation.limit} consecutive YOLO approvals for this turn.`,
          });
          await this.runAgentRosterFollowups(roomId, rosterResult.followups);
          const finalWorkDispatches = this.evaluateMissionLivenessDispatches({
            roomId,
            task: missionTask,
            runId: run.id,
            agentId,
            existingDispatches: missionWorkDispatches,
            allowLiveness: workLane === undefined,
          });
          const progressed =
            Boolean(message) ||
            reconciliation.applied > 0 ||
            rosterResult.applied > 0 ||
            finalWorkDispatches.length > 0;
          this.recordTurnOutcome({
            roomId,
            taskId: missionTask?.id ?? null,
            runId: run.id,
            agentId,
            visibleMessageId: message?.id ?? null,
            visibleMessageEmitted: Boolean(message),
            status: 'completed',
            progressed,
            missionUpdates: missionStateUpdateCount,
            missionReceipts: missionReceiptCount,
            missionReconciliations: reconciliation.applied,
            collaborationNotes: visiblePermissionText.notes.length,
            draftArtifacts: extractedDrafts.drafts.length,
            permissionAutoApproved: true,
            workDispatches: finalWorkDispatches,
            summary: 'YOLO permission auto-approval limit reached',
          });
          return {
            message,
            progressed,
            runId: run.id,
            workDispatches: finalWorkDispatches,
          };
        }
        await this.runAgentRosterFollowups(roomId, rosterResult.followups);
        this.recordTurnOutcome({
          roomId,
          taskId: missionTask?.id ?? null,
          runId: run.id,
          agentId,
          visibleMessageId: message?.id ?? null,
          visibleMessageEmitted: Boolean(message),
          status: 'completed',
          progressed: true,
          missionUpdates: missionStateUpdateCount,
          missionReceipts: missionReceiptCount,
          missionReconciliations: reconciliation.applied,
          collaborationNotes: visiblePermissionText.notes.length,
          draftArtifacts: extractedDrafts.drafts.length,
          permissionAutoApproved: true,
          workDispatches: missionWorkDispatches,
          nextAgents: [agentId],
          summary: 'YOLO permission request auto-approved; launching approved follow-up turn',
        });
        return this.runAgentReply(
          roomId,
          agentId,
          trigger,
          discussion,
          permissionContinuation.autoPermission,
          cancelSignal,
          permissionContinuation.nextAutoApprovalCount,
          workLane,
          attempt,
          retryOfRunId,
          workflowRepair,
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
      await this.runAgentRosterFollowups(roomId, rosterResult.followups);
      const finalWorkDispatches = this.evaluateMissionLivenessDispatches({
        roomId,
        task: missionTask,
        runId: run.id,
        agentId,
        existingDispatches: missionWorkDispatches,
        allowLiveness: workLane === undefined,
      });
      const progressed = rosterResult.applied > 0 || finalWorkDispatches.length > 0;
      this.recordTurnOutcome({
        roomId,
        taskId: missionTask?.id ?? null,
        runId: run.id,
        agentId,
        visibleMessageId: message?.id ?? null,
        visibleMessageEmitted: Boolean(message),
        status: 'permission-requested',
        progressed,
        missionUpdates: missionStateUpdateCount,
        missionReceipts: missionReceiptCount,
        missionReconciliations: reconciliation.applied,
        collaborationNotes: visiblePermissionText.notes.length,
        draftArtifacts: extractedDrafts.drafts.length,
        permissionRequestId: request.id,
        workDispatches: finalWorkDispatches,
        summary: `${permissionRequest.mode} permission requested; waiting on human approval`,
      });
      return {
        message: null,
        progressed,
        runId: run.id,
        workDispatches: finalWorkDispatches,
      };
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
    const repairResult = await this.maybeRunWorkflowContractRepair({
      roomId,
      agentId,
      trigger,
      discussion,
      permission,
      cancelSignal,
      yoloPermissionAutoApprovals,
      workLane,
      attempt,
      retryOfRunId,
      workflowRepair,
      runId: run.id,
      task: missionTask,
      missionStateUpdateCount,
      missionReceiptCount,
      reconciliation,
      visibleText,
    });
    await this.runAgentRosterFollowups(roomId, rosterResult.followups);
    const finalWorkDispatches = this.evaluateMissionLivenessDispatches({
      roomId,
      task: missionTask,
      runId: run.id,
      agentId,
      existingDispatches: missionWorkDispatches,
      allowLiveness: workLane === undefined,
    });
    const progressed = workflowRepair
      ? hiddenMissionProgressCount > 0 || finalWorkDispatches.length > 0
      : Boolean(message) ||
        extracted.notes.length > 0 ||
        reconciliation.applied > 0 ||
        rosterResult.applied > 0 ||
        finalWorkDispatches.length > 0 ||
        repairResult?.progressed === true;
    this.recordTurnOutcome({
      roomId,
      taskId: missionTask?.id ?? null,
      runId: run.id,
      agentId,
      visibleMessageId: message?.id ?? null,
      visibleMessageEmitted: Boolean(message),
      status: message || extracted.notes.length > 0 ? 'completed' : 'empty',
      progressed,
      missionUpdates: missionStateUpdateCount,
      missionReceipts: missionReceiptCount,
      missionReconciliations: reconciliation.applied,
      collaborationNotes: extracted.notes.length,
      draftArtifacts: extractedDrafts.drafts.length,
      workDispatches: finalWorkDispatches,
      summary: message
        ? 'visible message emitted'
        : extracted.notes.length > 0
          ? 'collaboration note stored without visible chat text'
          : 'no visible message emitted',
    });
    return {
      message,
      progressed,
      runId: run.id,
      workDispatches: finalWorkDispatches,
    };
  }

  private async runAgentCompaction(input: {
    roomId: string;
    taskId: string | null;
    runId: string;
    agentId: AgentId;
    spec: AgentSpec;
    sessionId: string;
    providerId: ProviderId;
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
      upsertCliSessionId(
        this.deps.db,
        input.roomId,
        input.agentId,
        reply.sessionId,
        input.providerId,
      );
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

  private recordTurnOutcome(input: RecordAgentTurnOutcomeInput): AgentTurnOutcome {
    const outcome = recordAgentTurnOutcome(this.deps.db, input);
    this.recordRunAction({
      roomId: input.roomId,
      taskId: input.taskId ?? null,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'run',
      status: input.failed ? 'failed' : 'completed',
      label: 'turn outcome recorded',
      detail: JSON.stringify({
        status: outcome.status,
        progressed: outcome.progressed,
        visibleMessageEmitted: outcome.visibleMessageEmitted,
        missionUpdates: outcome.missionUpdates,
        missionReceipts: outcome.missionReceipts,
        missionReconciliations: outcome.missionReconciliations,
        collaborationNotes: outcome.collaborationNotes,
        draftArtifacts: outcome.draftArtifacts,
        permissionRequestId: outcome.permissionRequestId,
        permissionAutoApproved: outcome.permissionAutoApproved,
        nextAgents: outcome.nextAgents,
        summary: outcome.summary,
      }),
    });
    return outcome;
  }

  private recordMissionCommandEvents(input: {
    roomId: string;
    taskId: string | null;
    runId: string;
    agentId: AgentId;
    commandKind: MissionCommandKind;
    updates: unknown[];
    status: MissionCommandStatus;
    summary: string;
  }): void {
    for (const update of input.updates) {
      createMissionCommandEvent(this.deps.db, {
        roomId: input.roomId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        commandKind: input.commandKind,
        action: missionCommandAction(update),
        targetRef: missionCommandTargetRef(update),
        status: input.status,
        summary: input.summary,
        payload: update,
      });
    }
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
    recordMissionReceiptsState({
      ...input,
      recordRunAction: (action) => this.recordRunAction(action),
    });
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
    return reconcileMissionStateReceipts({
      db: this.deps.db,
      ...input,
      recordRunAction: (action) => this.recordRunAction(action),
      onTaskUpdated: (task) => this.emit('taskUpdated', task),
    });
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

  private validateWorkflowContract(input: {
    task: Task | null;
    agentId: AgentId;
    runId: string;
    missionStateUpdateCount: number;
    missionReceiptCount: number;
    reconciliation: MissionReconciliationResult;
    visibleText: string;
    workLane: WorkLaneAssignment | undefined;
  }): WorkflowContractValidation | null {
    if (!input.task) return null;
    if (
      input.missionStateUpdateCount > 0 ||
      input.missionReceiptCount > 0 ||
      input.reconciliation.applied > 0
    ) {
      return null;
    }
    if (!input.workLane && input.visibleText.trim().length === 0) return null;

    const violations = [
      'active mission turn produced no mission receipt, checklist update, phase update, plan update, or reconciled state',
    ];
    const currentLaneItem = input.workLane
      ? getTaskChecklistItem(this.deps.db, input.workLane.item.id)
      : null;
    if (currentLaneItem && !['done', 'blocked', 'skipped'].includes(currentLaneItem.status)) {
      violations.push('assigned checklist lane is still open after the turn');
    }
    if (input.visibleText.trim().length === 0) {
      violations.push('agent returned an empty visible message during an active mission');
    } else if (workLaneSignal(input.visibleText) !== 'none') {
      violations.push(
        'visible text implies work completed or blocked but Mission Control was not updated',
      );
    }

    return {
      violations,
      repairPrompt: this.workflowContractRepairPrompt({
        task: input.task,
        agentId: input.agentId,
        runId: input.runId,
        violations,
        visibleText: input.visibleText,
        workLaneItem: currentLaneItem ?? input.workLane?.item ?? null,
      }),
    };
  }

  private workflowContractRepairPrompt(input: {
    task: Task;
    agentId: AgentId;
    runId: string;
    violations: string[];
    visibleText: string;
    workLaneItem: TaskChecklistItem | null;
  }): string {
    const lines = [
      `(fireside workflow contract repair for ${input.agentId}: run ${input.runId})`,
      '',
      `Mission Control needs a state receipt for mission "${input.task.title}".`,
      'Emit only the missing hidden Mission Control block(s). No visible prose.',
      '',
      'Required options:',
      '- If assigned checklist work completed or blocked, emit /mission-task with action: update, id, status, and note.',
      '- If no checklist state changed, emit /mission-receipt with status: no_update or continuing and a concise summary.',
      '',
      'Examples:',
      '/mission-task',
      'action: update',
      'id: <checklist-item-id>',
      'status: done',
      'note: <evidence or completion summary>',
      '/end-mission-task',
      '',
      '/mission-receipt',
      'status: continuing',
      'summary: <what changed, or why no Mission Control state changed>',
      '/end-mission-receipt',
      '',
      `Violations: ${input.violations.join('; ')}`,
    ];
    if (input.workLaneItem) {
      lines.push(
        `Assigned item: ${input.workLaneItem.title} [id=${input.workLaneItem.id}, status=${input.workLaneItem.status}]`,
      );
    }
    const previous = oneLine(input.visibleText, 1200);
    if (previous) lines.push(`Previous visible text: ${previous}`);
    return lines.join('\n');
  }

  private async maybeRunWorkflowContractRepair(input: {
    roomId: string;
    agentId: AgentId;
    trigger: Message;
    discussion: DiscussionTurn | undefined;
    permission: PermissionGrant | undefined;
    cancelSignal: AbortSignal | undefined;
    yoloPermissionAutoApprovals: number;
    workLane: WorkLaneAssignment | undefined;
    attempt: number;
    retryOfRunId: string;
    workflowRepair: boolean;
    runId: string;
    task: Task | null;
    missionStateUpdateCount: number;
    missionReceiptCount: number;
    reconciliation: MissionReconciliationResult;
    visibleText: string;
  }): Promise<AgentTurnResult | null> {
    if (input.workflowRepair || input.cancelSignal?.aborted) return null;
    const validation = this.validateWorkflowContract({
      task: input.task,
      agentId: input.agentId,
      runId: input.runId,
      missionStateUpdateCount: input.missionStateUpdateCount,
      missionReceiptCount: input.missionReceiptCount,
      reconciliation: input.reconciliation,
      visibleText: input.visibleText,
      workLane: input.workLane,
    });
    if (!validation) return null;

    if (input.task) {
      this.recordMissingMissionReceipt({
        roomId: input.roomId,
        task: input.task,
        runId: input.runId,
        agentId: input.agentId,
      });
    }
    this.recordRunAction({
      roomId: input.roomId,
      taskId: input.task?.id ?? null,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: 'info',
      label: 'workflow contract repair requested',
      detail: JSON.stringify({ violations: validation.violations }),
    });

    const repairTrigger = this.appendDirect(
      input.roomId,
      'system',
      'system',
      validation.repairPrompt,
    );
    return this.runAgentReply(
      input.roomId,
      input.agentId,
      repairTrigger,
      input.discussion,
      input.permission,
      input.cancelSignal,
      input.yoloPermissionAutoApprovals,
      input.workLane,
      input.attempt,
      input.retryOfRunId,
      true,
    );
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
    const signalState = createProviderSignalProcessingState();
    return (event: AgentStreamEvent): void => {
      const processed = processProviderSignalEvent(signalState, event, {
        runSignalUpdateThrottleMs: RUN_SIGNAL_UPDATE_THROTTLE_MS,
        streamMessageThrottleMs: STREAM_MESSAGE_THROTTLE_MS,
      });
      input.onSignal();
      if (processed.lifecycleUpdate) {
        this.updateRunLifecycle({
          runId: input.runId,
          state: processed.lifecycleUpdate.state,
          reason: processed.lifecycleUpdate.reason,
          lastSignalAt: processed.lifecycleUpdate.lastSignalAt,
        });
      }
      if (!processed.action) return;
      this.recordRunAction({
        roomId: input.roomId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        kind: processed.action.kind,
        status: processed.action.status,
        label: processed.action.label,
        detail: processed.action.detail,
        ...(processed.action.contextUsage ? { contextUsage: processed.action.contextUsage } : {}),
      });
    };
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
      const heartbeat = describeRunHeartbeat({
        startedAt: input.startedAt,
        latestProviderSignalAt: input.latestProviderSignalAt(),
        now,
        stallAfterMs: RUN_STALL_AFTER_MS,
      });
      if (!stalledRecorded && heartbeat.stalled) {
        stalledRecorded = true;
        this.updateRunLifecycle({
          runId: input.runId,
          state: 'stalled',
          reason: heartbeat.detail,
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
        detail: heartbeat.detail,
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
    storeCollaborationNotesState({
      db: this.deps.db,
      ...input,
      recordRunAction: (action) => this.recordRunAction(action),
      onCollaborationItemCreated: (item) => this.emit('collaborationItemCreated', item),
    });
  }

  private autoAdvancePhase(input: {
    roomId: string;
    task: Task;
    runId: string;
    agentId: AgentId;
    completedPhase: TaskPhase | null;
  }): void {
    autoAdvanceMissionPhase({
      db: this.deps.db,
      ...input,
      recordRunAction: (action) => this.recordRunAction(action),
    });
  }

  private temporaryAgentLimitPerLead(): number {
    return Math.max(
      0,
      Math.floor(this.deps.temporaryAgentLimitPerLead ?? DEFAULT_TEMPORARY_AGENT_LIMIT_PER_LEAD),
    );
  }

  private temporaryAgentMaxTurns(): number {
    return Math.max(
      1,
      Math.floor(this.deps.temporaryAgentMaxTurns ?? DEFAULT_TEMPORARY_AGENT_MAX_TURNS),
    );
  }

  private temporaryAgentTurns(requested: number | null): number {
    const max = this.temporaryAgentMaxTurns();
    if (!requested) return max;
    return Math.max(1, Math.min(max, Math.floor(requested)));
  }

  private uniqueRoomAgentId(room: Room, base: string): AgentId {
    const cleanBase = mentionAliasSlug(base) || 'temporary-agent';
    const existing = new Set(room.agents);
    let candidate = cleanBase;
    let counter = 2;
    while (existing.has(candidate)) {
      candidate = `${cleanBase}-${counter}`;
      counter += 1;
    }
    return candidate;
  }

  private uniqueRoomAgentDisplayName(room: Room, base: string): string {
    const cleanBase = base.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Temporary Agent';
    const existing = new Set(
      room.agentProfiles.map((profile) => profile.displayName.toLowerCase()),
    );
    let candidate = cleanBase;
    let counter = 2;
    while (existing.has(candidate.toLowerCase())) {
      candidate = `${cleanBase} ${counter}`;
      counter += 1;
    }
    return candidate;
  }

  private resolveRosterAgent(room: Room, update: ParsedAgentRosterUpdate): AgentId | null {
    const id = update.id.trim();
    if (id && room.agents.includes(id)) return id;
    const nameSlug = mentionAliasSlug(update.name);
    if (!nameSlug) return null;
    return (
      room.agentProfiles.find(
        (profile) =>
          mentionAliasSlug(profile.displayName) === nameSlug ||
          mentionAliasSlug(profile.id) === nameSlug,
      )?.id ?? null
    );
  }

  private abortActiveRunsForAgent(roomId: string, agentId: AgentId, reason: string): void {
    for (const [runId, active] of this.activeRunAbortControllers) {
      if (active.roomId !== roomId || active.controller.signal.aborted) continue;
      const run = getAgentRun(this.deps.db, runId);
      if (run?.agentId !== agentId) continue;
      this.updateRunLifecycle({
        runId,
        state: 'canceled_by_reconciliation',
        reason,
      });
      active.controller.abort();
    }
  }

  private actorMayManageRoster(room: Room, agentId: AgentId): boolean {
    const profile =
      room.agentProfiles.find((candidate) => candidate.id === agentId) ??
      defaultAgentProfile(agentId);
    return TEMPORARY_AGENT_ORCHESTRATOR_PERSONAS.has(profile.personaId);
  }

  private applyAgentRosterUpdates(input: {
    roomId: string;
    task: Task | null;
    runId: string;
    agentId: AgentId;
    updates: ParsedAgentRosterUpdate[];
  }): AgentRosterApplyResult {
    const result: AgentRosterApplyResult = { applied: 0, followups: [] };
    if (input.updates.length === 0) return result;

    for (const update of input.updates) {
      const room = getRoom(this.deps.db, input.roomId);
      if (!room) return result;
      const actorProfile =
        room.agentProfiles.find((profile) => profile.id === input.agentId) ??
        defaultAgentProfile(input.agentId);
      const actorCanManage = this.actorMayManageRoster(room, input.agentId);

      if (update.action === 'add') {
        if (!actorCanManage) {
          this.recordRunAction({
            roomId: input.roomId,
            taskId: input.task?.id ?? null,
            runId: input.runId,
            agentId: input.agentId,
            kind: 'ledger',
            status: 'failed',
            label: 'temporary agent add ignored',
            detail: `${actorProfile.displayName} does not have an Engineering Manager or QA Lead persona.`,
          });
          continue;
        }
        if (!isProviderId(update.providerId) || update.providerId === 'echo') {
          this.recordRunAction({
            roomId: input.roomId,
            taskId: input.task?.id ?? null,
            runId: input.runId,
            agentId: input.agentId,
            kind: 'ledger',
            status: 'failed',
            label: 'temporary agent add ignored',
            detail: `unsupported provider "${update.providerId || 'missing'}"`,
          });
          continue;
        }
        const activeForLead = room.agentProfiles.filter(
          (profile) => profile.temporary === true && profile.spawnedBy === input.agentId,
        ).length;
        const limit = this.temporaryAgentLimitPerLead();
        if (activeForLead >= limit) {
          this.recordRunAction({
            roomId: input.roomId,
            taskId: input.task?.id ?? null,
            runId: input.runId,
            agentId: input.agentId,
            kind: 'ledger',
            status: 'failed',
            label: 'temporary agent limit reached',
            detail: `${actorProfile.displayName} already has ${activeForLead}/${limit} active temporary agents.`,
          });
          continue;
        }

        const persona = getAgentPersona(update.personaId || 'generalist');
        const fallbackName =
          persona.id === 'generalist'
            ? `${providerDisplayName(update.providerId)} Temp`
            : `${providerDisplayName(update.providerId)} ${persona.name}`;
        const displayName = this.uniqueRoomAgentDisplayName(room, update.name || fallbackName);
        const agentId = this.uniqueRoomAgentId(
          room,
          update.id || displayName || `${update.providerId}-${persona.id}`,
        );
        const maxTurns = this.temporaryAgentTurns(update.maxTurns);
        const profile: RoomAgentProfile = {
          id: agentId,
          providerId: update.providerId,
          displayName,
          personaId: persona.id,
          personaName: persona.name,
          personaSummary: persona.summary,
          temporary: true,
          spawnedBy: input.agentId,
          spawnedByPersonaId: actorProfile.personaId,
          spawnedAt: Date.now(),
          ...(update.reason ? { spawnedReason: update.reason.slice(0, 800) } : {}),
          ...(update.scope ? { spawnedScope: update.scope.slice(0, 500) } : {}),
          ...(update.dismissWhen ? { dismissWhen: update.dismissWhen.slice(0, 300) } : {}),
          maxTurns,
        };
        const yolo = update.yolo ?? room.yoloAgents.includes(input.agentId);
        const nextAgents = [...room.agents, agentId];
        const nextYoloAgents = yolo ? [...room.yoloAgents, agentId] : room.yoloAgents;
        this.setAgents(input.roomId, nextAgents, nextYoloAgents, [...room.agentProfiles, profile]);
        result.applied += 1;
        this.recordRunAction({
          roomId: input.roomId,
          taskId: input.task?.id ?? null,
          runId: input.runId,
          agentId: input.agentId,
          kind: 'ledger',
          status: 'completed',
          label: 'temporary agent added',
          detail: JSON.stringify({
            agentId,
            displayName,
            provider: update.providerId,
            persona: persona.id,
            spawnedBy: input.agentId,
            maxTurns,
            yolo,
            reason: update.reason,
            scope: update.scope,
          }),
        });
        const assignment = [
          `${actorProfile.displayName} added temporary agent ${displayName} (${agentId}).`,
          update.reason ? `Reason: ${update.reason}` : '',
          update.scope ? `Scope: ${update.scope}` : '',
          `Persona: ${persona.name}.`,
          `Temporary-agent budget: up to ${maxTurns} focused replies for this assignment.`,
          update.dismissWhen ? `Dismissal target: ${update.dismissWhen}` : '',
          '',
          update.prompt ||
            `Work the assigned ${update.scope || 'mission'} review/execution lane, update Mission Control with evidence, and dismiss yourself with /agent-roster action: dismiss id: ${agentId} when complete.`,
        ]
          .filter((line) => line !== '')
          .join('\n');
        result.followups.push({ agentId, text: assignment, maxTurns });
        continue;
      }

      const targetAgentId = this.resolveRosterAgent(room, update);
      const targetProfile = targetAgentId
        ? room.agentProfiles.find((profile) => profile.id === targetAgentId)
        : null;
      if (!targetAgentId || !targetProfile?.temporary) {
        this.recordRunAction({
          roomId: input.roomId,
          taskId: input.task?.id ?? null,
          runId: input.runId,
          agentId: input.agentId,
          kind: 'ledger',
          status: 'failed',
          label: 'temporary agent dismiss ignored',
          detail: `No active temporary agent matched "${update.id || update.name}".`,
        });
        continue;
      }
      const selfDismiss = targetAgentId === input.agentId;
      const spawnedByActor = targetProfile.spawnedBy === input.agentId;
      if (!actorCanManage && !selfDismiss && !spawnedByActor) {
        this.recordRunAction({
          roomId: input.roomId,
          taskId: input.task?.id ?? null,
          runId: input.runId,
          agentId: input.agentId,
          kind: 'ledger',
          status: 'failed',
          label: 'temporary agent dismiss ignored',
          detail: `${actorProfile.displayName} cannot dismiss ${targetProfile.displayName}.`,
        });
        continue;
      }
      this.abortActiveRunsForAgent(
        input.roomId,
        targetAgentId,
        `temporary agent dismissed by ${input.agentId}`,
      );
      this.setAgents(
        input.roomId,
        room.agents.filter((agent) => agent !== targetAgentId),
        room.yoloAgents.filter((agent) => agent !== targetAgentId),
        room.agentProfiles.filter((profile) => profile.id !== targetAgentId),
      );
      result.applied += 1;
      this.recordRunAction({
        roomId: input.roomId,
        taskId: input.task?.id ?? null,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'ledger',
        status: 'completed',
        label: 'temporary agent dismissed',
        detail: JSON.stringify({
          agentId: targetAgentId,
          displayName: targetProfile.displayName,
          dismissedBy: input.agentId,
          reason: update.reason || update.prompt || 'temporary assignment complete',
        }),
      });
      this.appendDirect(
        input.roomId,
        'system',
        'system',
        `Temporary agent ${targetProfile.displayName} (${targetAgentId}) dismissed by ${actorProfile.displayName}: ${compactInline(update.reason || update.prompt || 'assignment complete')}`,
      );
    }

    return result;
  }

  private async runAgentRosterFollowups(
    roomId: string,
    followups: AgentRosterApplyResult['followups'],
  ): Promise<void> {
    for (const followup of followups) {
      const room = getRoom(this.deps.db, roomId);
      if (!room || !room.agents.includes(followup.agentId)) continue;
      const trigger = this.appendDirect(roomId, 'system', 'system', followup.text);
      await this.runDiscussionThread(roomId, [followup.agentId], trigger, {
        mode: 'yolo',
        maxRepliesPerAgent: followup.maxTurns,
        maxTotalReplies: followup.maxTurns,
        responders: [followup.agentId],
      });
    }
  }

  private applyMissionCreateUpdates(input: {
    roomId: string;
    activeTask: Task | null;
    runId: string;
    agentId: AgentId;
    updates: ParsedMissionCreateUpdate[];
  }): Task | null {
    return applyMissionCreateUpdatesState({
      ...input,
      createTask: (roomId, taskInput) => this.createTask(roomId, taskInput),
      recordRunAction: (action) => this.recordRunAction(action),
    });
  }

  private applyMissionPlanUpdates(input: {
    roomId: string;
    task: Task | null;
    runId: string;
    agentId: AgentId;
    updates: ParsedMissionPlanUpdate[];
  }): TaskPlan | null {
    return applyMissionPlanUpdatesState({
      db: this.deps.db,
      ...input,
      recordRunAction: (action) => this.recordRunAction(action),
      onTaskUpdated: (task) => this.emit('taskUpdated', task),
    });
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
    applyMissionPhaseUpdatesState({
      db: this.deps.db,
      ...input,
      recordRunAction: (action) => this.recordRunAction(action),
      onTaskUpdated: (task) => this.emit('taskUpdated', task),
      autoAdvancePhase: (phaseInput) => this.autoAdvancePhase(phaseInput),
    });
  }

  private applyMissionTaskUpdates(input: {
    roomId: string;
    task: Task | null;
    runId: string;
    agentId: AgentId;
    updates: ParsedMissionTaskUpdate[];
    defaultPlanId: string | null;
    forcePlanOnUpdates: boolean;
  }): MissionTaskApplyResult {
    return applyMissionTaskUpdatesState({
      db: this.deps.db,
      roomId: input.roomId,
      task: input.task,
      runId: input.runId,
      agentId: input.agentId,
      updates: input.updates,
      defaultPlanId: input.defaultPlanId,
      forcePlanOnUpdates: input.forcePlanOnUpdates,
      recordRunAction: (action) => this.recordRunAction(action),
      onTaskUpdated: (task) => this.emit('taskUpdated', task),
    });
  }

  private routeMissionWorkDispatches(input: {
    roomId: string;
    task: Task | null;
    runId: string;
    agentId: AgentId;
    changedItems: TaskChecklistItem[];
  }): MissionWorkDispatch[] {
    if (!input.task || input.changedItems.length === 0) return [];
    const room = getRoom(this.deps.db, input.roomId);
    if (!room) return [];
    const allItems = listTaskChecklistItems(this.deps.db, input.task.id);
    const activeJobs = listActiveAgentJobsForRoom(this.deps.db, input.roomId).filter(
      (job) => job.taskId === input.task!.id,
    );
    const activeItemIds = new Set(
      activeJobs.map((job) => job.checklistItemId).filter((id): id is string => Boolean(id)),
    );
    const decision = routeMissionWorkUpdates({
      changedItems: input.changedItems,
      allItems,
      roomAgents: room.agents,
      authorId: input.agentId,
      busyAgents: this.busyAgentsInRoom(input.roomId),
      activeItemIds,
    });

    logger.info(
      {
        roomId: input.roomId,
        taskId: input.task.id,
        runId: input.runId,
        agentId: input.agentId,
        dispatches: decision.dispatches.map((dispatch) => ({
          agentId: dispatch.agentId,
          itemId: dispatch.item.id,
          title: dispatch.item.title,
          reason: dispatch.reason,
        })),
        trace: decision.trace,
      },
      'mission work routing decision',
    );
    createRoutingDecision(this.deps.db, {
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      authorId: input.agentId,
      kind: 'mission-work',
      action: decision.dispatches.length > 0 ? 'dispatch' : 'no-dispatch',
      reason:
        decision.dispatches.length > 0
          ? `${decision.dispatches.length} dispatch(es) selected`
          : 'no eligible mission work dispatches',
      responders: decision.dispatches.map((dispatch) => dispatch.agentId),
      trace: decision.trace,
    });

    for (const dispatch of decision.dispatches) {
      this.recordRunAction({
        roomId: input.roomId,
        taskId: input.task.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'ledger',
        status: 'completed',
        label: 'mission work dispatch',
        detail: `${dispatch.agentId} <- ${dispatch.item.title} [id=${dispatch.item.id}]`,
      });
    }
    return decision.dispatches;
  }

  private evaluateMissionLivenessDispatches(input: {
    roomId: string;
    task: Task | null;
    runId: string;
    agentId: AgentId;
    existingDispatches: MissionWorkDispatch[];
    allowLiveness: boolean;
  }): MissionWorkDispatch[] {
    if (!input.allowLiveness || !input.task || input.existingDispatches.length > 0) {
      return input.existingDispatches;
    }
    const room = getRoom(this.deps.db, input.roomId);
    if (!room) return input.existingDispatches;
    const decision = evaluateMissionLiveness({
      task: input.task,
      items: listTaskChecklistItems(this.deps.db, input.task.id),
      roomAgents: room.agents,
      activeJobs: listActiveAgentJobsForRoom(this.deps.db, input.roomId),
      recentOutcomes: listAgentTurnOutcomesForRoom(this.deps.db, input.roomId, 8),
    });
    this.recordRunAction({
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: decision.action === 'dispatch-ready-work' ? 'completed' : 'info',
      label: 'mission liveness decision',
      detail: JSON.stringify({
        action: decision.action,
        reason: decision.reason,
        dispatches: decision.dispatches.map((dispatch) => ({
          agentId: dispatch.agentId,
          itemId: dispatch.item.id,
          title: dispatch.item.title,
        })),
        latestOutcome: decision.latestOutcome
          ? {
              runId: decision.latestOutcome.runId,
              agentId: decision.latestOutcome.agentId,
              status: decision.latestOutcome.status,
              progressed: decision.latestOutcome.progressed,
            }
          : null,
      }),
    });
    createRoutingDecision(this.deps.db, {
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      authorId: 'fireside',
      kind: 'mission-work',
      action: `liveness:${decision.action}`,
      reason: decision.reason,
      responders: decision.dispatches.map((dispatch) => dispatch.agentId),
      trace: decision.trace,
    });
    return decision.dispatches.length > 0 ? decision.dispatches : input.existingDispatches;
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
      ...(!active ? { stoppedAt: state.cancelledAt ?? state.stoppedAt ?? Date.now() } : {}),
      ...((reason ?? state.cancelReason ?? state.stoppedReason)
        ? { reason: reason ?? state.cancelReason ?? state.stoppedReason }
        : {}),
    };
  }

  private stopYoloState(state: YoloDiscussionState, reason: string): YoloStatus {
    if (state.stoppedReason || state.cancelled) {
      return this.yoloStatus(state, false, reason);
    }
    state.stoppedReason = reason;
    state.stoppedAt = Date.now();
    const status = this.yoloStatus(state, false, reason);
    this.emit('yoloStatusUpdated', status);
    return status;
  }

  private yoloHumanWaitReason(roomId: string): string {
    const task = getActiveTask(this.deps.db, roomId);
    if (!task || task.status !== 'blocked') return '';
    const items = listTaskChecklistItems(this.deps.db, task.id);
    const byId = new Map(items.map((item) => [item.id, item]));
    const hasOpenDispatchableWork = items.some(
      (item) => item.status === 'open' && checklistDependenciesSatisfied(item, byId),
    );
    if (hasOpenDispatchableWork) return '';
    const councilBlocks = items.filter((item) => item.status === 'blocked' && item.councilRequired);
    if (councilBlocks.length === 0) return '';
    return `waiting-on-human:${oneLine(councilBlocks.map((item) => item.title).join('; '), 180)}`;
  }

  private productiveMissionReceiptCount(receipts: ParsedMissionReceipt[]): number {
    return receipts.filter(
      (receipt) => receipt.status !== 'no_update' && receipt.status !== 'continuing',
    ).length;
  }

  private hiddenMissionProgressCount(input: {
    workflowRepair: boolean;
    missionStateUpdateCount: number;
    missionCreateCount: number;
    missionPlanCount: number;
    missionPhaseCount: number;
    missionTaskUpdates: ParsedMissionTaskUpdate[];
    rosterApplied: number;
    productiveMissionReceiptCount: number;
    reconciliation: MissionReconciliationResult;
  }): number {
    if (!input.workflowRepair) {
      return (
        input.missionStateUpdateCount +
        input.productiveMissionReceiptCount +
        input.reconciliation.applied
      );
    }

    const structuralMissionUpdates =
      input.missionCreateCount +
      input.missionPlanCount +
      input.missionPhaseCount +
      input.rosterApplied;
    const terminalTaskUpdates = input.missionTaskUpdates.filter(
      workflowRepairTaskUpdateIsProgress,
    ).length;
    const reconciliationProgress =
      input.productiveMissionReceiptCount > 0 ? input.reconciliation.applied : 0;

    return (
      structuralMissionUpdates +
      terminalTaskUpdates +
      input.productiveMissionReceiptCount +
      reconciliationProgress
    );
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

    const responders = discussionOptions?.responders ?? this.pickResponders(room, text, authorId);
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

  private busyAgentsInRoom(roomId: string): Set<AgentId> {
    const busy = new Set<AgentId>();
    for (const run of listRunningAgentRunsForRoom(this.deps.db, roomId)) {
      busy.add(run.agentId);
    }
    for (const job of listActiveAgentJobsForRoom(this.deps.db, roomId)) {
      busy.add(job.agentId);
    }
    for (const [runId, active] of this.activeRunAbortControllers) {
      if (active.roomId !== roomId || active.controller.signal.aborted) continue;
      const run = getAgentRun(this.deps.db, runId);
      if (run) busy.add(run.agentId);
    }
    return busy;
  }

  private activeAgentWorkReason(roomId: string, agentId: AgentId): string {
    const runningRun = listRunningAgentRunsForRoom(this.deps.db, roomId).find(
      (run) => run.agentId === agentId,
    );
    if (runningRun) return `provider run ${runningRun.id} is still running`;

    const activeJob = listActiveAgentJobsForRoom(this.deps.db, roomId).find(
      (job) => job.agentId === agentId,
    );
    if (activeJob) return `agent job ${activeJob.id} is ${activeJob.status}`;

    for (const [runId, active] of this.activeRunAbortControllers) {
      if (active.roomId !== roomId || active.controller.signal.aborted) continue;
      const run = getAgentRun(this.deps.db, runId);
      if (run?.agentId === agentId) return `provider run ${runId} has an active controller`;
    }

    return '';
  }

  private freeResponders(roomId: string, responders: AgentId[]): AgentId[] {
    if (responders.length === 0) return [];
    const busy = this.busyAgentsInRoom(roomId);
    return responders.filter((agentId) => !busy.has(agentId));
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

  private assertQueuedHumanMessageMutable(
    roomId: string,
    messageId: string,
    authorId: string,
  ): void {
    const message = getMessage(this.deps.db, messageId);
    if (!message || message.roomId !== roomId) {
      throw new QueuedMessageMutationError(404, 'message not found');
    }
    if (message.authorKind !== 'human' || message.authorId !== authorId) {
      throw new QueuedMessageMutationError(403, 'only the queued message author can change it');
    }
    if (message.deliveryStatus !== 'queued') {
      throw new QueuedMessageMutationError(409, 'message has already been delivered');
    }
  }

  private recordMessageReadReceipts(input: {
    roomId: string;
    agentId: AgentId;
    runId: string;
    messages: Message[];
  }): void {
    const receipts = recordMessageReadReceiptsRepo(this.deps.db, {
      roomId: input.roomId,
      agentId: input.agentId,
      runId: input.runId,
      messageIds: input.messages.map((message) => message.id),
    });
    if (receipts.length === 0) return;
    const seenByMessage = listSeenAgentsByMessage(
      this.deps.db,
      input.roomId,
      receipts.map((receipt) => receipt.messageId),
    );
    for (const receipt of receipts) {
      this.emit('messageReadReceiptUpdated', {
        roomId: input.roomId,
        messageId: receipt.messageId,
        seenBy: seenByMessage.get(receipt.messageId) ?? [input.agentId],
        agentId: input.agentId,
        runId: input.runId,
        seenAt: receipt.seenAt,
      } satisfies MessageReadReceiptUpdate);
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
        const explicitResponders = this.pickExplicitResponders(
          room,
          message.text,
          message.authorId,
        );
        const responders =
          explicitResponders ?? this.pickResponders(room, message.text, message.authorId);
        if (responders.length === 0) {
          this.markQueuedMessagesDelivered(roomId, [message]);
          continue;
        }
        await this.runRoomAwareDiscussionThread(roomId, room, responders, message, {
          ...(explicitResponders !== null ? { bypassRoomYolo: true } : {}),
        });
      }
    } finally {
      this.drainingQueuedRooms.delete(roomId);
    }
  }

  private pickResponders(room: Room, text: string, authorId: string): AgentId[] {
    const references = resolveRoomAgentReferences(room, text);
    const mentions = references.agentIds;
    if (mentions.length > 0) {
      return mentions.filter((m) => room.agents.includes(m) && m !== authorId);
    }
    if (references.ambiguousAliases.length > 0) return [];
    return room.agents.filter((a) => a !== authorId);
  }

  private pickExplicitResponders(room: Room, text: string, authorId: string): AgentId[] | null {
    const references = resolveRoomAgentReferences(room, text);
    if (references.agentIds.length === 0) return null;
    return references.agentIds.filter(
      (agentId) => room.agents.includes(agentId) && agentId !== authorId,
    );
  }

  private pickAgentHandoffResponders(
    room: Room,
    text: string,
    authorId: AgentId,
    allowedAgents?: Set<AgentId>,
  ): AgentId[] {
    const decision = routeAgentMessage({ room, text, authorId, allowedAgents });
    logger.info(
      {
        roomId: room.id,
        action: decision.action,
        reason: decision.reason,
        authorId,
        responders: decision.responders,
        references: {
          agentIds: decision.references.agentIds,
          ambiguousAliases: decision.references.ambiguousAliases,
          explicitTokens: decision.references.explicitTokens,
        },
        trace: decision.trace,
      },
      'agent message routing decision',
    );
    createRoutingDecision(this.deps.db, {
      roomId: room.id,
      authorId,
      kind: 'agent-message',
      action: decision.action,
      reason: decision.reason,
      responders: decision.responders,
      trace: decision.trace,
    });
    return decision.responders;
  }

  private async runAgentHandoffs(
    roomId: string,
    authorId: AgentId,
    message: Message,
  ): Promise<void> {
    const room = getRoom(this.deps.db, roomId);
    if (!room) return;
    const responders = this.pickAgentHandoffResponders(room, message.text, authorId);
    if (responders.length === 0) return;
    await this.runRoomAwareDiscussionThread(roomId, room, responders, message);
  }

  private maxAgentRepliesPerThread(): number {
    const configured = this.deps.maxAgentRepliesPerThread ?? DEFAULT_MAX_AGENT_REPLIES_PER_THREAD;
    return Math.max(1, Math.floor(configured));
  }

  private latestMessage(roomId: string, fallback: Message): Message {
    const messages = listMessages(this.deps.db, roomId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (isBrokerInternalSystemMessage(message)) continue;
      return message;
    }
    return fallback;
  }

  private async runDiscussionThread(
    roomId: string,
    responders: AgentId[],
    initialTrigger: Message,
    options: DiscussionThreadOptions = {},
  ): Promise<void> {
    if (responders.length === 0) return;
    const yoloStateForLoop = options.mode === 'yolo' ? options.yoloState : undefined;
    if (yoloStateForLoop?.loopActive) {
      logger.info(
        { roomId, yoloId: yoloStateForLoop.id, responders },
        'suppressed overlapping YOLO discussion loop',
      );
      createRoutingDecision(this.deps.db, {
        roomId,
        taskId: getActiveTask(this.deps.db, roomId)?.id ?? null,
        authorId: 'fireside',
        kind: 'agent-message',
        action: 'yolo-loop-active',
        reason: 'YOLO loop is already active; latest room message will be picked up by that loop',
        responders,
        trace: [
          {
            id: 'yolo-loop-single-flight',
            result: 'blocked',
            reason: 'room already has an active YOLO discussion loop',
            agents: responders,
          },
        ],
      });
      return;
    }
    if (yoloStateForLoop) yoloStateForLoop.loopActive = true;
    const isCancelled = (): boolean => options.yoloState?.cancelled === true;
    const room = getRoom(this.deps.db, roomId);
    const roomAgents = room?.agents ?? responders;
    const maxReplies = Math.max(
      1,
      Math.floor(options.maxRepliesPerAgent ?? this.maxAgentRepliesPerThread()),
    );
    const scheduler = createDiscussionScheduler({
      mode: options.mode ?? 'normal',
      responders,
      roomAgents,
      handoffPool: options.handoffPool,
      preferResponderPool: options.responders !== undefined,
      maxRepliesPerAgent: maxReplies,
      ...(options.maxTotalReplies !== undefined
        ? { maxTotalReplies: options.maxTotalReplies }
        : {}),
      ...(options.yoloState?.totalRepliesUsed !== undefined
        ? { totalRepliesUsed: options.yoloState.totalRepliesUsed }
        : {}),
    });
    if (options.yoloState) {
      syncDiscussionTotalBudget(scheduler, options.yoloState.maxTotalReplies);
      options.yoloState.maxTotalReplies = Math.max(
        options.yoloState.maxTotalReplies,
        currentMaxTotalReplies(scheduler),
      );
      this.emit('yoloStatusUpdated', this.yoloStatus(options.yoloState, true));
    }
    const pendingWorkLanes = new Map<AgentId, WorkLaneAssignment>();

    try {
      for (
        let round = 1;
        scheduler.candidates.length > 0 &&
        scheduler.totalReplies < currentMaxTotalReplies(scheduler);
        round++
      ) {
        if (isCancelled()) return;
        if (options.yoloState) {
          syncDiscussionTotalBudget(scheduler, options.yoloState.maxTotalReplies);
        }
        const laneAssignments =
          scheduler.mode === 'yolo'
            ? this.assignYoloWorkLanes(
                roomId,
                scheduler.handoffPool.filter(
                  (id) =>
                    !scheduler.quarantinedAgents.has(id) &&
                    (scheduler.replyCounts.get(id) ?? 0) < currentMaxRepliesPerAgent(scheduler),
                ),
              )
            : new Map<AgentId, WorkLaneAssignment>();
        if (pendingWorkLanes.size > 0) {
          const busyAgents = this.busyAgentsInRoom(roomId);
          const activeTask = getActiveTask(this.deps.db, roomId);
          const items = activeTask ? listTaskChecklistItems(this.deps.db, activeTask.id) : [];
          const itemsById = new Map(items.map((item) => [item.id, item]));
          const reservedContracts = activeTask
            ? [
                ...this.activeWorkLaneContracts(roomId, activeTask.id),
                ...Array.from(laneAssignments.values()).map((assignment) =>
                  workLaneScopeContract(assignment.item, '', 'checklist'),
                ),
              ]
            : [];
          for (const [agentId, assignment] of pendingWorkLanes) {
            const freshItem = itemsById.get(assignment.item.id);
            if (
              !freshItem ||
              freshItem.status !== 'open' ||
              !scheduler.handoffPool.includes(agentId) ||
              busyAgents.has(agentId) ||
              scheduler.quarantinedAgents.has(agentId) ||
              (scheduler.replyCounts.get(agentId) ?? 0) >= currentMaxRepliesPerAgent(scheduler) ||
              !checklistDependenciesSatisfied(freshItem, itemsById) ||
              workLaneConflictReason(freshItem, reservedContracts)
            ) {
              continue;
            }
            laneAssignments.set(agentId, { item: freshItem });
            reservedContracts.push(workLaneScopeContract(freshItem, agentId, 'checklist'));
          }
        }
        if (scheduler.mode === 'yolo' && laneAssignments.size === 0) {
          const humanWaitReason = this.yoloHumanWaitReason(roomId);
          if (humanWaitReason) {
            if (options.yoloState) this.stopYoloState(options.yoloState, humanWaitReason);
            return;
          }
        }
        const trigger = this.latestMessage(roomId, initialTrigger);
        const roundPlan = planDiscussionRound(scheduler, {
          round,
          laneAgents: Array.from(laneAssignments.keys()),
        });
        const busyAgentsForRound = this.busyAgentsInRoom(roomId);
        const eligible = roundPlan.eligibleAgents.filter(
          (agentId) => !busyAgentsForRound.has(agentId),
        );
        const skippedBusyAgents = roundPlan.eligibleAgents.filter((agentId) =>
          busyAgentsForRound.has(agentId),
        );
        if (skippedBusyAgents.length > 0) {
          logger.info(
            {
              roomId,
              round,
              agents: skippedBusyAgents,
            },
            'discussion round skipped busy agents',
          );
          createRoutingDecision(this.deps.db, {
            roomId,
            taskId: getActiveTask(this.deps.db, roomId)?.id ?? null,
            authorId: 'fireside',
            kind: 'agent-message',
            action: 'single-flight-filter',
            reason: `skipped ${skippedBusyAgents.length} busy agent(s) before provider launch`,
            responders: skippedBusyAgents,
            trace: [
              {
                id: 'agent-single-flight',
                result: 'blocked',
                reason: 'agent already has active work in this room',
                agents: skippedBusyAgents,
              },
            ],
          });
        }
        if (eligible.length === 0) return;
        if (isCancelled()) return;
        for (const agentId of eligible) {
          if (laneAssignments.has(agentId)) pendingWorkLanes.delete(agentId);
        }

        const results = await Promise.all(
          eligible.map(async (agentId) => ({
            agentId,
            result: await this.runAgentReply(
              roomId,
              agentId,
              trigger,
              {
                round: Math.min(round, roundPlan.maxPromptRounds),
                maxRounds: roundPlan.maxPromptRounds,
                repliesUsed: scheduler.replyCounts.get(agentId) ?? 0,
                maxRepliesPerAgent: roundPlan.maxRepliesPerAgent,
                mode: options.mode ?? 'normal',
                totalRepliesUsed: scheduler.totalReplies,
                maxTotalReplies: roundPlan.maxTotalReplies,
              },
              options.permission,
              options.yoloState?.abortController.signal,
              0,
              laneAssignments.get(agentId),
            ),
          })),
        );
        if (isCancelled()) return;

        const resultSummaries: DiscussionResultSummary[] = [];
        for (const { agentId, result } of results) {
          const handoffs = room
            ? result.message
              ? this.pickAgentHandoffResponders(
                  room,
                  result.message.text,
                  agentId,
                  new Set(scheduler.handoffPool),
                )
              : []
            : [];
          const workDispatches: AgentId[] = [];
          for (const dispatch of result.workDispatches ?? []) {
            if (!scheduler.handoffPool.includes(dispatch.agentId)) continue;
            pendingWorkLanes.set(dispatch.agentId, { item: dispatch.item });
            workDispatches.push(dispatch.agentId);
          }
          resultSummaries.push({
            agentId,
            progressed: result.progressed,
            hasMessage: Boolean(result.message),
            failed: result.failed === true,
            handoffs,
            workDispatches,
            runId: result.runId ?? '',
            error: result.error ?? '',
          });
        }

        const outcome = applyDiscussionRoundResults(scheduler, {
          results: resultSummaries,
          roomYoloAgents: room?.yoloAgents ?? [],
        });
        for (const failure of outcome.failedYoloAgents) {
          if (!failure.runId) continue;
          this.recordRunAction({
            roomId,
            taskId: getActiveTask(this.deps.db, roomId)?.id ?? null,
            runId: failure.runId,
            agentId: failure.agentId,
            kind: 'run',
            status: 'failed',
            label: 'agent paused for YOLO session',
            detail: failure.error
              ? `Provider failed after retries; pausing this agent for the current YOLO session: ${failure.error}`
              : 'Provider failed after retries; pausing this agent for the current YOLO session.',
          });
        }
        if (options.yoloState && options.yoloState.totalRepliesUsed !== scheduler.totalReplies) {
          options.yoloState.totalRepliesUsed = scheduler.totalReplies;
          this.emit('yoloStatusUpdated', this.yoloStatus(options.yoloState, true));
        }

        if (outcome.shouldStop) {
          if (scheduler.mode === 'yolo' && options.yoloState) {
            this.stopYoloState(options.yoloState, outcome.stopReason);
          }
          return;
        }

        if (outcome.directedYoloAgents.length > 0) {
          const handoffTrigger = this.latestMessage(roomId, initialTrigger);
          await this.runRoomYoloDiscussionThread(
            roomId,
            handoffTrigger.authorId,
            outcome.directedYoloAgents,
            handoffTrigger,
          );
        }
      }
    } finally {
      if (yoloStateForLoop) yoloStateForLoop.loopActive = false;
      if (options.mode !== 'yolo' && !isCancelled()) {
        await this.drainQueuedHumanMessages(roomId);
      }
    }
  }
}
