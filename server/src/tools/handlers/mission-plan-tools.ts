import { createAgentRunAction } from '../../repos/run-actions.js';
import { getActiveTask, getTask } from '../../repos/tasks.js';
import { applyMissionPlanUpdates } from '../../mission-state/mission-plan-applicator.js';
import type { ParsedMissionPlanUpdate } from '../../mission-plan-updates.js';
import { defineTool } from '../registry.js';
import {
  missionPlanActivateSchema,
  missionPlanArchiveSchema,
  missionPlanCreateSchema,
  missionPlanUpdateSchema,
  type MissionPlanActivateArgs,
  type MissionPlanArchiveArgs,
  type MissionPlanCreateArgs,
  type MissionPlanUpdateArgs,
} from '../schemas/mission-plan.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

function missionForCall(input: AgentToolHandlerInput<unknown>) {
  return input.call.missionId
    ? getTask(input.db, input.call.missionId)
    : getActiveTask(input.db, input.call.roomId);
}

function runPlanApplicator(
  input: AgentToolHandlerInput<unknown>,
  update: ParsedMissionPlanUpdate,
): AgentToolResult {
  const mission = missionForCall(input);
  if (!mission) {
    return {
      status: 'rejected',
      summary: `${input.call.tool} rejected: no active mission`,
      effects: [],
    };
  }

  const runActions: { label: string; status: string }[] = [];
  const runId = input.call.runId;
  const activePlan = applyMissionPlanUpdates({
    db: input.db,
    roomId: input.call.roomId,
    task: mission,
    runId: runId ?? input.call.id,
    agentId: input.call.agentId,
    updates: [update],
    recordRunAction: (action) => {
      runActions.push({ label: action.label, status: action.status });
      if (runId) createAgentRunAction(input.db, action);
    },
  });

  const applied = runActions.some(
    (action) => action.status === 'completed' && action.label.startsWith('mission plan '),
  );
  if (!applied) {
    return {
      status: 'rejected',
      summary: `${input.call.tool} rejected: ${update.id || update.title || 'plan'} was not updated`,
      data: { activePlan },
      effects: [],
    };
  }

  return {
    status: 'applied',
    summary: `${input.call.tool} applied to ${update.id || update.title || activePlan?.title || 'plan'}`,
    data: { activePlan, action: update.action, status: update.status },
    effects: [
      {
        kind: 'plan-updated',
        targetType: 'task-plan',
        ...(activePlan ? { targetId: activePlan.id } : {}),
        summary: `Updated mission plan ${activePlan?.title ?? (update.id || update.title)}`,
        payload: { activePlan, action: update.action, status: update.status },
      },
    ],
  };
}

export function handleMissionPlanCreate(
  input: AgentToolHandlerInput<MissionPlanCreateArgs>,
): AgentToolResult {
  return runPlanApplicator(input, {
    action: 'create',
    id: '',
    title: input.args.title,
    body: input.args.body ?? '',
    status: input.args.status ?? null,
  });
}

export function handleMissionPlanUpdate(
  input: AgentToolHandlerInput<MissionPlanUpdateArgs>,
): AgentToolResult {
  return runPlanApplicator(input, {
    action: 'update',
    id: input.args.planId,
    title: input.args.title ?? '',
    body: input.args.body ?? '',
    status: null,
  });
}

export function handleMissionPlanActivate(
  input: AgentToolHandlerInput<MissionPlanActivateArgs>,
): AgentToolResult {
  return runPlanApplicator(input, {
    action: 'update',
    id: input.args.planId,
    title: '',
    body: '',
    status: 'active',
  });
}

export function handleMissionPlanArchive(
  input: AgentToolHandlerInput<MissionPlanArchiveArgs>,
): AgentToolResult {
  return runPlanApplicator(input, {
    action: 'update',
    id: input.args.planId,
    title: '',
    body: '',
    status: input.args.status ?? 'archived',
  });
}

export const missionPlanCreateTool = defineTool<MissionPlanCreateArgs>({
  name: 'mission.plan.create',
  summary: 'Create a mission plan.',
  requiredPermissions: ['mission:write'],
  schema: missionPlanCreateSchema,
  handler: handleMissionPlanCreate,
});

export const missionPlanUpdateTool = defineTool<MissionPlanUpdateArgs>({
  name: 'mission.plan.update',
  summary: 'Revise a mission plan title or body.',
  requiredPermissions: ['mission:write'],
  schema: missionPlanUpdateSchema,
  handler: handleMissionPlanUpdate,
});

export const missionPlanActivateTool = defineTool<MissionPlanActivateArgs>({
  name: 'mission.plan.activate',
  summary: 'Set the active mission plan.',
  requiredPermissions: ['mission:write'],
  schema: missionPlanActivateSchema,
  handler: handleMissionPlanActivate,
});

export const missionPlanArchiveTool = defineTool<MissionPlanArchiveArgs>({
  name: 'mission.plan.archive',
  summary: 'Archive or supersede a mission plan.',
  requiredPermissions: ['mission:write'],
  schema: missionPlanArchiveSchema,
  handler: handleMissionPlanArchive,
});

export const missionPlanTools = [
  missionPlanCreateTool,
  missionPlanUpdateTool,
  missionPlanActivateTool,
  missionPlanArchiveTool,
] as const;
