export type AgentId = 'claude' | 'codex' | 'gemini' | string;
export type AuthorKind = 'human' | 'agent' | 'system';
export type TaskStatus = 'active' | 'paused' | 'blocked' | 'verifying' | 'done';
export type TaskPhaseStatus = 'planned' | 'active' | 'blocked' | 'done';
export type TaskChecklistStatus = 'open' | 'blocked' | 'done' | 'skipped';
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

export interface Room {
  id: string;
  projectId: string;
  name: string;
  agents: AgentId[];
  yoloAgents: AgentId[];
  createdAt?: number;
  updatedAt?: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
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

export interface StatusSnapshotRoom {
  id: string;
  projectId: string;
  name: string;
  agents: AgentId[];
  yoloAgents: AgentId[];
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
}

export interface Message {
  id: string;
  roomId: string;
  authorKind: AuthorKind;
  authorId: string;
  text: string;
  createdAt: number;
  deliveryStatus?: 'queued' | 'delivered';
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
  triggerMessage: Message | null;
  replyMessage: Message | null;
  diagnostics: RunDiagnostics;
  actions: AgentRunAction[];
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
  | {
      type: 'messageDeliveryUpdated';
      update: {
        roomId: string;
        messageId: string;
        deliveryStatus: 'queued' | 'delivered';
        deliveredAt?: number;
      };
    }
  | { type: 'permissionRequestCreated'; request: PermissionRequest }
  | { type: 'permissionRequestUpdated'; request: PermissionRequest }
  | { type: 'roomUpdated'; room: Room }
  | { type: 'roomDeleted'; roomId: string }
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
