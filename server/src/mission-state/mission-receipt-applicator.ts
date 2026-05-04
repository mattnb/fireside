import type { Database } from 'better-sqlite3';
import type { AgentId } from '../agents/types.js';
import type { ParsedMissionReceipt } from '../mission-receipts.js';
import type { CreateAgentRunActionInput } from '../repos/run-actions.js';
import {
  createTaskChecklistNote,
  getTaskChecklistItem,
  listTaskChecklistItems,
  updateTaskChecklistItem,
  type TaskChecklistItem,
  type UpdateTaskChecklistItemInput,
} from '../repos/task-checklist.js';
import {
  listTaskPhases,
  updateTaskPhase,
  type TaskPhase,
} from '../repos/task-phases.js';
import { getTask, type Task } from '../repos/tasks.js';
import type { WorkLaneAssignment } from '../orchestration/work-lane-planner.js';
import { resolveChecklistItem, resolvePhase } from './mission-state-helpers.js';
import {
  phaseCompletionBlockedDetail,
  unfinishedChecklistItemsForPhase,
} from './phase-completion.js';

export interface MissionReconciliationResult {
  applied: number;
  progressed: number;
  receiptUpdates: number;
  laneUpdates: number;
}

export interface RecordMissionReceiptsInput {
  roomId: string;
  task: Task | null;
  runId: string;
  agentId: AgentId;
  receipts: ParsedMissionReceipt[];
  recordRunAction: (input: CreateAgentRunActionInput) => void;
}

export interface ReconcileMissionStateInput {
  db: Database;
  roomId: string;
  task: Task | null;
  runId: string;
  agentId: AgentId;
  receipts: ParsedMissionReceipt[];
  visibleText: string;
  workLane: WorkLaneAssignment | undefined;
  explicitMissionUpdates: number;
  recordRunAction: (input: CreateAgentRunActionInput) => void;
  onTaskUpdated?: (task: Task) => void;
}

export function recordMissionReceipts(input: RecordMissionReceiptsInput): void {
  if (input.receipts.length === 0) return;
  if (!input.task) {
    for (const receipt of input.receipts) {
      input.recordRunAction({
        roomId: input.roomId,
        taskId: null,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission receipt ignored',
        detail: missionReceiptDetail(receipt, 'No active mission exists for this receipt.'),
      });
    }
    return;
  }

  for (const receipt of input.receipts) {
    const actionStatus: CreateAgentRunActionInput['status'] =
      receipt.status === 'completed'
        ? 'completed'
        : receipt.status === 'blocked'
          ? 'failed'
          : 'info';
    input.recordRunAction({
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: actionStatus,
      label: `mission receipt: ${receipt.status}`,
      detail: missionReceiptDetail(receipt),
    });
  }
}

export function reconcileMissionState(input: ReconcileMissionStateInput): MissionReconciliationResult {
  const result: MissionReconciliationResult = {
    applied: 0,
    progressed: 0,
    receiptUpdates: 0,
    laneUpdates: 0,
  };
  if (!input.task) return result;
  const task = input.task;

  const receiptTouchedItems = new Set<string>();
  for (const receipt of input.receipts) {
    const item = resolveReceiptChecklistItem(input.db, task, receipt, input.workLane);
    if (item) {
      const updated = reconcileChecklistItemFromReceipt({
        ...input,
        task,
        item,
        receipt,
      });
      if (updated > 0) {
        result.applied += updated;
        result.receiptUpdates += updated;
        if (receiptChecklistUpdateCountsAsProgress(receipt, item)) {
          result.progressed += updated;
        }
        receiptTouchedItems.add(item.id);
      }
    }

    const phase = receipt.phaseRef
      ? resolvePhase(listTaskPhases(input.db, task.id), receipt.phaseRef)
      : null;
    if (phase) {
      const updated = reconcilePhaseFromReceipt({
        ...input,
        task,
        phase,
        receipt,
      });
      if (updated > 0) {
        result.applied += updated;
        result.progressed += updated;
        result.receiptUpdates += updated;
      }
    }
  }

  if (
    input.workLane &&
    input.explicitMissionUpdates === 0 &&
    !receiptTouchedItems.has(input.workLane.item.id)
  ) {
    const updated = reconcileWorkLaneFromVisibleText(input);
    if (updated > 0) {
      result.applied += updated;
      result.progressed += updated;
      result.laneUpdates += updated;
    }
  }

  const phaseUpdates = reconcilePhasesFromChecklist(input);
  if (phaseUpdates > 0) {
    result.applied += phaseUpdates;
    result.progressed += phaseUpdates;
    result.receiptUpdates += phaseUpdates;
  }

  if (result.applied > 0) {
    input.recordRunAction({
      roomId: input.roomId,
      taskId: task.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: 'completed',
      label: 'mission state reconciled',
      detail: JSON.stringify(result),
    });
    const updatedTask = getTask(input.db, task.id);
    if (updatedTask) input.onTaskUpdated?.(updatedTask);
  }

  return result;
}

