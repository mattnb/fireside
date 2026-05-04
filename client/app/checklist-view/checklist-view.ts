// client/app/checklist-view/checklist-view.ts
// Phase-grouped checklist with item rows, sub-info, and an add-item form.
// Owns its own UI selection state: which phases are collapsed, the
// "compact completed" toggle, and the auto-collapse-on-first-sight effect
// for done phases. Reads the active checklist from MissionStore directly;
// emits (taskControlChanged) when a mutation lands so the parent can refresh.

import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { AgentDisplayService } from '../agent-display.service';
import { FiresideApi } from '../api.service';
import { MissionStore } from '../mission-store';
import type { AgentId, Task, TaskChecklistItem, TaskPhaseStatus } from '../api.types';

@Component({
  selector: 'fs-checklist-view',
  standalone: true,
  templateUrl: './checklist-view.html',
  styleUrl: './checklist-view.css',
})
export class ChecklistView {
  private readonly api = inject(FiresideApi);
  private readonly store = inject(MissionStore);
  protected readonly display = inject(AgentDisplayService);

  readonly roomId = input<string | null>(null);
  readonly task = input<Task | null>(null);
  readonly roomAgents = input<AgentId[]>([]);
  readonly authorName = input<string>('human');

  readonly planLabel = input<(planId: string | null | undefined) => string>(
    (id) => id ?? '',
  );

  readonly taskControlChanged = output<void>();

  readonly taskControl = this.store.taskControl;

  readonly collapsedPhases = signal<Set<string>>(new Set());
  private autoCollapsedPhases = new Set<string>();

  readonly compactCompleted = signal(
    typeof localStorage !== 'undefined' &&
      localStorage.getItem('fireside.collapseCompletedChecklist') !== 'false',
  );

  readonly phases = computed(() => this.taskControl()?.phases ?? []);

  readonly unphasedItems = computed<TaskChecklistItem[]>(() => {
    const control = this.taskControl();
    if (!control) return [];
    const phaseIds = new Set(control.phases.map((p) => p.id));
    return control.checklistItems.filter((item) => !item.phaseId || !phaseIds.has(item.phaseId));
  });

  constructor() {
    effect(() => {
      const phases = this.phases();
      untracked(() => {
        const seen = this.autoCollapsedPhases;
        const newlyCollapse: string[] = [];
        for (const phase of phases) {
          if (phase.status === 'done' && !seen.has(phase.id)) {
            seen.add(phase.id);
            newlyCollapse.push(phase.id);
          }
        }
        if (newlyCollapse.length > 0) {
          const set = new Set(this.collapsedPhases());
          for (const id of newlyCollapse) set.add(id);
          this.collapsedPhases.set(set);
        }
      });
    });
  }

  togglePhaseCollapsed(phaseId: string): void {
    const set = new Set(this.collapsedPhases());
    if (set.has(phaseId)) set.delete(phaseId);
    else set.add(phaseId);
    this.collapsedPhases.set(set);
  }

  isPhaseCollapsed(phaseId: string): boolean {
    return this.collapsedPhases().has(phaseId);
  }

  phaseItems(phaseId: string): TaskChecklistItem[] {
    return this.taskControl()?.checklistItems.filter((item) => item.phaseId === phaseId) ?? [];
  }

  phaseProgressPercent(phaseId: string): number {
    const items = this.phaseItems(phaseId);
    if (items.length === 0) return 0;
    const done = items.filter(
      (item) => item.status === 'done' || item.status === 'skipped',
    ).length;
    return Math.round((done / items.length) * 100);
  }

  phaseProgressLabel(phaseId: string): string {
    const items = this.phaseItems(phaseId);
    const done = items.filter(
      (item) => item.status === 'done' || item.status === 'skipped',
    ).length;
    return `${done} of ${items.length}`;
  }

  phaseStatusLabel(status: TaskPhaseStatus): string {
    if (status === 'active') return 'active';
    if (status === 'done') return 'complete';
    if (status === 'blocked') return 'blocked';
    return 'queued';
  }

