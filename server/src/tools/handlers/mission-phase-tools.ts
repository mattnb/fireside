import { createAgentRunAction } from '../../repos/run-actions.js';
import { getActiveTask, getTask } from '../../repos/tasks.js';
import { applyMissionPhaseUpdates } from '../../mission-state/mission-phase-applicator.js';
import { resolvePhase } from '../../mission-state/mission-state-helpers.js';
import type { ParsedMissionPhaseUpdate } from '../../mission-phase-updates.js';
import { listTaskPhases, type TaskPhase } from '../../repos/task-phases.js';
import { defineTool } from '../registry.js';
import {
  missionPhaseCompleteSchema,
  missionPhaseCreateSchema,
  missionPhaseReopenSchema,
  missionPhaseUpdateSchema,
  type MissionPhaseCompleteArgs,
  type MissionPhaseCreateArgs,
  type MissionPhaseReopenArgs,
  type MissionPhaseUpdateArgs,
} from '../schemas/mission-phase.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

function missionForCall(input: AgentToolHandlerInput<unknown>) {
  return input.call.missionId
    ? getTask(input.db, input.call.missionId)
    : getActiveTask(input.db, input.call.roomId);
}

function activePlanId(phases: TaskPhase[]): string | null {
  return phases.find((phase) => phase.status === 'active')?.planId ?? null;
}

function runPhaseApplicator(
  input: AgentToolHandlerInput<unknown>,
  update: ParsedMissionPhaseUpdate,
): AgentToolResult {
  const mission = missionForCall(input);
  if (!mission) {
    return {
      status: 'rejected',
      summary: `${input.call.tool} rejected: no active mission`,
      effects: [],
    };
  }

  const before = listTaskPhases(input.db, mission.id);
  const runActions: { label: string; detail: string; status: string }[] = [];
  const runId = input.call.runId;
  applyMissionPhaseUpdates({
    db: input.db,
    roomId: input.call.roomId,
    task: mission,
    runId: runId ?? input.call.id,
    agentId: input.call.agentId,
    updates: [update],
    defaultPlanId: activePlanId(before),
    forcePlanOnUpdates: false,
    recordRunAction: (action) => {
      runActions.push({ label: action.label, detail: action.detail ?? '', status: action.status });
      if (runId) createAgentRunAction(input.db, action);
    },
  });

  const applied = runActions.some(
    (action) => action.status === 'completed' && action.label.startsWith('mission phase '),
  );
  const after = listTaskPhases(input.db, mission.id);
  const phase =
    after.find((candidate) => update.id && candidate.id === update.id) ??
    after.find((candidate) => update.title && candidate.title === update.title) ??
    resolvePhase(after, update.id || update.title) ??
    null;

  if (!applied) {
    const diagnostic = runActions.find((action) => action.status === 'failed');
    return {
      status: 'rejected',
      summary:
        diagnostic?.detail ||
        `${input.call.tool} rejected: ${update.id || update.title || 'phase'} was not updated`,
      data: { diagnostic, phase },
      effects: [],
    };
  }

  return {
    status: 'applied',
    summary: `${input.call.tool} applied to ${phase?.title ?? (update.id || update.title)}`,
    data: { phase, action: update.action, status: update.status },
    effects: [
      {
        kind: 'phase-updated',
        targetType: 'task-phase',
        ...(phase ? { targetId: phase.id } : {}),
        summary: `Updated mission phase ${phase?.title ?? (update.id || update.title)}`,
        payload: { phase, action: update.action, status: update.status },
      },
    ],
  };
}

export function handleMissionPhaseCreate(
  input: AgentToolHandlerInput<MissionPhaseCreateArgs>,
): AgentToolResult {
  return runPhaseApplicator(input, {
    action: 'create',
    id: '',
    planRef: input.args.plan ?? '',
    title: input.args.title,
    description: input.args.description ?? '',
    status: input.args.status ?? null,
    gate: input.args.gate ?? '',
    sortOrder: input.args.sortOrder ?? null,
  });
}

export function handleMissionPhaseUpdate(
  input: AgentToolHandlerInput<MissionPhaseUpdateArgs>,
): AgentToolResult {
  return runPhaseApplicator(input, {
    action: 'update',
    id: input.args.phaseId,
    planRef: input.args.plan ?? '',
    title: input.args.title ?? '',
    description: input.args.description ?? '',
    status: input.args.status ?? null,
    gate: input.args.gate ?? '',
    sortOrder: input.args.sortOrder ?? null,
  });
}

export function handleMissionPhaseComplete(
  input: AgentToolHandlerInput<MissionPhaseCompleteArgs>,
): AgentToolResult {
  return runPhaseApplicator(input, {
    action: 'update',
    id: input.args.phaseId,
    planRef: '',
    title: '',
    description: '',
    status: 'done',
    gate: '',
    sortOrder: null,
  });
}

export function handleMissionPhaseReopen(
  input: AgentToolHandlerInput<MissionPhaseReopenArgs>,
): AgentToolResult {
  return runPhaseApplicator(input, {
    action: 'update',
    id: input.args.phaseId,
    planRef: '',
    title: '',
    description: '',
    status: input.args.status ?? 'active',
    gate: '',
    sortOrder: null,
  });
}

export const missionPhaseCreateTool = defineTool<MissionPhaseCreateArgs>({
  name: 'mission.phase.create',
  summary: 'Create a mission phase gate.',
  requiredPermissions: ['mission:write'],
  schema: missionPhaseCreateSchema,
  handler: handleMissionPhaseCreate,
});

export const missionPhaseUpdateTool = defineTool<MissionPhaseUpdateArgs>({
  name: 'mission.phase.update',
  summary: 'Revise an unfinished mission phase gate.',
  requiredPermissions: ['mission:write'],
  schema: missionPhaseUpdateSchema,
  handler: handleMissionPhaseUpdate,
});

export const missionPhaseCompleteTool = defineTool<MissionPhaseCompleteArgs>({
  name: 'mission.phase.complete',
  summary: 'Complete a phase after unfinished checklist validation passes.',
  requiredPermissions: ['mission:admin'],
  schema: missionPhaseCompleteSchema,
  handler: handleMissionPhaseComplete,
});

export const missionPhaseReopenTool = defineTool<MissionPhaseReopenArgs>({
  name: 'mission.phase.reopen',
  summary: 'Reopen a completed or blocked phase gate.',
  requiredPermissions: ['mission:admin'],
  schema: missionPhaseReopenSchema,
  handler: handleMissionPhaseReopen,
});

export const missionPhaseTools = [
  missionPhaseCreateTool,
  missionPhaseUpdateTool,
  missionPhaseCompleteTool,
  missionPhaseReopenTool,
] as const;
