import { defaultAgentProfile } from '../../agents/profiles.js';
import type { AgentId, AgentRuntimeStatus, RoomAgentProfile } from '../../agents/types.js';
import { listActiveAgentJobsForRoom } from '../../repos/agent-jobs.js';
import { mentionAliasSlug } from '../../routing/agent-references.js';
import { addMessage } from '../../repos/messages.js';
import { recordMessageReadReceipts } from '../../repos/message-read-receipts.js';
import {
  createDispatchQueueItems,
  listPendingDispatchQueueItemsForRoom,
} from '../../repos/dispatch-queue.js';
import { getRoom, setRoomAgents, type Room } from '../../repos/rooms.js';
import { createAgentRunAction } from '../../repos/run-actions.js';
import { listTaskChecklistItems, type TaskChecklistItem } from '../../repos/task-checklist.js';
import { getActiveTask, getTask } from '../../repos/tasks.js';
import { defineTool } from '../registry.js';
import {
  agentAckMessageSchema,
  agentCheckinSchema,
  agentListAssignmentsSchema,
  agentRequestTurnsSchema,
  agentSetStatusSchema,
  type AgentAckMessageArgs,
  type AgentCheckinArgs,
  type AgentListAssignmentsArgs,
  type AgentRequestTurnsArgs,
  type AgentSetStatusArgs,
} from '../schemas/agent.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

export function handleAgentSetStatus(
  input: AgentToolHandlerInput<AgentSetStatusArgs>,
): AgentToolResult {
  const room = getRoom(input.db, input.call.roomId);
  if (!room) {
    return { status: 'rejected', summary: 'agent.set_status rejected: room not found', effects: [] };
  }

  const targetAgentId = input.args.agentId ?? input.call.agentId;
  if (!room.agents.includes(targetAgentId)) {
    return {
      status: 'rejected',
      summary: `agent.set_status rejected: ${targetAgentId} is not in the room`,
      effects: [],
    };
  }

  const currentProfiles = profilesForRoom(room);
  const nextProfiles = currentProfiles.map((profile) =>
    profile.id === targetAgentId
      ? {
          ...profile,
          status: input.args.status,
          statusUpdatedAt: input.now,
          ...(input.args.reason !== undefined
            ? { statusReason: input.args.reason.slice(0, 800) }
            : {}),
          ...(input.args.until !== undefined ? { statusUntil: input.args.until.slice(0, 120) } : {}),
          ...(input.args.currentTaskId !== undefined
            ? { currentTaskId: input.args.currentTaskId.slice(0, 120) }
            : {}),
        }
      : profile,
  );

  setRoomAgents(input.db, room.id, room.agents, room.yoloAgents, nextProfiles, room.leadAgentId);

  if (input.call.runId) {
    createAgentRunAction(input.db, {
      roomId: input.call.roomId,
      taskId: input.call.missionId,
      runId: input.call.runId,
      agentId: input.call.agentId,
      kind: 'ledger',
      status: 'completed',
      label: 'agent status set',
      detail: `${targetAgentId}: ${input.args.status}${input.args.reason ? ` - ${input.args.reason}` : ''}`,
    });
  }

  return {
    status: 'applied',
    summary: `agent.set_status applied to ${targetAgentId}: ${input.args.status}`,
    data: {
      agentId: targetAgentId,
      status: input.args.status,
      reason: input.args.reason ?? null,
    },
    effects: [
      {
        kind: 'activity-created',
        targetType: 'agent',
        targetId: targetAgentId,
        summary: `Set ${targetAgentId} status to ${input.args.status}`,
        payload: {
          agentId: targetAgentId,
          status: input.args.status,
          reason: input.args.reason ?? null,
        },
      },
    ],
  };
}

