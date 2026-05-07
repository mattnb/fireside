import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { AgentId, RoomAgentProfile, SessionPolicy } from '../agents/types.js';
import { defaultAgentProfile } from '../agents/profiles.js';
import { policyAllowsSessionResume } from './session-policy.js';
import {
  messageTextForPrompt,
  writeConversationContextFiles,
  type ConversationContextFiles,
} from '../context-files.js';
import { classifyWorkflowRepairCollapse } from './workflow-repair-collapse.js';
import type { PermissionGrant } from '../permissions.js';
import { buildPermissionGrant } from '../permissions.js';
import { buildRoomYoloPermissionGrant } from './permission-orchestrator.js';
import { listCollaborationItems as listCollaborationItemsRepo } from '../repos/collaboration.js';
import { listMessages, type Message } from '../repos/messages.js';
import {
  getActiveTask,
  type Task,
} from '../repos/tasks.js';
import type { Room } from '../repos/rooms.js';
import {
  buildTaskPromptContext,
  type MissionControlSnapshot,
  type TaskPromptContext,
} from '../task-summary.js';
import {
  buildTurnPromptResult,
  type BuildTurnPromptStats,
  type PromptSectionStats,
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
  maxCollaborationLedgerChars?: number;
  maxAlwaysIncludedContextChars?: number;
  sessionPolicy: SessionPolicy;
  /** When present, prepended verbatim to the prompt before any other context.
   *  Used by the lead-reset path to rehydrate canonical mission state into the
   *  fresh CLI session's first turn. */
  leadRehydrationBlock?: string;
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
  sessionPolicy: SessionPolicy;
  liveMessageChars: number[];
  contextArtifactCount: number;
}

function latestMessageTextForPrompt(
  message: Message,
  contextFiles: ConversationContextFiles | undefined,
): string {
  const artifact = contextFiles?.messageArtifacts[message.id];
  if (!artifact) return message.text;
  return [
    message.text,
    ``,
    `[Full latest message also stored outside the live prompt: ${artifact.chars} chars at ${artifact.path}]`,
  ].join('\n');
}

function estimatePromptTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function emptyPromptPrefixHash(): string {
  return createHash('sha256').update('', 'utf8').digest('hex');
}

function prependLeadRehydrationBlock(
  prompt: string,
  stats: BuildTurnPromptStats,
  block: string,
): { prompt: string; stats: BuildTurnPromptStats } {
  const prefix = `${block}\n\n`;
  const finalPrompt = `${prefix}${prompt}`;
  const maxPromptChars = stats.maxPromptChars ?? finalPrompt.length;
  const leadSection: PromptSectionStats = {
    id: 'leadRehydration',
    label: 'Lead rehydration block',
    chars: prefix.length,
    estimatedTokens: estimatePromptTokens(prefix.length),
    lineCount: block.split('\n').length + 1,
    stablePrefix: false,
    alwaysIncludedContext: true,
  };

  return {
    prompt: finalPrompt,
    stats: {
      ...stats,
      promptChars: finalPrompt.length,
      estimatedPromptTokens: estimatePromptTokens(finalPrompt.length),
      stablePrefixChars: 0,
      stablePrefixEstimatedTokens: 0,
      stablePrefixHash: emptyPromptPrefixHash(),
      sections: [
        leadSection,
        ...stats.sections.map((section) =>
          section.stablePrefix ? { ...section, stablePrefix: false } : section,
        ),
      ],
      alwaysIncludedContextChars: stats.alwaysIncludedContextChars + prefix.length,
      overBudgetChars: Math.max(0, finalPrompt.length - maxPromptChars),
    },
  };
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
  const repairCollapse = classifyWorkflowRepairCollapse(input.db, allMessages, {
    excludeMessageId: input.trigger.id,
  });
  const contextFiles = input.contextDir
    ? writeConversationContextFiles({
        contextDir: input.contextDir,
        roomId: input.room.id,
        roomName: input.room.name,
        messages: allMessages,
        recentMessages: promptHistory.length + 1,
        collapsedMessageText: repairCollapse.collapsedText,
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
  const latestMessageText = latestMessageTextForPrompt(input.trigger, contextFiles);
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
      text:
        repairCollapse.collapsedText.get(message.id) ??
        messageTextForPrompt(message, contextFiles),
    })),
    newMessage: {
      authorId: input.trigger.authorId,
      authorKind: input.trigger.authorKind,
      text: latestMessageText,
    },
    maxHistory: input.maxHistory,
    maxPromptChars: workflowProfile?.promptBudgetChars ?? input.maxPromptChars,
    ...(input.maxCollaborationLedgerChars !== undefined
      ? { maxCollaborationLedgerChars: input.maxCollaborationLedgerChars }
      : {}),
    ...(input.maxAlwaysIncludedContextChars !== undefined
      ? { maxAlwaysIncludedContextChars: input.maxAlwaysIncludedContextChars }
      : {}),
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
    ...promptHistory.map(
      (message) =>
        (
          repairCollapse.collapsedText.get(message.id) ??
          messageTextForPrompt(message, contextFiles)
        ).length,
    ),
    latestMessageText.length,
  ];
  const contextArtifactCount = contextFiles
    ? Object.keys(contextFiles.messageArtifacts).length + contextFiles.fixtureCount
    : 0;
  const finalPromptResult = input.leadRehydrationBlock
    ? prependLeadRehydrationBlock(
        promptResult.prompt,
        promptResult.stats,
        input.leadRehydrationBlock,
      )
    : promptResult;
  return {
    agentProfile,
    allMessages,
    promptHistory,
    activeTask,
    workflowProfile,
    taskContext,
    effectivePermission,
    workflowWorkspacePath: workspacePath,
    prompt: finalPromptResult.prompt,
    promptStats: finalPromptResult.stats,
    sessionId: policyAllowsSessionResume(input.sessionPolicy)
      ? input.getResumableCliSessionId(input.room.id, input.agentId)
      : null,
    sessionPolicy: input.sessionPolicy,
    liveMessageChars,
    contextArtifactCount,
  };
}