function receiptChecklistUpdateCountsAsProgress(
  receipt: ParsedMissionReceipt,
  item: TaskChecklistItem,
): boolean {
  if (receipt.status === 'completed' || receipt.status === 'blocked') return true;
  if (receipt.status === 'needs_review') return true;
  if (receipt.status !== 'continuing') return false;
  return !item.ownerAgentId;
}

function resolveReceiptChecklistItem(
  db: Database,
  task: Task,
  receipt: ParsedMissionReceipt,
  workLane: WorkLaneAssignment | undefined,
): TaskChecklistItem | null {
  const items = listTaskChecklistItems(db, task.id);
  if (receipt.itemRef) return resolveChecklistItem(items, receipt.itemRef);
  const canUseAssignedLane =
    workLane &&
    !receipt.phaseRef &&
    !receipt.planRef &&
    ['completed', 'blocked', 'needs_review', 'continuing'].includes(receipt.status);
  if (!canUseAssignedLane) return null;
  return getTaskChecklistItem(db, workLane.item.id);
}

function reconcileChecklistItemFromReceipt(input: {
  db: Database;
  roomId: string;
  task: Task;
  runId: string;
  agentId: AgentId;
  receipt: ParsedMissionReceipt;
  item: TaskChecklistItem;
  recordRunAction: (input: CreateAgentRunActionInput) => void;
}): number {
  const note = missionReceiptPlainNote(input.receipt);
  const patch: UpdateTaskChecklistItemInput = { updatedBy: input.agentId };
  let noteKind: 'status' | 'completion' | 'blocker' | 'council' = 'status';
  let label = '';

  if (input.receipt.status === 'completed') {
    if (input.item.status === 'done') return 0;
    patch.status = 'done';
    patch.statusNote = note || `${input.item.title}: completed`;
    patch.blockedReason = '';
    patch.councilRequired = false;
    noteKind = 'completion';
    label = 'reconciled checklist completion';
  } else if (input.receipt.status === 'blocked') {
    if (input.item.status === 'blocked' && !note) return 0;
    patch.status = 'blocked';
    patch.blockedReason = note || `${input.item.title}: blocked`;
    patch.councilRequired = receiptNeedsCouncil(input.receipt);
    noteKind = patch.councilRequired ? 'council' : 'blocker';
    label = 'reconciled checklist blocker';
  } else if (input.receipt.status === 'continuing' || input.receipt.status === 'needs_review') {
    if (!note && input.item.ownerAgentId) return 0;
    if (!input.item.ownerAgentId) patch.ownerAgentId = input.agentId;
    if (note) patch.statusNote = note;
    noteKind = 'status';
    label =
      input.receipt.status === 'needs_review'
        ? 'reconciled checklist review note'
        : 'reconciled checklist status note';
  } else {
    return 0;
  }

  const updated = updateTaskChecklistItem(input.db, input.item.id, patch);
  if (!updated) return 0;
  if (note || input.receipt.status === 'completed' || input.receipt.status === 'blocked') {
    createTaskChecklistNote(input.db, {
      taskId: input.task.id,
      itemId: updated.id,
      authorId: input.agentId,
      kind: noteKind,
      body: (note || `${updated.title}: ${updated.status}`).slice(0, 4000),
    });
  }
  input.recordRunAction({
    roomId: input.roomId,
    taskId: input.task.id,
    runId: input.runId,
    agentId: input.agentId,
    kind: 'ledger',
    status: input.receipt.status === 'blocked' ? 'failed' : 'completed',
    label,
    detail: `${updated.title} (${updated.status})`,
  });
  return 1;
}

