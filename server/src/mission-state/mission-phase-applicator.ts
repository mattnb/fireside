import type { Database } from 'better-sqlite3';
import type { AgentId } from '../agents/types.js';
import type { ParsedMissionPhaseUpdate } from '../mission-phase-updates.js';
import type { CreateAgentRunActionInput } from '../repos/run-actions.js';
import {
  createTaskPhase,
  listTaskPhases,
  updateTaskPhase,
  type TaskPhase,
  type UpdateTaskPhaseInput,
} from '../repos/task-phases.js';
import { listTaskPlans } from '../repos/task-plans.js';
import { getTask, type Task } from '../repos/tasks.js';
import {
  isPlanClearRef,
  resolvePhase,
  resolvePlanId,
} from './mission-state-helpers.js';

export interface ApplyMissionPhaseUpdatesInput {
  db: Database;
  roomId: string;
  task: Task | null;
  runId: string;
  agentId: AgentId;
  updates: ParsedMissionPhaseUpdate[];
  defaultPlanId: string | null;
  forcePlanOnUpdates: boolean;
  recordRunAction: (input: CreateAgentRunActionInput) => void;
  onTaskUpdated?: (task: Task) => void;
  autoAdvancePhase?: (input: {
    roomId: string;
    task: Task;
    runId: string;
    agentId: AgentId;
    completedPhase: TaskPhase | null;
  }) => void;
}

export function applyMissionPhaseUpdates(input: ApplyMissionPhaseUpdatesInput): void {
  if (input.updates.length === 0) return;
  if (!input.task) {
    input.recordRunAction({
      roomId: input.roomId,
      taskId: null,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'diagnostic',
      status: 'failed',
      label: 'mission phase update ignored',
      detail: 'no active mission',
    });
    return;
  }

  let phases = listTaskPhases(input.db, input.task.id);
  const plans = listTaskPlans(input.db, input.task.id);
  let lastCompletedPhase: TaskPhase | null = null;
  for (const update of input.updates) {
    const existing =
      update.action === 'create'
        ? null
        : (update.id ? resolvePhase(phases, update.id) : null) ??
          (update.title ? resolvePhase(phases, update.title) : null);
    const shouldCreate = update.action === 'create' || (!existing && update.title);
    const appliedAction = shouldCreate ? 'create' : update.action;
    const hasPlanRef = update.planRef.trim().length > 0;
    const explicitPlanId = hasPlanRef ? resolvePlanId(plans, update.planRef) : null;
    if (hasPlanRef && !explicitPlanId && !isPlanClearRef(update.planRef)) {
      input.recordRunAction({
        roomId: input.roomId,
        taskId: input.task.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission phase plan unresolved',
        detail: update.planRef,
      });
      continue;
    }
    const planId = hasPlanRef
      ? explicitPlanId
      : shouldCreate || input.forcePlanOnUpdates
        ? input.defaultPlanId
        : null;
    const patch: UpdateTaskPhaseInput = {
      ...(hasPlanRef || input.forcePlanOnUpdates ? { planId } : {}),
      ...(update.title ? { title: update.title.slice(0, 160) } : {}),
      ...(update.description ? { description: update.description.slice(0, 2000) } : {}),
      ...(update.status ? { status: update.status } : {}),
      ...(update.gate ? { gate: update.gate.slice(0, 2000) } : {}),
      ...(update.sortOrder !== null ? { sortOrder: update.sortOrder } : {}),
    };

    const phase = shouldCreate
      ? createTaskPhase(input.db, {
          taskId: input.task.id,
          planId,
          title: update.title.slice(0, 160),
          description: update.description.slice(0, 2000),
          status: update.status ?? (phases.length === 0 ? 'active' : 'planned'),
          gate: update.gate.slice(0, 2000),
          sortOrder: update.sortOrder ?? phases.length + 1,
        })
      : existing
        ? updateTaskPhase(input.db, existing.id, patch)
        : null;

    if (!phase) {
      input.recordRunAction({
        roomId: input.roomId,
        taskId: input.task.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission phase update ignored',
        detail: update.id || update.title || 'unknown phase',
      });
      continue;
    }

    phases = listTaskPhases(input.db, input.task.id);
    if (phase.status === 'done') lastCompletedPhase = phase;
    input.recordRunAction({
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: 'completed',
      label: `mission phase ${appliedAction}`,
      detail: `${phase.title} (${phase.status})`,
    });
  }

  if (lastCompletedPhase) {
    input.autoAdvancePhase?.({
      roomId: input.roomId,
      task: input.task,
      runId: input.runId,
      agentId: input.agentId,
      completedPhase: lastCompletedPhase,
    });
  }
  const updatedTask = getTask(input.db, input.task.id);
  if (updatedTask) input.onTaskUpdated?.(updatedTask);
}
