// client/app/task-inspector-modal/task-inspector-modal.ts
// Mission Control task inspector dialog. Renders one MissionGraphCard with
// reference / metadata / parallel scope / status controls / notes form /
// dependencies-and-dependents / linked-runs-and-history sections. Pure
// presentational shell — every helper is an input fn, lifecycle events
// (status change, owner assignment, notes save, run-open requests) bubble
// out as outputs. Follows the run-detail-modal modal pattern: scrim click
// + close button both fire `(closed)`.

import { Component, inject, input, output } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import type { MissionGraphCard } from '../mission-graph';
import type {
  AgentId,
  AgentRun,
  TaskChecklistItem,
  TaskChecklistNote,
  TaskChecklistStatus,
} from '../api.types';

@Component({
  selector: 'fs-task-inspector-modal',
  standalone: true,
  templateUrl: './task-inspector-modal.html',
  styleUrl: './task-inspector-modal.css',
})
export class TaskInspectorModal {
  protected readonly display = inject(AgentDisplayService);

  readonly card = input.required<MissionGraphCard>();
  readonly roomAgents = input<AgentId[]>([]);
  readonly checklistStatuses = input<TaskChecklistStatus[]>([
    'open',
    'blocked',
    'done',
    'skipped',
  ]);

  readonly planLabel = input<(planId: string | null | undefined) => string>(() => '');
  readonly formatDateTime = input<(timestamp: number | undefined | null) => string>(() => '');
  readonly runMeta = input<(run: AgentRun) => string>(() => '');
  readonly runActionSignal = input<(run: AgentRun) => string>(() => '');

  readonly phaseLabel = input<(item: TaskChecklistItem) => string>(() => '');
  readonly scopeContractLabel = input<(item: TaskChecklistItem) => string>(() => '');
  readonly expectedTouchesLabel = input<(item: TaskChecklistItem) => string>(() => '');
  readonly blockedSummary = input<(card: MissionGraphCard) => string>(() => '');
  readonly reference = input<(card: MissionGraphCard) => string>(() => '');
  readonly notes = input<(itemId: string) => TaskChecklistNote[]>(() => []);

  readonly closed = output<void>();
  readonly idCopyRequested = output<TaskChecklistItem>();
  readonly referenceCopyRequested = output<MissionGraphCard>();
  readonly missionBlockCopyRequested = output<MissionGraphCard>();
  readonly statusChanged = output<{ item: TaskChecklistItem; event: Event }>();
  readonly ownerAssigned = output<{ item: TaskChecklistItem; event: Event }>();
  readonly reopenRequested = output<TaskChecklistItem>();
  readonly markDoneRequested = output<TaskChecklistItem>();
  readonly notesSaved = output<{
    item: TaskChecklistItem;
    statusNoteInput: HTMLTextAreaElement;
    blockedReasonInput: HTMLTextAreaElement;
    councilInput: HTMLInputElement;
  }>();
  readonly runOpened = output<string>();
}
