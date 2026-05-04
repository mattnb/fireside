// client/app/roadmap-view/roadmap-view.ts
// Master-detail roadmap: phase navigator on the left, status-filtered card
// feed on the right. Owns selectedPhaseId and statusFilter UI state.
// Add-phase form sits at the bottom of the nav and emits (phaseAdded) so the
// parent can refresh task control.

import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { pad2 } from '../formatters';
import type { MissionGraphCard, MissionGraphLane } from '../mission-graph';
import type { TaskChecklistItem, TaskPhaseStatus } from '../api.types';

export type RoadmapStatusFilter = 'ready' | 'in-progress' | 'blocked' | 'done';

@Component({
  selector: 'fs-roadmap-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './roadmap-view.html',
  styleUrl: './roadmap-view.css',
})
export class RoadmapView {
  protected readonly display = inject(AgentDisplayService);

  readonly lanes = input<MissionGraphLane[]>([]);
  readonly summary = input<{
    itemsDone: number;
    itemsTotal: number;
    phasesDone: number;
    phasesTotal: number;
    ready: number;
    blocked: number;
    evidence: number;
    artifacts: number;
    collaboration: number;
  } | null>(null);
  readonly hasActiveTask = input<boolean>(false);
  readonly hasTaskControl = input<boolean>(false);
  readonly currentPhaseId = input<string | null>(null);
  readonly selectedItemId = input<string>('');

  readonly runLabel = input<(card: MissionGraphCard) => string>(() => '');
  readonly notePreview = input<(card: MissionGraphCard) => string>(() => '');

  readonly itemFocused = output<TaskChecklistItem>();
  readonly runOpened = output<{ card: MissionGraphCard; event: Event }>();
  readonly idCopied = output<{ id: string; event: Event }>();
  readonly phaseAdded = output<{
    title: string;
    gate: string;
    status: TaskPhaseStatus;
  }>();

  readonly selectedPhaseId = signal<string | null>(null);
  readonly statusFilter = signal<RoadmapStatusFilter | null>(null);

  readonly selectedLane = computed<MissionGraphLane | null>(() => {
    const lanes = this.lanes();
    if (lanes.length === 0) return null;
    const selectedId = this.selectedPhaseId();
    if (selectedId) {
      const found = lanes.find((l) => l.id === selectedId);
      if (found) return found;
    }
    const activePhaseId = this.currentPhaseId();
    if (activePhaseId) {
      const active = lanes.find((l) => l.phase?.id === activePhaseId);
      if (active) return active;
    }
    return lanes[0] ?? null;
  });

  readonly filteredCards = computed<MissionGraphCard[]>(() => {
    const lane = this.selectedLane();
    if (!lane) return [];
    const filter = this.statusFilter();
    if (!filter) return lane.cards;
    return lane.cards.filter((card) => {
      if (filter === 'ready') return card.ready;
      if (filter === 'in-progress') return !!card.activeRun;
      if (filter === 'blocked') return card.item.status === 'blocked' || card.waiting;
      return card.item.status === 'done';
    });
  });

  selectPhase(laneId: string): void {
    this.selectedPhaseId.set(laneId);
    this.statusFilter.set(null);
  }

  toggleStatusFilter(filter: RoadmapStatusFilter): void {
    this.statusFilter.update((current) => (current === filter ? null : filter));
  }

  clearStatusFilter(): void {
    this.statusFilter.set(null);
  }

  phaseProgressPercent(lane: MissionGraphLane): number {
    if (!lane.counts.total) return 0;
    return Math.round((lane.counts.done / lane.counts.total) * 100);
  }

  phaseSubline(lane: MissionGraphLane): string {
    const parts: string[] = [];
    parts.push(lane.status);
    if (lane.counts.ready) parts.push(`${lane.counts.ready} ready`);
    if (lane.counts.blocked) parts.push(`${lane.counts.blocked} blocked`);
    return parts.join(' · ');
  }

  statusBucketCount(lane: MissionGraphLane | null, bucket: RoadmapStatusFilter): number {
    if (!lane) return 0;
    if (bucket === 'ready') return lane.cards.filter((c) => c.ready).length;
    if (bucket === 'in-progress') return lane.cards.filter((c) => !!c.activeRun).length;
    if (bucket === 'blocked')
      return lane.cards.filter((c) => c.item.status === 'blocked' || c.waiting).length;
    return lane.cards.filter((c) => c.item.status === 'done').length;
  }

  cardClass(card: MissionGraphCard): string {
    return `is-${card.tone}`;
  }

  pad2(value: number): string {
    return pad2(value);
  }

  shortTaskId(id: string): string {
    return id.length > 10 ? id.slice(0, 10) : id;
  }

  focusItem(item: TaskChecklistItem): void {
    this.itemFocused.emit(item);
  }

  openRun(card: MissionGraphCard, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (!card.activeRun && !card.latestRun) return;
    this.runOpened.emit({ card, event });
  }

  copyId(id: string, event: Event): void {
    this.idCopied.emit({ id, event });
  }

  submitPhase(
    titleInput: HTMLInputElement,
    gateInput: HTMLTextAreaElement,
    statusInput: HTMLSelectElement,
  ): void {
    const title = titleInput.value.trim();
    if (!title) return;
    this.phaseAdded.emit({
      title,
      gate: gateInput.value.trim(),
      status: statusInput.value as TaskPhaseStatus,
    });
    titleInput.value = '';
    gateInput.value = '';
    statusInput.value = 'planned';
  }
}