export function handleAgentCheckin(
  input: AgentToolHandlerInput<AgentCheckinArgs>,
): AgentToolResult {
  const room = getRoom(input.db, input.call.roomId);
  if (!room) {
    return { status: 'rejected', summary: 'agent.checkin rejected: room not found', effects: [] };
  }

  if (!room.agents.includes(input.call.agentId)) {
    return {
      status: 'rejected',
      summary: `agent.checkin rejected: ${input.call.agentId} is not in the room`,
      effects: [],
    };
  }

  let profile =
    room.agentProfiles.find((candidate) => candidate.id === input.call.agentId) ??
    defaultAgentProfile(input.call.agentId);
  if (input.args.status !== undefined) {
    const statusInput: PersistAgentRuntimeStatusInput = {
      db: input.db,
      room,
      agentId: input.call.agentId,
      status: input.args.status,
      now: input.now,
    };
    if (input.args.reason !== undefined) statusInput.reason = input.args.reason;
    if (input.args.currentTaskId !== undefined) {
      statusInput.currentTaskId = input.args.currentTaskId;
    }
    profile = persistAgentRuntimeStatus(statusInput);
  }

  const assignments = input.args.includeAssignments
    ? assignmentSnapshot(input, input.call.agentId, {
        includeCompleted: false,
        includeDispatches: true,
        includeJobs: true,
        limit: 20,
      })
    : null;

  return {
    status: 'applied',
    summary: `agent.checkin recorded for ${input.call.agentId}`,
    data: {
      agentId: input.call.agentId,
      status: profile.status ?? null,
      statusReason: profile.statusReason ?? null,
      currentTaskId: profile.currentTaskId ?? null,
      assignments,
      quota: input.args.includeQuota ? null : undefined,
    },
    effects:
      input.args.status !== undefined
        ? [
            {
              kind: 'activity-created',
              targetType: 'agent',
              targetId: input.call.agentId,
              summary: `Checked in ${input.call.agentId} as ${input.args.status}`,
              payload: {
                agentId: input.call.agentId,
                status: input.args.status,
                reason: input.args.reason ?? null,
              },
            },
          ]
        : [],
  };
}

export function handleAgentListAssignments(
  input: AgentToolHandlerInput<AgentListAssignmentsArgs>,
): AgentToolResult {
  const room = getRoom(input.db, input.call.roomId);
  if (!room) {
    return {
      status: 'rejected',
      summary: 'agent.list_assignments rejected: room not found',
      effects: [],
    };
  }

  const targetAgentId = input.args.agentId ?? input.call.agentId;
  if (!room.agents.includes(targetAgentId)) {
    return {
      status: 'rejected',
      summary: `agent.list_assignments rejected: ${targetAgentId} is not in the room`,
      effects: [],
    };
  }

  const assignments = assignmentSnapshot(input, targetAgentId, input.args);
  return {
    status: 'applied',
    summary: `agent.list_assignments returned ${assignments.checklistItems.length} checklist assignment${assignments.checklistItems.length === 1 ? '' : 's'} for ${targetAgentId}`,
    data: {
      agentId: targetAgentId,
      ...assignments,
    },
    effects: [],
  };
}

export function handleAgentAckMessage(
  input: AgentToolHandlerInput<AgentAckMessageArgs>,
): AgentToolResult {
  const room = getRoom(input.db, input.call.roomId);
  if (!room) {
    return { status: 'rejected', summary: 'agent.ack_message rejected: room not found', effects: [] };
  }
  if (!room.agents.includes(input.call.agentId)) {
    return {
      status: 'rejected',
      summary: `agent.ack_message rejected: ${input.call.agentId} is not in the room`,
      effects: [],
    };
  }

  const receipts = recordMessageReadReceipts(input.db, {
    roomId: input.call.roomId,
    agentId: input.call.agentId,
    runId: input.call.runId,
    messageIds: input.args.messageIds,
    seenAt: input.now,
  });

  return {
    status: 'applied',
    summary: `agent.ack_message recorded ${receipts.length} new acknowledgement${receipts.length === 1 ? '' : 's'}`,
    data: {
      requestedMessageIds: input.args.messageIds,
      acknowledgedMessageIds: receipts.map((receipt) => receipt.messageId),
    },
    effects: receipts.map((receipt) => ({
      kind: 'activity-created' as const,
      targetType: 'message',
      targetId: receipt.messageId,
      summary: `${input.call.agentId} acknowledged message ${receipt.messageId}`,
      payload: {
        messageId: receipt.messageId,
        agentId: input.call.agentId,
        seenAt: receipt.seenAt,
      },
    })),
  };
}

