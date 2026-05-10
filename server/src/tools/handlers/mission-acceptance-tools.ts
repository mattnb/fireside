// server/src/tools/handlers/mission-acceptance-tools.ts
//
// Pure CRUD handlers for the acceptance-criteria tools. The lead manages AC
// rows during the proposal phase. State-machine guards (e.g. blocking edits
// once the task is approved) land in PR 2 alongside the verify path.

import { getActiveTask, getTask } from '../../repos/tasks.js';
import {
  createAcceptanceCriterion,
  getAcceptanceCriterion,
  listAcceptanceCriteria,
  updateAcceptanceCriterion,
} from '../../repos/acceptance-criteria.js';
import { defineTool } from '../registry.js';
import {
  missionAcceptanceCreateSchema,
  missionAcceptanceReorderSchema,
  missionAcceptanceUpdateSchema,
  type MissionAcceptanceCreateArgs,
  type MissionAcceptanceReorderArgs,
  type MissionAcceptanceUpdateArgs,
} from '../schemas/mission-acceptance.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

function nextSortOrder(db: Parameters<typeof listAcceptanceCriteria>[0], taskId: string): number {
  const rows = listAcceptanceCriteria(db, taskId);
  if (rows.length === 0) return 0;
  return Math.max(...rows.map((row) => row.sortOrder)) + 1;
}

export function handleMissionAcceptanceCreate(
  input: AgentToolHandlerInput<MissionAcceptanceCreateArgs>,
): AgentToolResult {
  const mission = input.call.missionId
    ? getTask(input.db, input.call.missionId)
    : getActiveTask(input.db, input.call.roomId);
  if (!mission) {
    return {
      status: 'rejected',
      summary: 'mission.acceptance.create rejected: no active mission',
      effects: [],
    };
  }

  const ac = createAcceptanceCriterion(input.db, {
    taskId: mission.id,
    title: input.args.title,
    detail: input.args.detail ?? '',
    doerAgentId: input.args.doer ?? null,
    sortOrder: input.args.sortOrder ?? nextSortOrder(input.db, mission.id),
  });

  return {
    status: 'applied',
    summary: `mission.acceptance.create: ${ac.id}`,
    data: { acId: ac.id, taskId: ac.taskId, title: ac.title, sortOrder: ac.sortOrder },
    effects: [
      {
        kind: 'task-updated',
        targetType: 'task',
        targetId: mission.id,
        summary: `Acceptance criterion added: ${ac.title.slice(0, 80)}`,
        payload: { acId: ac.id },
      },
    ],
  };
}

export function handleMissionAcceptanceUpdate(
  input: AgentToolHandlerInput<MissionAcceptanceUpdateArgs>,
): AgentToolResult {
  const existing = getAcceptanceCriterion(input.db, input.args.id);
  if (!existing) {
    return {
      status: 'rejected',
      summary: `mission.acceptance.update rejected: unknown ac ${input.args.id}`,
      effects: [],
    };
  }

  const patch: Parameters<typeof updateAcceptanceCriterion>[2] = {};
  if (input.args.title !== undefined) patch.title = input.args.title;
  if (input.args.detail !== undefined) patch.detail = input.args.detail;
  if (input.args.doer !== undefined) patch.doerAgentId = input.args.doer;
  if (input.args.sortOrder !== undefined) patch.sortOrder = input.args.sortOrder;
  const updated = updateAcceptanceCriterion(input.db, input.args.id, patch);

  return {
    status: 'applied',
    summary: `mission.acceptance.update: ${input.args.id}`,
    data: {
      acId: updated?.id,
      taskId: updated?.taskId,
      title: updated?.title,
      sortOrder: updated?.sortOrder,
    },
    effects: [
      {
        kind: 'task-updated',
        targetType: 'task',
        targetId: existing.taskId,
        summary: `Acceptance criterion updated: ${(updated?.title ?? existing.title).slice(0, 80)}`,
        payload: { acId: existing.id },
      },
    ],
  };
}

export function handleMissionAcceptanceReorder(
  input: AgentToolHandlerInput<MissionAcceptanceReorderArgs>,
): AgentToolResult {
  const existing = getAcceptanceCriterion(input.db, input.args.id);
  if (!existing) {
    return {
      status: 'rejected',
      summary: `mission.acceptance.reorder rejected: unknown ac ${input.args.id}`,
      effects: [],
    };
  }

  const updated = updateAcceptanceCriterion(input.db, input.args.id, {
    sortOrder: input.args.sortOrder,
  });

  return {
    status: 'applied',
    summary: `mission.acceptance.reorder: ${input.args.id} → ${input.args.sortOrder}`,
    data: { acId: existing.id, taskId: existing.taskId, sortOrder: updated?.sortOrder },
    effects: [
      {
        kind: 'task-updated',
        targetType: 'task',
        targetId: existing.taskId,
        summary: `Acceptance criterion reordered to ${input.args.sortOrder}`,
        payload: { acId: existing.id },
      },
    ],
  };
}

export const missionAcceptanceCreateTool = defineTool<MissionAcceptanceCreateArgs>({
  name: 'mission.acceptance.create',
  summary: 'Add an acceptance criterion to the active mission.',
  requiredPermissions: ['mission:write'],
  schema: missionAcceptanceCreateSchema,
  handler: handleMissionAcceptanceCreate,
});

export const missionAcceptanceUpdateTool = defineTool<MissionAcceptanceUpdateArgs>({
  name: 'mission.acceptance.update',
  summary: 'Update an acceptance criterion (title, detail, doer, sortOrder).',
  requiredPermissions: ['mission:write'],
  schema: missionAcceptanceUpdateSchema,
  handler: handleMissionAcceptanceUpdate,
});

export const missionAcceptanceReorderTool = defineTool<MissionAcceptanceReorderArgs>({
  name: 'mission.acceptance.reorder',
  summary: 'Set the sort order of an acceptance criterion within its task.',
  requiredPermissions: ['mission:write'],
  schema: missionAcceptanceReorderSchema,
  handler: handleMissionAcceptanceReorder,
});

export const missionAcceptanceTools = [
  missionAcceptanceCreateTool,
  missionAcceptanceUpdateTool,
  missionAcceptanceReorderTool,
] as const;
