import type { Database } from 'better-sqlite3';
import type { AgentId } from '../agents/types.js';
import type { ParsedMissionPlanUpdate } from '../mission-plan-updates.js';
import {
  createTaskPlan,
  listTaskPlans,
  updateTaskPlan,
  type TaskPlan,
  type UpdateTaskPlanInput,
} from '../repos/task-plans.js';
import type { CreateAgentRunActionInput } from '../repos/run-actions.js';
import { getTask, type Task } from '../repos/tasks.js';
import { resolvePlan } from './mission-state-helpers.js';

export interface ApplyMissionPlanUpdatesInput {
  db: Database;
  roomId: string;
  task: Task | null;
  runId: string;
  agentId: AgentId;
  updates: ParsedMissionPlanUpdate[];
  recordRunAction: (input: CreateAgentRunActionInput) => void;
  onTaskUpdated?: (task: Task) => void;
}

export function applyMissionPlanUpdates(input: ApplyMissionPlanUpdatesInput): TaskPlan | null {
  if (input.updates.length === 0) return null;
  if (!input.task) {
    input.recordRunAction({
      roomId: input.roomId,
      taskId: null,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'diagnostic',
      status: 'failed',
      label: 'mission plan update ignored',
      detail: 'no active mission',
    });
    return null;
  }

  let plans = listTaskPlans(input.db, input.task.id);
  let lastActivePlan: TaskPlan | null = null;
  for (const update of input.updates) {
    const existing =
      update.action === 'create' ? null : resolvePlan(plans, update.id || update.title);
    const shouldCreate = update.action === 'create' || (!existing && update.title);
    const appliedAction = shouldCreate ? 'create' : update.action;
    const patch: UpdateTaskPlanInput = {
      ...(update.title ? { title: update.title.slice(0, 180) } : {}),
      ...(update.body ? { body: update.body.slice(0, 20_000) } : {}),
      ...(update.status ? { status: update.status } : {}),
    };

    const plan = shouldCreate
      ? createTaskPlan(input.db, {
          taskId: input.task.id,
          title: update.title.slice(0, 180),
          body: update.body.slice(0, 20_000),
          status: update.status ?? 'active',
        })
      : existing
        ? updateTaskPlan(input.db, existing.id, patch)
        : null;

    if (!plan) {
      input.recordRunAction({
        roomId: input.roomId,
        taskId: input.task.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission plan update ignored',
        detail: update.id || update.title || 'active plan',
      });
      continue;
    }

    plans = listTaskPlans(input.db, input.task.id);
    if (plan.status === 'active') lastActivePlan = plan;
    input.recordRunAction({
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: 'completed',
      label: `mission plan ${appliedAction}`,
      detail: `${plan.title} (${plan.status})`,
    });
  }

  const updatedTask = getTask(input.db, input.task.id);
  if (updatedTask) input.onTaskUpdated?.(updatedTask);
  return lastActivePlan;
}