export function handleAgentRequestTurns(
  input: AgentToolHandlerInput<AgentRequestTurnsArgs>,
): AgentToolResult {
  const room = getRoom(input.db, input.call.roomId);
  if (!room) {
    return { status: 'rejected', summary: 'agent.request_turns rejected: room not found', effects: [] };
  }

  const resolved = resolveRoomAgentRefs(room, input.args.agents).filter(
    (agentId) => agentId !== input.call.agentId,
  );
  if (resolved.length === 0) {
    return {
      status: 'rejected',
      summary: 'agent.request_turns rejected: no target agents resolved',
      data: { requestedAgents: input.args.agents },
      effects: [],
    };
  }

  const text = [
    input.args.message || input.args.reason || `${input.call.agentId} requested a follow-up turn.`,
    input.args.reason && input.args.message ? `Reason: ${input.args.reason}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const message = addMessage(input.db, {
    roomId: input.call.roomId,
    authorId: 'system',
    authorKind: 'system',
    text,
  });
  const queued = createDispatchQueueItems(input.db, {
    roomId: input.call.roomId,
    sourceMessageId: message.id,
    authorId: input.call.agentId,
    targetKind: 'agent',
    targetIds: resolved,
    kind: 'agent-handoff',
    priority: input.args.priority ?? 0,
    routingTrace: [
      {
        id: 'agent.request_turns',
        result: 'matched',
        reason: input.args.reason ?? 'structured agent turn request',
        agents: resolved,
      },
    ],
  });

  if (input.call.runId) {
    createAgentRunAction(input.db, {
      roomId: input.call.roomId,
      taskId: input.call.missionId,
      runId: input.call.runId,
      agentId: input.call.agentId,
      kind: 'ledger',
      status: 'completed',
      label: 'agent turns requested',
      detail: `${queued.map((item) => item.targetId).join(', ')}: ${input.args.reason ?? ''}`,
    });
  }

  return {
    status: 'applied',
    summary: `agent.request_turns queued ${queued.length} turn${queued.length === 1 ? '' : 's'}`,
    data: {
      messageId: message.id,
      requestedAgents: input.args.agents,
      queuedAgentIds: queued.map((item) => item.targetId),
      dispatchIds: queued.map((item) => item.id),
    },
    effects: queued.map((item) => ({
      kind: 'agent-dispatch-requested' as const,
      targetType: 'agent',
      targetId: item.targetId,
      summary: `Queued follow-up turn for ${item.targetId}`,
      payload: { dispatchId: item.id, sourceMessageId: message.id },
    })),
  };
}

export const agentSetStatusTool = defineTool<AgentSetStatusArgs>({
  name: 'agent.set_status',
  summary: 'Update the caller or a coordinated target agent runtime status.',
  requiredPermissions: ['agent:write-self'],
  schema: agentSetStatusSchema,
  handler: handleAgentSetStatus,
});

export const agentCheckinTool = defineTool<AgentCheckinArgs>({
  name: 'agent.checkin',
  summary: 'Record a lightweight liveness check-in and optionally return current assignments.',
  requiredPermissions: ['agent:write-self'],
  schema: agentCheckinSchema,
  handler: handleAgentCheckin,
});

export const agentListAssignmentsTool = defineTool<AgentListAssignmentsArgs>({
  name: 'agent.list_assignments',
  summary: 'List checklist, job, and queued-dispatch assignments for a room agent.',
  requiredPermissions: ['mission:read'],
  schema: agentListAssignmentsSchema,
  handler: handleAgentListAssignments,
});

export const agentAckMessageTool = defineTool<AgentAckMessageArgs>({
  name: 'agent.ack_message',
  summary: 'Record durable read acknowledgements for one or more room messages.',
  requiredPermissions: ['agent:write-self'],
  schema: agentAckMessageSchema,
  handler: handleAgentAckMessage,
});

export const agentRequestTurnsTool = defineTool<AgentRequestTurnsArgs>({
  name: 'agent.request_turns',
  summary: 'Queue follow-up turns for specific room agents through the dispatch queue.',
  requiredPermissions: ['agent:coordinate'],
  schema: agentRequestTurnsSchema,
  handler: handleAgentRequestTurns,
});

export const agentTools = [
  agentCheckinTool,
  agentSetStatusTool,
  agentListAssignmentsTool,
  agentAckMessageTool,
  agentRequestTurnsTool,
] as const;

interface PersistAgentRuntimeStatusInput {
  db: AgentToolHandlerInput['db'];
  room: Room;
  agentId: AgentId;
  status: AgentRuntimeStatus;
  reason?: string;
  currentTaskId?: string;
  now: number;
}

function persistAgentRuntimeStatus(input: PersistAgentRuntimeStatusInput): RoomAgentProfile {
  const currentProfiles = profilesForRoom(input.room);
  let updatedProfile: RoomAgentProfile | undefined;
  const nextProfiles = currentProfiles.map((profile) => {
    if (profile.id !== input.agentId) return profile;
    const nextProfile: RoomAgentProfile = {
      ...profile,
      status: input.status,
      statusUpdatedAt: input.now,
      ...(input.reason !== undefined ? { statusReason: input.reason.slice(0, 800) } : {}),
      ...(input.currentTaskId !== undefined
        ? { currentTaskId: input.currentTaskId.slice(0, 120) }
        : {}),
    };
    updatedProfile = nextProfile;
    return nextProfile;
  });
  setRoomAgents(
    input.db,
    input.room.id,
    input.room.agents,
    input.room.yoloAgents,
    nextProfiles,
    input.room.leadAgentId,
  );
  return updatedProfile ?? defaultAgentProfile(input.agentId);
}

function assignmentSnapshot(
  input: Pick<AgentToolHandlerInput<unknown>, 'call' | 'db' | 'now'>,
  agentId: AgentId,
  options: {
    includeCompleted: boolean;
    includeDispatches: boolean;
    includeJobs: boolean;
    limit: number;
  },
) {
  const task =
    (input.call.missionId ? getTask(input.db, input.call.missionId) : null) ??
    getActiveTask(input.db, input.call.roomId);
  const checklistItems = task
    ? listTaskChecklistItems(input.db, task.id)
        .filter((item) => item.ownerAgentId === agentId)
        .filter((item) => options.includeCompleted || !['done', 'skipped'].includes(item.status))
        .slice(0, options.limit)
        .map(compactChecklistItem)
    : [];
  const activeJobs = options.includeJobs
    ? listActiveAgentJobsForRoom(input.db, input.call.roomId)
        .filter((job) => job.agentId === agentId)
        .slice(0, options.limit)
        .map((job) => ({
          id: job.id,
          taskId: job.taskId,
          checklistItemId: job.checklistItemId,
          triggerMessageId: job.triggerMessageId,
          runId: job.runId,
          status: job.status,
          updatedAt: job.updatedAt,
        }))
    : [];
  const pendingDispatches = options.includeDispatches
    ? listPendingDispatchQueueItemsForRoom(input.db, input.call.roomId, input.now)
        .filter((item) => item.targetKind === 'agent' && item.targetId === agentId)
        .slice(0, options.limit)
        .map((item) => ({
          id: item.id,
          sourceMessageId: item.sourceMessageId,
          authorId: item.authorId,
          kind: item.kind,
          priority: item.priority,
          availableAt: item.availableAt,
        }))
    : [];
  return {
    missionId: task?.id ?? null,
    checklistItems,
    activeJobs,
    pendingDispatches,
  };
}

function compactChecklistItem(item: TaskChecklistItem) {
  return {
    id: item.id,
    taskId: item.taskId,
    planId: item.planId,
    phaseId: item.phaseId,
    title: item.title,
    status: item.status,
    blockedReason: item.blockedReason,
    councilRequired: item.councilRequired,
    expectedTouches: item.expectedTouches,
    parallelism: item.parallelism,
    conflictGroup: item.conflictGroup,
    workRole: item.workRole,
    updatedAt: item.updatedAt,
  };
}

function profilesForRoom(room: Room): RoomAgentProfile[] {
  return room.agents.map(
    (agentId) => room.agentProfiles.find((profile) => profile.id === agentId) ?? defaultAgentProfile(agentId),
  );
}

function resolveRoomAgentRefs(room: Room, refs: string[]): AgentId[] {
  const byAlias = new Map<string, AgentId>();
  const providerCounts = new Map<string, number>();
  for (const profile of profilesForRoom(room)) {
    providerCounts.set(profile.providerId, (providerCounts.get(profile.providerId) ?? 0) + 1);
  }
  for (const profile of profilesForRoom(room)) {
    const aliases = [
      profile.id,
      profile.displayName,
      profile.displayName.replace(/\s+/g, '-'),
      mentionAliasSlug(profile.displayName),
    ];
    if ((providerCounts.get(profile.providerId) ?? 0) === 1) aliases.push(profile.providerId);
    for (const alias of aliases) {
      const key = mentionAliasSlug(alias);
      if (key && !byAlias.has(key)) byAlias.set(key, profile.id);
    }
  }
  const resolved = refs
    .map((ref) => byAlias.get(mentionAliasSlug(ref)))
    .filter((agentId): agentId is AgentId => Boolean(agentId));
  return [...new Set(resolved)];
}
