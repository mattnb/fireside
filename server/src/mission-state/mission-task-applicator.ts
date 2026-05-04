import type { Database } from 'better-sqlite3';
import type { AgentId } from '../agents/types.js';
import type { ParsedMissionTaskUpdate } from '../mission-task-updates.js';
import {
  createTaskChecklistItem,
  createTaskChecklistNote,
  listTaskChecklistItems,
  updateTaskChecklistItem,
  type TaskChecklistItem,
  type UpdateTaskChecklistItemInput,
} from '../repos/task-checklist.js';
import { listTaskPhases } from '../repos/task-phases.js';
import { listTaskPlans } from '../repos/task-plans.js';
import { getTask, updateTask as updateTaskRepo, type Task } from '../repos/tasks.js';
import type { CreateAgentRunActionInput } from '../repos/run-actions.js';
import {
  inferChecklistCompletion,
  isPlanClearRef,
  noteKindForMissionTaskUpdate,
  resolveChecklistItem,
  resolveDependencyIds,
  resolvePhaseId,
  resolvePlanId,
} from './mission-state-helpers.js';

export interface MissionTaskApplyResult {
  applied: number;
  progressed: number;
  dispatchCandidates: TaskChecklistItem[];
}

export interface ApplyMissionTaskUpdatesInput {
  db: Database;
  roomId: string;
  task: Task | null;
  runId: string;
  agentId: AgentId;
  updates: ParsedMissionTaskUpdate[];
  defaultPlanId: string | null;
  forcePlanOnUpdates: boolean;
  recordRunAction: (input: CreateAgentRunActionInput) => void;
  onTaskUpdated?: (task: Task) => void;
}

