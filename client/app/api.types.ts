export type AgentId = 'claude' | 'codex' | 'gemini' | string;
export type ProviderId = 'claude' | 'codex' | 'gemini' | 'echo' | string;
export type AuthorKind = 'human' | 'agent' | 'system';
export type TaskStatus = 'active' | 'paused' | 'blocked' | 'verifying' | 'done';
export type TaskPhaseStatus = 'planned' | 'active' | 'blocked' | 'done';
export type TaskChecklistStatus = 'open' | 'blocked' | 'done' | 'skipped';
export type TaskChecklistParallelism = 'parallel-safe' | 'coordinate' | 'exclusive';
export type TaskPlanStatus = 'draft' | 'active' | 'superseded' | 'archived';
export type RunStatus = 'running' | 'completed' | 'failed' | 'empty' | 'permission-requested';
export type RunLifecycleState =
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
  | 'canceled_by_user'
  | 'retry_queued'
  | 'released';
export type CapabilityProfile = 'plan' | 'edit' | 'full-auto' | string;
export type PermissionStatus = 'pending' | 'approved' | 'denied';
export type PermissionCapability =
  | 'read'
  | 'edit-existing'
  | 'create-file'
  | 'delete-file'
  | 'run-command'
  | 'git-commit'
  | 'git-push'
  | 'network'
  | 'escape-cwd'
  | string;
export type CollaborationKind = 'proposal' | 'challenge' | 'revision' | 'decision' | 'evidence';
export type ArtifactKind =
  | 'recap'
  | 'transcript'
  | 'manifest'
  | 'message-artifact'
  | 'draft-artifact'
  | 'fixture'
  | 'fixture-manifest';
export type CollaborationStatus =
  | 'open'
  | 'blocked'
  | 'accepted'
  | 'rejected'
  | 'resolved'
  | 'superseded'
  | 'informational';
export type YoloFilesystemScope = 'task' | 'cwd' | 'custom' | 'unrestricted';