  itemStatusLabel(item: TaskChecklistItem): string {
    if (item.status === 'blocked') return 'blocked';
    if (item.status === 'done') return 'done';
    if (item.status === 'skipped') return 'skipped';
    if (this.isWaitingOnDependencies(item)) return 'waiting';
    return 'open';
  }

  isWaitingOnDependencies(item: TaskChecklistItem): boolean {
    const items = this.taskControl()?.checklistItems ?? [];
    return item.dependencyIds.some((id) => {
      const dependency = items.find((candidate) => candidate.id === id);
      return (
        dependency !== undefined && dependency.status !== 'done' && dependency.status !== 'skipped'
      );
    });
  }

  isItemCollapsed(item: TaskChecklistItem): boolean {
    return this.compactCompleted() && item.status === 'done';
  }

  checklistNotes(itemId: string) {
    return (this.taskControl()?.checklistNotes ?? []).filter((note) => note.itemId === itemId);
  }

  dependencyLabels(item: TaskChecklistItem): string {
    const items = this.taskControl()?.checklistItems ?? [];
    return item.dependencyIds
      .map((id) => items.find((candidate) => candidate.id === id)?.title ?? id)
      .join(', ');
  }

  setCompactCompleted(event: Event): void {
    const checked = event.target instanceof HTMLInputElement ? event.target.checked : false;
    this.compactCompleted.set(checked);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('fireside.collapseCompletedChecklist', String(checked));
    }
  }

  toggleItem(item: TaskChecklistItem, event: Event): void {
    const roomId = this.roomId();
    const task = this.task();
    const checked = event.target instanceof HTMLInputElement ? event.target.checked : false;
    if (!roomId || !task) return;
    this.api.tasks
      .updateChecklistItem(roomId, task.id, item.id, {
        status: checked ? 'done' : 'open',
        statusNote: checked ? `${this.authorName()} marked this complete.` : '',
      })
      .subscribe(() => this.taskControlChanged.emit());
  }

  assignOwner(item: TaskChecklistItem, event: Event): void {
    const roomId = this.roomId();
    const task = this.task();
    const ownerAgentId = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (!roomId || !task) return;
    this.api.tasks
      .updateChecklistItem(roomId, task.id, item.id, {
        ownerAgentId,
        statusNote: ownerAgentId
          ? `${this.display.name(ownerAgentId)} took ownership of this work item.`
          : `${this.authorName()} cleared the owner.`,
      })
      .subscribe(() => this.taskControlChanged.emit());
  }

  addItem(
    titleInput: HTMLInputElement,
    detailInput: HTMLTextAreaElement,
    phaseInput: HTMLSelectElement,
    dependenciesInput: HTMLInputElement,
    ownerInput: HTMLSelectElement,
  ): void {
    const roomId = this.roomId();
    const task = this.task();
    const title = titleInput.value.trim();
    if (!roomId || !task || !title) return;
    const control = this.taskControl();
    this.api.tasks
      .createChecklistItem(roomId, task.id, {
        title,
        detail: detailInput.value.trim(),
        planId:
          control?.phases.find((phase) => phase.id === phaseInput.value)?.planId ??
          control?.activePlan?.id ??
          null,
        phaseId: phaseInput.value || null,
        dependencyIds: this.parseDependencies(dependenciesInput.value),
        ownerAgentId: ownerInput.value,
        status: 'open',
        sortOrder: (control?.checklistItems.length ?? 0) + 1,
      })
      .subscribe(() => {
        titleInput.value = '';
        detailInput.value = '';
        phaseInput.value = '';
        dependenciesInput.value = '';
        ownerInput.value = '';
        this.taskControlChanged.emit();
      });
  }

  private parseDependencies(value: string): string[] {
    const items = this.taskControl()?.checklistItems ?? [];
    return [
      ...new Set(
        value
          .split(/,|;/)
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const lower = part.toLowerCase();
            return (
              items.find((item) => item.id === part)?.id ??
              items.find((item) => item.title.toLowerCase() === lower)?.id ??
              part
            );
          }),
      ),
    ];
  }
}