export function applyMissionTaskUpdates(
  input: ApplyMissionTaskUpdatesInput,
): MissionTaskApplyResult {
  const result: MissionTaskApplyResult = { applied: 0, progressed: 0, dispatchCandidates: [] };
  if (input.updates.length === 0) return result;
  if (!input.task) {
    input.recordRunAction({
      roomId: input.roomId,
      taskId: null,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'diagnostic',
      status: 'failed',
      label: 'mission task update ignored',
      detail: 'no active mission',
    });
    return result;
  }

  let anyCouncilBlock = false;
  let currentItems = listTaskChecklistItems(input.db, input.task.id);
  const phases = listTaskPhases(input.db, input.task.id);
  const plans = listTaskPlans(input.db, input.task.id);

  for (const update of input.updates) {
    const existing =
      update.action === 'create'
        ? null
        : resolveChecklistItem(currentItems, update.id || update.title);
    const phaseId = resolvePhaseId(phases, update.phaseRef);
    const phase =
      (phaseId ? (phases.find((candidate) => candidate.id === phaseId) ?? null) : null) ??
      (!update.phaseRef && existing?.phaseId
        ? (phases.find((candidate) => candidate.id === existing.phaseId) ?? null)
        : null);
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
        label: 'mission task plan unresolved',
        detail: update.planRef,
      });
      continue;
    }
    if (hasPlanRef && explicitPlanId && phase?.planId && explicitPlanId !== phase.planId) {
      input.recordRunAction({
        roomId: input.roomId,
        taskId: input.task.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission task plan mismatch',
        detail: `${update.title || update.id}: phase belongs to ${phase.planId}, request used ${explicitPlanId}`,
      });
      continue;
    }
    const planId =
      phase?.planId ??
      (hasPlanRef
        ? explicitPlanId
        : update.action === 'create' || input.forcePlanOnUpdates
          ? input.defaultPlanId
          : null);
    const dependencyIds = resolveDependencyIds(
      currentItems,
      update.dependencyRefs,
      existing?.id ?? '',
    );
    const effectiveStatus = update.status ?? (inferChecklistCompletion(update) ? 'done' : null);
    const basePatch: UpdateTaskChecklistItemInput = {
      ...(hasPlanRef || phase?.planId || input.forcePlanOnUpdates ? { planId } : {}),
      ...(update.title ? { title: update.title.slice(0, 240) } : {}),
      ...(update.detail ? { detail: update.detail.slice(0, 2000) } : {}),
      ...(effectiveStatus ? { status: effectiveStatus } : {}),
      ...(update.dependencyRefs.length > 0 ? { dependencyIds } : {}),
      ...(update.expectedTouches.length > 0 ? { expectedTouches: update.expectedTouches } : {}),
      ...(update.parallelism ? { parallelism: update.parallelism } : {}),
      ...(update.conflictGroup ? { conflictGroup: update.conflictGroup.slice(0, 160) } : {}),
      ...(update.workRole ? { workRole: update.workRole.slice(0, 80) } : {}),
      ...(update.ownerAgentId ? { ownerAgentId: update.ownerAgentId.slice(0, 80) } : {}),
      ...(update.statusNote ? { statusNote: update.statusNote.slice(0, 2000) } : {}),
      ...(update.blockedReason ? { blockedReason: update.blockedReason.slice(0, 2000) } : {}),
      ...(update.councilRequired !== null ? { councilRequired: update.councilRequired } : {}),
      ...(phaseId ? { phaseId } : {}),
      updatedBy: input.agentId,
    };

    const item =
      update.action === 'create'
        ? createTaskChecklistItem(input.db, {
            taskId: input.task.id,
            planId,
            phaseId,
            title: update.title.slice(0, 240),
            detail: update.detail.slice(0, 2000),
            status: effectiveStatus ?? 'open',
            dependencyIds,
            expectedTouches: update.expectedTouches,
            ...(update.parallelism ? { parallelism: update.parallelism } : {}),
            conflictGroup: update.conflictGroup.slice(0, 160),
            workRole: update.workRole.slice(0, 80),
            ownerAgentId: update.ownerAgentId.slice(0, 80),
            statusNote: update.statusNote.slice(0, 2000),
            blockedReason: update.blockedReason.slice(0, 2000),
            councilRequired: update.councilRequired === true,
            updatedBy: input.agentId,
            sortOrder: currentItems.length + 1,
          })
        : existing
          ? updateTaskChecklistItem(input.db, existing.id, basePatch)
          : null;

    if (!item) {
      input.recordRunAction({
        roomId: input.roomId,
        taskId: input.task.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission task update ignored',
        detail: update.id || update.title || 'unknown item',
      });
      continue;
    }

    const noteBody =
      update.note ||
      update.statusNote ||
      update.blockedReason ||
      (effectiveStatus ? `${item.title}: ${effectiveStatus}` : '');
    if (noteBody) {
      createTaskChecklistNote(input.db, {
        taskId: input.task.id,
        itemId: item.id,
        authorId: input.agentId,
        kind: noteKindForMissionTaskUpdate(update),
        body: noteBody.slice(0, 4000),
      });
    }
    if (item.status === 'blocked' && item.councilRequired) anyCouncilBlock = true;
    result.applied += 1;
    if (update.action === 'create' || checklistUpdateChangedExecutionState(existing, item)) {
      result.progressed += 1;
    }
    if (item.ownerAgentId && item.status === 'open') {
      result.dispatchCandidates.push(item);
    }
    currentItems = listTaskChecklistItems(input.db, input.task.id);
    input.recordRunAction({
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: 'completed',
      label: `mission task ${update.action}`,
      detail: `${item.title} (${item.status})`,
    });
  }

  if (anyCouncilBlock && input.task.status !== 'blocked') {
    updateTaskRepo(input.db, input.task.id, {
      status: 'blocked',
      summary: input.task.summary || 'Blocked checklist item requires council action.',
    });
  }
  const updatedTask = getTask(input.db, input.task.id);
  if (updatedTask) input.onTaskUpdated?.(updatedTask);
  return result;
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function checklistUpdateChangedExecutionState(
  previous: TaskChecklistItem | null,
  next: TaskChecklistItem,
): boolean {
  if (!previous) return true;
  return (
    previous.planId !== next.planId ||
    previous.phaseId !== next.phaseId ||
    previous.title !== next.title ||
    previous.detail !== next.detail ||
    previous.status !== next.status ||
    !stringArraysEqual(previous.dependencyIds, next.dependencyIds) ||
    !stringArraysEqual(previous.expectedTouches, next.expectedTouches) ||
    previous.parallelism !== next.parallelism ||
    previous.conflictGroup !== next.conflictGroup ||
    previous.workRole !== next.workRole ||
    previous.ownerAgentId !== next.ownerAgentId ||
    previous.blockedReason !== next.blockedReason ||
    previous.councilRequired !== next.councilRequired
  );
}