export interface YoloPermissionProfile {
  mode: 'plan' | 'edit' | 'full-auto';
  filesystemScope: YoloFilesystemScope;
  target?: string;
  web?: boolean;
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

export interface AgentProviderCatalogItem {
  id: ProviderId;
  displayName: string;
  summary: string;
}

export interface AgentPersona {
  id: string;
  name: string;
  category: string;
  summary: string;
  prompt: string;
}

export interface AgentCatalog {
  providers: AgentProviderCatalogItem[];
  personas: AgentPersona[];
}

export interface ProviderHealth {
  available?: boolean;
  authenticated?: boolean;
  quota5hPercent?: number;
  quota5hResetsAt?: number;
  quota5hWindowMinutes?: number;
  quota7dPercent?: number;
  quota7dResetsAt?: number;
  quota7dWindowMinutes?: number;
  quotaDailyPercent?: number;
  quotaDailyResetsAt?: number;
  quotaDailyWindowMinutes?: number;
  quotaStatus?: string;
  contextPercent?: number;
  recentFailureRate?: number;
  recentFailures?: number;
  recentRuns?: number;
}

export interface ProviderScoreCandidate {
  providerId: ProviderId;
  score: number;
  unavailable: boolean;
  selected: boolean;
  reasons: string[];
  warnings: string[];
  capabilityScore: number;
  health: ProviderHealth | null;
}

export interface ProviderScoreSlotRequest {
  id: string;
  personaId?: string;
  providerId?: ProviderId;
  preferredProviders?: ProviderId[];
  fallbackProviders?: ProviderId[];
  avoidProviders?: ProviderId[];
  capabilityTags?: string[];
}

export interface ProviderScoreRequest {
  slots: ProviderScoreSlotRequest[];
}

export interface ProviderScoreSlotResult {
  id: string;
  currentProviderId: ProviderId | null;
  recommendationMatchesCurrent: boolean;
  selectedProviderId: ProviderId | null;
  candidates: ProviderScoreCandidate[];
  capabilityTags: string[];
}

export interface ProviderScoreResponse {
  generatedAt: number;
  providerHealth: Partial<Record<ProviderId, ProviderHealth>>;
  slots: ProviderScoreSlotResult[];
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
  temporary?: boolean;
  spawnedBy?: AgentId;
  spawnedByPersonaId?: string;
  spawnedAt?: number;
  spawnedReason?: string;
  spawnedScope?: string;
  dismissWhen?: string;
  maxTurns?: number;
}

export interface Room {
  id: string;
  projectId: string;
  name: string;
  agents: AgentId[];
  yoloAgents: AgentId[];
  leadAgentId: AgentId | null;
  agentProfiles: RoomAgentProfile[];
  createdAt?: number;
  updatedAt?: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface StatusSnapshotTaskCounts {
  total: number;
  active: number;
  paused: number;
  blocked: number;
  verifying: number;
  done: number;
  activeLike: number;
}

export interface StatusSnapshotRunCounts {
  total: number;
  running: number;
  retrying: number;
  completed: number;
  failed: number;
  empty: number;
  permissionRequested: number;
}

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

export interface StatusSnapshotTokenUsageBucket {
  id: string;
  label: string;
  totalTokens: number;
  promptEstimateTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  usageEvents: number;
  runs: number;
}

export interface StatusSnapshotTokenUsageEvent {
  id: string;
  runId: string;
  taskId: string | null;
  agentId: AgentId;
  provider: string;
  model: string;
  createdAt: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
}

export interface StatusSnapshotTokenUsage {
  totalTokens: number;
  promptEstimateTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  usageEvents: number;
  runs: number;
  byProvider: StatusSnapshotTokenUsageBucket[];
  byAgent: StatusSnapshotTokenUsageBucket[];
  recentEvents: StatusSnapshotTokenUsageEvent[];
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
  counts: {
    agents: number;
    activeMissions: number;
    tasks: StatusSnapshotTaskCounts;
    runs: StatusSnapshotRunCounts;
  };
  activeMissions: Array<{
    id: string;
    roomId: string;
    title: string;
    goal: string;
    repoPath: string;
    status: TaskStatus;
    summary: string;
    updatedAt: number;
  }>;
  lastRun: AgentRun | null;
  lastAction: AgentRunAction | null;
  contextUsage: StatusSnapshotContextUsage;
  tokenUsage: StatusSnapshotTokenUsage;
  activeMissionTokenUsage: StatusSnapshotTokenUsage | null;
  agentStates: StatusSnapshotAgentState[];
}

export interface StatusSnapshot {
  version: 1;
  generatedAt: number;
  counts: {
    rooms: number;
    agents: number;
    activeMissions: number;
    tasks: StatusSnapshotTaskCounts;
    runs: StatusSnapshotRunCounts;
  };
  rooms: StatusSnapshotRoom[];
  contextUsage: StatusSnapshotContextUsage;
  tokenUsage: StatusSnapshotTokenUsage;
  agentStates: StatusSnapshotAgentState[];
}

export interface Message {
  id: string;
  roomId: string;
  authorKind: AuthorKind;
  authorId: string;
  text: string;
  createdAt: number;
  deliveryStatus?: 'queued' | 'delivered';
  seenBy?: AgentId[];
}

export interface MessageRetractionUpdate {
  roomId: string;
  messageId: string;
  authorId: string;
  retractedAt: number;
}

export interface PermissionRequest {
  id: string;
  roomId: string;
  agentId: AgentId;
  mode: CapabilityProfile;
  requestedMode: string;
  target: string;
  reason: string;
  capabilities: PermissionCapability[];
  targetExists: boolean | null;
  targetKind: string;
  targetResolvedPath: string;
  targetCheckedAt: number;
  providerProfile: string;
  status: PermissionStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export interface Task {
  id: string;
  roomId: string;
  title: string;
  goal?: string;
  repoPath?: string;
  acceptanceCriteria?: string;
  agents?: AgentId[];
  capabilityProfile: CapabilityProfile;
  summary?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt?: number;
}

export interface TaskPhase {
  id: string;
  taskId: string;
  planId: string | null;
  title: string;
  description: string;
  status: TaskPhaseStatus;
  gate: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskChecklistItem {
  id: string;
  taskId: string;
  planId: string | null;
  phaseId: string | null;
  title: string;
  detail: string;
  status: TaskChecklistStatus;
  dependencyIds: string[];
  expectedTouches: string[];
  parallelism: TaskChecklistParallelism;
  conflictGroup: string;
  workRole: string;
  ownerAgentId: string;
  statusNote: string;
  blockedReason: string;
  councilRequired: boolean;
  updatedBy: string;
  completedAt: number | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskChecklistNote {
  id: string;
  taskId: string;
  itemId: string;
  authorId: string;
  kind: 'status' | 'completion' | 'blocker' | 'council';
  body: string;
  createdAt: number;
}

export interface TaskPlan {
  id: string;
  taskId: string;
  title: string;
  body: string;
  status: TaskPlanStatus;
  createdAt: number;
  updatedAt: number;
}

export type TaskParallelismCellStatus =
  | 'can-run-together'
  | 'blocked-by-dependency'
  | 'same-conflict-group'
  | 'expected-touch-overlap'
  | 'exclusive-lane'
  | 'not-ready';

export interface TaskParallelismCell {
  leftId: string;
  rightId: string;
  status: TaskParallelismCellStatus;
  reason: string;
}

export interface TaskParallelismBatchItem {
  itemId: string;
  title: string;
  ownerAgentId: string;
  reason: string;
}

export interface TaskParallelismSummary {
  phaseId: string | null;
  phaseTitle: string;
  candidateCount: number;
  readyCount: number;
  nextBatch: TaskParallelismBatchItem[];
  cells: TaskParallelismCell[];
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

export interface MissionBriefingPayload {
  version: 1;
  capturedAt: number;
  room: Room;
  task: Task | null;
  currentPhase: TaskPhase | null;
  activePlan: TaskPlan | null;
  phases: TaskPhase[];
  checklistItems: TaskChecklistItem[];
  checklistNotes: TaskChecklistNote[];
  plans: TaskPlan[];
  collaboration: CollaborationItem[];
  messages: Message[];
  runs: AgentRun[];
  runActions: AgentRunAction[];
}

export interface MissionBriefingSummary {
  id: string;
  roomId: string | null;
  taskId: string | null;
  title: string;
  summary: string;
  createdBy: string;
  createdAt: number;
  messageCount: number;
  runCount: number;
}

export interface MissionBriefing extends MissionBriefingSummary {
  payload: MissionBriefingPayload;
}

export interface AgentRun {
  id: string;
  agentJobId?: string;
  roomId: string;
  taskId?: string | null;
  triggerMessageId?: string;
  replyMessageId?: string | null;
  agentId: AgentId;
  status: RunStatus;
  permissionMode?: CapabilityProfile;
  promptChars?: number;
  estimatedPromptTokens?: number;
  liveMessages?: number;
  contextArtifacts?: number;
  prompt?: string;
  summary?: string;
  lastSignal?: string;
  startedAt?: number;
  completedAt?: number | null;
  createdAt?: number;
  error?: string;
  promptText?: string;
  stdout?: string;
  stderr?: string;
  replyText?: string;
  cliSessionId?: string | null;
  permissionSource?: string;
  permissionTarget?: string;
  permissionReason?: string;
  permissionFilesystemScope?: string;
  permissionWeb?: boolean;
  permissionCapabilities?: PermissionCapability[];
  permissionTargetExists?: boolean | null;
  permissionTargetKind?: string;
  permissionTargetResolvedPath?: string;
  permissionTargetCheckedAt?: number;
  permissionProviderProfile?: string;
  lifecycleState?: RunLifecycleState;
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

export interface AgentRunAction {
  id: string;
  roomId: string;
  taskId?: string | null;
  runId: string;
  agentId?: AgentId;
  kind?: string;
  label: string;
  status: RunStatus | string;
  detail?: string;
  contextUsage?: AgentContextUsage;
  createdAt: number;
}

export interface AgentQuotaWindowUsage {
  percent?: number;
  windowMinutes?: number;
  resetsAt?: number;
  status?: string;
}

export interface AgentQuotaUsage {
  fiveHour?: AgentQuotaWindowUsage;
  sevenDay?: AgentQuotaWindowUsage;
  daily?: AgentQuotaWindowUsage;
  planType?: string;
  rateLimitReachedType?: string | null;
  source: string;
}

export interface AgentContextUsage {
  provider: string;
  model: string;
  reasoningEffort?: string;
  usedTokens: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
  autoCompactAtTokens?: number;
  remainingTokens?: number;
  percentUsed?: number;
  reportedUsedTokens?: number;
  estimated?: boolean;
  quota?: AgentQuotaUsage;
  quotaOnly?: boolean;
  source: string;
}

export interface RunDiagnostics {
  signals?: Array<{
    kind: string;
    label: string;
    detail?: string;
  }>;
}

export interface AgentRunDetail {
  run: AgentRun;
  execution?: {
    state: string;
    reason: string;
    jobStatus: string | null;
    runStatus: string | null;
    lifecycleState: string | null;
    attempt: number;
    maxAttempts: number;
    retryAfter: number | null;
    terminal: boolean;
  };
  outcome?: {
    id: string;
    roomId: string;
    taskId: string | null;
    runId: string;
    agentId: string;
    visibleMessageId: string | null;
    visibleMessageEmitted: boolean;
    status: string;
    progressed: boolean;
    failed: boolean;
    error: string;
    missionUpdates: number;
    missionReceipts: number;
    missionReconciliations: number;
    collaborationNotes: number;
    draftArtifacts: number;
    permissionRequestId: string | null;
    permissionAutoApproved: boolean;
    workDispatches: Array<{
      agentId: string;
      itemId: string;
      title: string;
      reason: string;
    }>;
    nextAgents: string[];
    summary: string;
    createdAt: number;
  } | null;
  triggerMessage: Message | null;
  replyMessage: Message | null;
  diagnostics: RunDiagnostics;
  actions: AgentRunAction[];
}

export interface RoutingRuleTrace {
  id: string;
  result: 'matched' | 'skipped' | 'blocked' | string;
  reason: string;
  agents?: AgentId[];
  aliases?: string[];
}

export type RoutingDecisionKind = 'human-message' | 'agent-message' | 'mission-work';

export interface RoutingDecision {
  id: string;
  roomId: string;
  taskId: string | null;
  runId: string | null;
  messageId: string | null;
  authorId: string;
  kind: RoutingDecisionKind;
  action: string;
  reason: string;
  responders: AgentId[];
  trace: RoutingRuleTrace[];
  createdAt: number;
}

export type MissionCommandKind =
  | 'mission-create'
  | 'mission-plan'
  | 'mission-phase'
  | 'mission-task'
  | 'mission-receipt'
  | 'agent-roster';

export type MissionCommandStatus = 'parsed' | 'applied' | 'rejected' | 'reconciled';

export interface MissionCommandEvent {
  id: string;
  roomId: string;
  taskId: string | null;
  runId: string | null;
  agentId: AgentId;
  commandKind: MissionCommandKind;
  action: string;
  targetRef: string;
  status: MissionCommandStatus;
  summary: string;
  payload: unknown;
  createdAt: number;
}

export type AgentTurnOutcomeStatus =
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'empty'
  | 'permission-requested'
  | 'retry-scheduled';

export interface AgentTurnOutcome {
  id: string;
  roomId: string;
  taskId: string | null;
  runId: string;
  agentId: AgentId;
  visibleMessageId: string | null;
  visibleMessageEmitted: boolean;
  status: AgentTurnOutcomeStatus;
  progressed: boolean;
  failed: boolean;
  error: string;
  missionUpdates: number;
  missionReceipts: number;
  missionReconciliations: number;
  collaborationNotes: number;
  draftArtifacts: number;
  permissionRequestId: string | null;
  permissionAutoApproved: boolean;
  workDispatches: Array<{
    agentId: AgentId;
    itemId: string;
    title: string;
    reason: string;
  }>;
  nextAgents: AgentId[];
  summary: string;
  createdAt: number;
}

export interface Artifact {
  name: string;
  path: string;
  kind: ArtifactKind;
  size?: number;
  updatedAt?: number;
}

export interface ArtifactListing {
  transcriptPath?: string;
  recapPath?: string;
  manifestPath?: string;
  artifactsDir?: string;
  fixtureManifestPath?: string;
  fixturesDir?: string;
  files: Artifact[];
}

export interface PickerResult {
  path: string;
}

export interface ConversationFixture {
  id: string;
  name: string;
  sourcePath: string;
  storedPath: string;
  size: number;
  copiedAt: number;
  isText: boolean;
  preview: string;
}

export interface CollaborationItem {
  id: string;
  roomId: string;
  taskId: string | null;
  kind: CollaborationKind;
  status: CollaborationStatus;
  title?: string;
  body: string;
  target?: string;
  authorId?: string;
  createdAt: number;
}

export type FiresideWsEvent =
  | { type: 'messageAppended'; message: Message }
  | { type: 'messageUpdated'; message: Message }
  | { type: 'messageRetracted'; update: MessageRetractionUpdate }
  | {
      type: 'messageDeliveryUpdated';
      update: {
        roomId: string;
        messageId: string;
        deliveryStatus: 'queued' | 'delivered';
        deliveredAt?: number;
      };
    }
  | {
      type: 'messageReadReceiptUpdated';
      update: {
        roomId: string;
        messageId: string;
        seenBy: AgentId[];
        agentId: AgentId;
        runId: string;
        seenAt: number;
      };
    }
  | { type: 'permissionRequestCreated'; request: PermissionRequest }
  | { type: 'permissionRequestUpdated'; request: PermissionRequest }
  | { type: 'roomUpdated'; room: Room }
  | { type: 'roomDeleted'; roomId: string }
  | { type: 'projectUpdated'; project: Project }
  | { type: 'projectDeleted'; projectId: string }
  | { type: 'taskUpdated'; task: Task }
  | { type: 'agentRunUpdated'; run: AgentRun }
  | { type: 'agentRunActionCreated'; action: AgentRunAction }
  | { type: 'artifactsUpdated'; roomId: string }
  | { type: 'collaborationItemCreated'; item: CollaborationItem }
  | { type: 'yoloStatusUpdated'; status: YoloStatus };

export interface PostMessageRequest {
  roomId: string;
  authorId: string;
  text: string;
}