function reconcilePhaseFromReceipt(input: {
  db: Database;
  roomId: string;
  task: Task;
  runId: string;
  agentId: AgentId;
  receipt: ParsedMissionReceipt;
  phase: TaskPhase;
  recordRunAction: (input: CreateAgentRunActionInput) => void;
}): number {
  const status =
    input.receipt.status === 'completed'
      ? 'done'
      : input.receipt.status === 'blocked'
        ? 'blocked'
        : null;
  if (!status || input.phase.status === status) return 0;
  if (status === 'done') {
    const unfinished = unfinishedChecklistItemsForPhase(input.db, input.task.id, input.phase.id);
    if (unfinished.length > 0) {
      input.recordRunAction({
        roomId: input.roomId,
        taskId: input.task.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission phase completion blocked',
        detail: phaseCompletionBlockedDetail(input.phase, unfinished),
      });
      return 0;
    }
  }
  const updated = updateTaskPhase(input.db, input.phase.id, { status });
  if (!updated) return 0;
  input.recordRunAction({
    roomId: input.roomId,
    taskId: input.task.id,
    runId: input.runId,
    agentId: input.agentId,
    kind: 'ledger',
    status: status === 'blocked' ? 'failed' : 'completed',
    label: status === 'done' ? 'reconciled phase completion' : 'reconciled phase blocker',
    detail: `${updated.title} (${updated.status})`,
  });
  if (status === 'done') {
    autoAdvancePhase({
      ...input,
      completedPhase: updated,
    });
  }
  return 1;
}

function reconcileWorkLaneFromVisibleText(input: ReconcileMissionStateInput): number {
  if (!input.task || !input.workLane) return 0;
  const item = getTaskChecklistItem(input.db, input.workLane.item.id);
  if (!item || item.status === 'done' || item.status === 'skipped') return 0;
  const signal = workLaneSignal(input.visibleText);
  if (signal === 'none') return 0;
  const note = oneLine(input.visibleText || `${item.title}: ${signal}`, 500);
  const patch: UpdateTaskChecklistItemInput = {
    updatedBy: input.agentId,
    ownerAgentId: item.ownerAgentId || input.agentId,
  };
  if (signal === 'done') {
    patch.status = 'done';
    patch.statusNote = note || `${item.title}: completed`;
    patch.blockedReason = '';
    patch.councilRequired = false;
  } else {
    patch.status = 'blocked';
    patch.blockedReason = note || `${item.title}: blocked`;
    patch.councilRequired =
      /\b(human|council|decision|intervene|intervention|approval|permission)\b/i.test(
        input.visibleText,
      );
  }
  const updated = updateTaskChecklistItem(input.db, item.id, patch);
  if (!updated) return 0;
  createTaskChecklistNote(input.db, {
    taskId: input.task.id,
    itemId: updated.id,
    authorId: input.agentId,
    kind: signal === 'done' ? 'completion' : patch.councilRequired ? 'council' : 'blocker',
    body: (note || `${updated.title}: ${updated.status}`).slice(0, 4000),
  });
  input.recordRunAction({
    roomId: input.roomId,
    taskId: input.task.id,
    runId: input.runId,
    agentId: input.agentId,
    kind: 'ledger',
    status: signal === 'done' ? 'completed' : 'failed',
    label: signal === 'done' ? 'reconciled lane completion' : 'reconciled lane blocker',
    detail: `${updated.title} (${updated.status})`,
  });
  return 1;
}

function reconcilePhasesFromChecklist(input: ReconcileMissionStateInput): number {
  if (!input.task) return 0;
  const phases = listTaskPhases(input.db, input.task.id);
  const items = listTaskChecklistItems(input.db, input.task.id);
  let applied = 0;
  for (const phase of phases) {
    if (phase.status === 'done' || phase.status === 'planned') continue;
    const phaseItems = items.filter((item) => item.phaseId === phase.id);
    if (phaseItems.length === 0) continue;
    if (!phaseItems.every((item) => item.status === 'done' || item.status === 'skipped')) {
      continue;
    }
    const updated = updateTaskPhase(input.db, phase.id, { status: 'done' });
    if (!updated) continue;
    applied += 1;
    input.recordRunAction({
      roomId: input.roomId,
      taskId: input.task.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: 'completed',
      label: 'reconciled phase from checklist',
      detail: `${updated.title} done; all ${phaseItems.length} checklist item(s) are closed`,
    });
    autoAdvancePhase({
      ...input,
      task: input.task,
      completedPhase: updated,
    });
  }
  return applied;
}

