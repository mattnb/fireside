import { createAgentRunAction } from '../../repos/run-actions.js';
import { getActiveTask, getTask } from '../../repos/tasks.js';
import {
  createTaskChecklistNote,
  listTaskChecklistItems,
} from '../../repos/task-checklist.js';
import { applyMissionTaskUpdates } from '../../mission-state/mission-task-applicator.js';
import { resolveChecklistItem } from '../../mission-state/mission-state-helpers.js';
import type { ParsedMissionTaskUpdate } from '../../mission-task-updates.js';
import { defineTool } from '../registry.js';
import {
  missionTaskAddNoteSchema,
  missionTaskUpdateSchema,
  type MissionTaskAddNoteArgs,
  type MissionTaskUpdateArgs,
} from '../schemas/mission-task.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

function toParsedMissionTaskUpdate(args: MissionTaskUpdateArgs): ParsedMissionTaskUpdate {
  const note = args.note ?? '';
  // Mirror the legacy /mission-task parser: statusNote always reflects the
  // note text when present; blockedReason and statusNote can coexist.
  const statusNote = args.status === 'blocked' ? '' : note;
  const blockedReason =
    args.status === 'blocked' ? (args.blockedReason ?? note) : (args.blockedReason ?? '');

  return {
    action: args.action ?? 'update',
    id: args.taskId,
    title: args.title ?? '',
    detail: args.detail ?? '',
    status: args.status ?? null,
    dependencyRefs: args.dependsOn ?? [],
    expectedTouches: args.expectedTouches ?? [],
    parallelism: args.parallelism ?? null,
    conflictGroup: args.conflictGroup ?? '',
    workRole: args.workRole ?? '',
    ownerAgentId: args.owner ?? '',
    statusNote,
    blockedReason,
    councilRequired: args.councilRequired ?? null,
    noteKind:
      args.noteKind ??
      (args.status === 'done' ? 'completion' : args.status === 'blocked' ? 'blocker' : 'status'),
    note,
    planRef: args.plan ?? '',
    phaseRef: args.phase ?? '',
  };
}

export function handleMissionTaskUpdate(
  input: AgentToolHandlerInput<MissionTaskUpdateArgs>,
): AgentToolResult {
  const mission = input.call.missionId
    ? getTask(input.db, input.call.missionId)
    : getActiveTask(input.db, input.call.roomId);

  if (!mission) {
    return {
      status: 'rejected',
      summary: 'mission.task.update rejected: no active mission',
      effects: [],
    };
  }

  // MCP/system callers have no agent_runs row; skip run-action logging so
  // the FK on agent_run_actions.run_id doesn't trip. The agent_tool_calls
  // audit row already captures the call.
  const runId = input.call.runId;
  const result = applyMissionTaskUpdates({
    db: input.db,
    roomId: input.call.roomId,
    task: mission,
    runId: runId ?? input.call.id,
    agentId: input.call.agentId,
    defaultPlanId: null,
    forcePlanOnUpdates: false,
    updates: [toParsedMissionTaskUpdate(input.args)],
    recordRunAction: runId
      ? (action) => {
          createAgentRunAction(input.db, action);
        }
      : () => {},
  });

  if (result.applied === 0) {
    return {
      status: 'rejected',
      summary: `mission.task.update rejected: ${input.args.taskId || input.args.title || 'task'} was not updated`,
      data: result,
      effects: [],
    };
  }

  const effect = {
    kind: 'task-updated' as const,
    targetType: 'task-checklist-item',
    summary: `Updated checklist item ${input.args.taskId || input.args.title}`,
    payload: result,
    ...(input.args.taskId ? { targetId: input.args.taskId } : {}),
  };

  return {
    status: 'applied',
    summary: `mission.task.update applied to ${input.args.taskId || input.args.title}`,
    data: result,
    effects: [effect],
  };
}

export function handleMissionTaskAddNote(
  input: AgentToolHandlerInput<MissionTaskAddNoteArgs>,
): AgentToolResult {
  const mission = input.call.missionId
    ? getTask(input.db, input.call.missionId)
    : getActiveTask(input.db, input.call.roomId);

  if (!mission) {
    return {
      status: 'rejected',
      summary: 'mission.task.add_note rejected: no active mission',
      effects: [],
    };
  }

  const items = listTaskChecklistItems(input.db, mission.id);
  const item = resolveChecklistItem(items, input.args.taskId);

  const runId = input.call.runId;

  if (!item) {
    if (runId) {
      createAgentRunAction(input.db, {
        roomId: input.call.roomId,
        taskId: mission.id,
        runId,
        agentId: input.call.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission task add_note ignored',
        detail: input.args.taskId,
      });
    }
    return {
      status: 'rejected',
      summary: `mission.task.add_note rejected: checklist item ${input.args.taskId} not found`,
      effects: [],
    };
  }

  const body = input.args.body.slice(0, 4000);
  const kind = input.args.kind ?? 'status';
  createTaskChecklistNote(input.db, {
    taskId: mission.id,
    itemId: item.id,
    authorId: input.call.agentId,
    kind,
    body,
  });

  if (runId) {
    createAgentRunAction(input.db, {
      roomId: input.call.roomId,
      taskId: mission.id,
      runId,
      agentId: input.call.agentId,
      kind: 'ledger',
      status: 'completed',
      label: 'mission task note added',
      detail: `${item.title} (${kind})`,
    });
  }

  return {
    status: 'applied',
    summary: `mission.task.add_note appended ${kind} note to ${item.title}`,
    data: { itemId: item.id, kind },
    effects: [
      {
        kind: 'task-updated',
        targetType: 'task-checklist-item',
        targetId: item.id,
        summary: `Added ${kind} note to ${item.title}`,
        payload: { itemId: item.id, noteKind: kind },
      },
    ],
  };
}

export const missionTaskAddNoteTool = defineTool<MissionTaskAddNoteArgs>({
  name: 'mission.task.add_note',
  summary: 'Append a note to an existing mission checklist item without changing its status.',
  requiredPermissions: ['mission:write'],
  schema: missionTaskAddNoteSchema,
  handler: handleMissionTaskAddNote,
});

export const missionTaskUpdateTool = defineTool<MissionTaskUpdateArgs>({
  name: 'mission.task.update',
  summary: 'Update an existing mission checklist item status, ownership, scope, notes, and links.',
  requiredPermissions: ['mission:write'],
  schema: missionTaskUpdateSchema,
  handler: handleMissionTaskUpdate,
});

export const missionTaskTools = [missionTaskUpdateTool, missionTaskAddNoteTool] as const;
