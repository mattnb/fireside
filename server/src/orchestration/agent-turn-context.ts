import type { Database } from 'better-sqlite3';
import type { AgentId, RoomAgentProfile } from '../agents/types.js';
import { defaultAgentProfile } from '../agents/profiles.js';
import {
  messageTextForPrompt,
  writeConversationContextFiles,
} from '../context-files.js';
import type { PermissionGrant } from '../permissions.js';
import { buildPermissionGrant } from '../permissions.js';
import { buildRoomYoloPermissionGrant } from './permission-orchestrator.js';
import { listCollaborationItems as listCollaborationItemsRepo } from '../repos/collaboration.js';
import { listMessages, type Message } from '../repos/messages.js';
import {
  getActiveTask,
  type Task,
} from '../repos/tasks.js';
import { listRecentAgentRunsForTask } from '../repos/agent-runs.js';
import type { Room } from '../repos/rooms.js';
import {
  buildTaskPromptContext,
  type MissionControlSnapshot,
  type TaskPromptContext,
} from '../task-summary.js';
import {
  buildTurnPromptResult,
  type BuildTurnPromptStats,
  type WorkLanePromptItem,
  type WorkflowProfilePromptItem,
} from '../transcript.js';
import type { WorkflowProfile } from '../workflow-profile.js';
import type { WorkLaneAssignment } from './work-lane-planner.js';

export interface TurnContextDiscussion {
  round: number;
  maxRounds: number;
  repliesUsed: number;
  maxRepliesPerAgent: number;
  mode?: 'normal' | 'yolo';
  totalRepliesUsed?: number;
  maxTotalReplies?: number;
}

export interface PrepareAgentTurnContextInput {
  db: Database;
  room: Room;
  agentId: AgentId;
  trigger: Message;
  discussion?: TurnContextDiscussion;
  permission?: PermissionGrant;
  workLane?: WorkLaneAssignment;
  maxHistory: number;
  maxPromptChars: number;
  contextDir?: string;
  largeMessageThresholdChars?: number;
  artifactExcerptChars?: number;
  maxRecapChars?: number;
  maxTranscriptChars?: number;
  resumeCliSessions: boolean;
  getResumableCliSessionId: (roomId: string, agentId: AgentId) => string | null;
  loadWorkflowProfileForTask: (task: Task | null) => WorkflowProfile | null;
  buildTaskControl: (task: Task) => MissionControlSnapshot;
  workflowWorkspacePath: (
    profile: WorkflowProfile | null,
    task: Task | null,
    workLane: WorkLaneAssignment | undefined,
  ) => string;
  workflowProfilePromptItem: (
    profile: WorkflowProfile | null,
  ) => WorkflowProfilePromptItem | undefined;
  workLanePromptItem: (item: WorkLaneAssignment['item']) => WorkLanePromptItem;
}

export interface PreparedAgentTurnContext {
  agentProfile: RoomAgentProfile;
  allMessages: Message[];
  promptHistory: Message[];
  activeTask: Task | null;
  workflowProfile: WorkflowProfile | null;
  taskContext: TaskPromptContext | undefined;
  effectivePermission: PermissionGrant | undefined;
  workflowWorkspacePath: string;
  prompt: string;
  promptStats: BuildTurnPromptStats;
  sessionId: string | null;
  liveMessageChars: number[];
  contextArtifactCount: number;
}