function nextPlannedPhaseAfter(phases: TaskPhase[], completedPhase: TaskPhase): TaskPhase | null {
  return (
    phases.find(
      (phase) =>
        phase.status === 'planned' &&
        (phase.sortOrder > completedPhase.sortOrder ||
          (phase.sortOrder === completedPhase.sortOrder &&
            phase.createdAt > completedPhase.createdAt)),
    ) ??
    phases.find((phase) => phase.status === 'planned') ??
    null
  );
}

export function autoAdvancePhase(input: {
  db: Database;
  roomId: string;
  task: Task;
  runId: string;
  agentId: AgentId;
  completedPhase: TaskPhase | null;
  recordRunAction: (input: CreateAgentRunActionInput) => void;
}): void {
  if (!input.completedPhase) return;
  const phases = listTaskPhases(input.db, input.task.id);
  if (phases.some((phase) => phase.status === 'active')) return;
  const refreshedCompleted =
    phases.find((phase) => phase.id === input.completedPhase?.id) ?? input.completedPhase;
  const nextPhase = nextPlannedPhaseAfter(phases, refreshedCompleted);
  if (!nextPhase) return;
  const advanced = updateTaskPhase(input.db, nextPhase.id, { status: 'active' });
  if (!advanced) return;
  input.recordRunAction({
    roomId: input.roomId,
    taskId: input.task.id,
    runId: input.runId,
    agentId: input.agentId,
    kind: 'ledger',
    status: 'completed',
    label: 'mission phase auto-advance',
    detail: `${refreshedCompleted.title} done; ${advanced.title} active`,
  });
}

export function missionReceiptPlainNote(receipt: ParsedMissionReceipt): string {
  return [
    receipt.summary,
    receipt.evidence ? `Evidence: ${receipt.evidence}` : '',
    receipt.next ? `Next: ${receipt.next}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function receiptNeedsCouncil(receipt: ParsedMissionReceipt): boolean {
  return /\b(human|council|decision|intervene|intervention|approval|permission|blocked by matt|waiting for matt)\b/i.test(
    [receipt.summary, receipt.evidence, receipt.next].filter(Boolean).join(' '),
  );
}

export function workLaneSignal(text: string): 'done' | 'blocked' | 'none' {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return 'none';
  if (
    /\b(blocked|stuck|unable|can't|cannot|could not|failed|failing|waiting on|waiting for|needs human|need human|requires human|requires council|permission denied)\b/.test(
      normalized,
    )
  ) {
    return 'blocked';
  }
  if (
    /\b(not done|not complete|not completed|incomplete|still pending|still open|remaining|remains|needs work|will continue|continuing next)\b/.test(
      normalized,
    )
  ) {
    return 'none';
  }
  if (
    /\b(done|complete|completed|finished|resolved|accepted|settled|merged|landed|implemented|verified|tests? pass(?:ed)?|green)\b/.test(
      normalized,
    )
  ) {
    return 'done';
  }
  return 'none';
}

export function missionReceiptDetail(
  receipt: ParsedMissionReceipt,
  fallback = 'Mission receipt recorded.',
): string {
  const refs = [
    receipt.planRef ? `plan ${receipt.planRef}` : '',
    receipt.phaseRef ? `phase ${receipt.phaseRef}` : '',
    receipt.itemRef ? `item ${receipt.itemRef}` : '',
  ].filter(Boolean);
  const message = [
    refs.length ? refs.join(' / ') : '',
    receipt.summary || receipt.evidence || receipt.next || fallback,
  ]
    .filter(Boolean)
    .join(': ');
  return JSON.stringify({
    message,
    status: receipt.status,
    ...(receipt.planRef ? { plan: receipt.planRef } : {}),
    ...(receipt.phaseRef ? { phase: receipt.phaseRef } : {}),
    ...(receipt.itemRef ? { item: receipt.itemRef } : {}),
    ...(receipt.summary ? { summary: receipt.summary } : {}),
    ...(receipt.evidence ? { evidence: receipt.evidence } : {}),
    ...(receipt.next ? { next: receipt.next } : {}),
  });
}

function oneLine(text: string, maxChars = 280): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}...`;
}