export function prepareAgentTurnContext(
  input: PrepareAgentTurnContextInput,
): PreparedAgentTurnContext {
  const agentProfile =
    input.room.agentProfiles.find((profile) => profile.id === input.agentId) ??
    defaultAgentProfile(input.agentId);
  const allMessages = listMessages(input.db, input.room.id);
  const triggerIndex = allMessages.findIndex((message) => message.id === input.trigger.id);
  const history =
    triggerIndex >= 0 ? allMessages.slice(0, triggerIndex) : allMessages.slice(0, -1);
  const promptHistory = history.slice(-input.maxHistory);
  const contextFiles = input.contextDir
    ? writeConversationContextFiles({
        contextDir: input.contextDir,
        roomId: input.room.id,
        roomName: input.room.name,
        messages: allMessages,
        recentMessages: promptHistory.length + 1,
        ...(input.largeMessageThresholdChars !== undefined
          ? { largeMessageThresholdChars: input.largeMessageThresholdChars }
          : {}),
        ...(input.artifactExcerptChars !== undefined
          ? { artifactExcerptChars: input.artifactExcerptChars }
          : {}),
        ...(input.maxRecapChars !== undefined ? { maxRecapChars: input.maxRecapChars } : {}),
        ...(input.maxTranscriptChars !== undefined
          ? { maxTranscriptChars: input.maxTranscriptChars }
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
  const activeTask = getActiveTask(input.db, input.room.id);
  const workflowProfile = input.loadWorkflowProfileForTask(activeTask ?? null);
  const collaborationItems = listCollaborationItemsRepo(input.db, input.room.id, {
    limit: 10,
    ...(activeTask ? { taskId: activeTask.id } : {}),
  });
  const taskContext = activeTask
    ? buildTaskPromptContext({
        task: activeTask,
        recentMessages: allMessages.slice(-8),
        recentRuns: listRecentAgentRunsForTask(input.db, input.room.id, activeTask.id, 6),
        missionControl: input.buildTaskControl(activeTask),
      })
    : undefined;
  const explicitPermission: PermissionGrant | undefined = input.permission
    ? buildPermissionGrant({
        agentId: input.agentId,
        mode: input.permission.mode,
        target: input.permission.target,
        reason: input.permission.reason,
        ...(input.permission.requestedMode
          ? { requestedMode: input.permission.requestedMode }
          : {}),
        ...(input.permission.source ? { source: input.permission.source } : {}),
        ...(input.permission.requestId ? { requestId: input.permission.requestId } : {}),
        ...(input.permission.filesystemScope
          ? { filesystemScope: input.permission.filesystemScope }
          : {}),
        ...(input.permission.web ? { web: true } : {}),
      })
    : undefined;
  const roomYoloPermission: PermissionGrant | undefined =
    !explicitPermission && input.room.yoloAgents.includes(input.agentId)
      ? buildRoomYoloPermissionGrant({ agentId: input.agentId, activeTask })
      : undefined;
  const taskPermission: PermissionGrant | undefined =
    !explicitPermission &&
    !roomYoloPermission &&
    activeTask &&
    activeTask.capabilityProfile !== 'plan'
      ? buildPermissionGrant({
          agentId: input.agentId,
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
          agentId: input.agentId,
          source: 'task',
          mode: workflowProfile.permissions.mode,
          target:
            workflowProfile.permissions.target ||
            input.workflowWorkspacePath(workflowProfile, activeTask ?? null, input.workLane) ||
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
  const workspacePath = input.workflowWorkspacePath(workflowProfile, activeTask ?? null, input.workLane);
  const workflowProfilePromptItem = input.workflowProfilePromptItem(workflowProfile);
  const promptResult = buildTurnPromptResult({
    agentId: input.agentId,
    agentProfile,
    roomName: input.room.name,
    roomAgents: input.room.agents,
    roomAgentProfiles: input.room.agentProfiles,
    roomLeadAgentId: input.room.leadAgentId,
    history: promptHistory.map((message) => ({
      authorId: message.authorId,
      authorKind: message.authorKind,
      text: messageTextForPrompt(message, contextFiles),
    })),
    newMessage: {
      authorId: input.trigger.authorId,
      authorKind: input.trigger.authorKind,
      text: messageTextForPrompt(input.trigger, contextFiles),
    },
    maxHistory: input.maxHistory,
    maxPromptChars: workflowProfile?.promptBudgetChars ?? input.maxPromptChars,
    ...(promptContextFiles !== undefined ? { contextFiles: promptContextFiles } : {}),
    ...(input.discussion !== undefined ? { discussion: input.discussion } : {}),
    ...(effectivePermission !== undefined ? { permission: effectivePermission } : {}),
    ...(taskContext !== undefined ? { task: taskContext } : {}),
    ...(input.workLane !== undefined
      ? { workLane: input.workLanePromptItem(input.workLane.item) }
      : {}),
    ...(workflowProfilePromptItem !== undefined
      ? { workflowProfile: workflowProfilePromptItem }
      : {}),
    collaboration: collaborationItems,
  });
  const liveMessageChars = [
    ...promptHistory.map((message) => messageTextForPrompt(message, contextFiles).length),
    messageTextForPrompt(input.trigger, contextFiles).length,
  ];
  const contextArtifactCount = contextFiles
    ? Object.keys(contextFiles.messageArtifacts).length + contextFiles.fixtureCount
    : 0;
  return {
    agentProfile,
    allMessages,
    promptHistory,
    activeTask,
    workflowProfile,
    taskContext,
    effectivePermission,
    workflowWorkspacePath: workspacePath,
    prompt: promptResult.prompt,
    promptStats: promptResult.stats,
    sessionId: input.resumeCliSessions
      ? input.getResumableCliSessionId(input.room.id, input.agentId)
      : null,
    liveMessageChars,
    contextArtifactCount,
  };
}
