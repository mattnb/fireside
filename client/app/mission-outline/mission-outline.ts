// client/app/mission-outline/mission-outline.ts
// Right-side rail in the chat tab. Replaces the old runs-rail with a
// mission-outline view: phase-grouped checklist items showing tone (done /
// active / waiting / blocked / ready / open), agent ownership, and a
// running pill + per-run stop button on cards with an in-flight run. Runs
// not tied to any checklist item surface in an "Other activity" footer.

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { MissionGraphService } from '../mission-graph.service';
import { MissionStore } from '../mission-store';
import { elapsedLabel as fmtElapsedLabel } from '../formatters';
import type { MissionGraphCard, MissionGraphLane } from '../mission-graph';
import type { AgentId, AgentRun } from '../api.types';

@Component({
  selector: 'fs-mission-outline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mission-outline.html',
  styleUrl: './mission-outline.css',
})
export class MissionOutline {
  protected readonly display = inject(AgentDisplayService);
  protected readonly graph = inject(MissionGraphService);
  protected readonly store = inject(MissionStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly now = signal(Date.now());

  readonly runOpened = output<string>();
  readonly runStopRequested = output<string>();
  readonly completedRunsRequested = output<void>();

  protected readonly lanes = computed(() =>
    this.graph.lanes().filter((lane) => lane.cards.length > 0),
  );
  protected readonly summary = computed(() => this.graph.summary());
  protected readonly missionTitle = computed(
    () => this.store.taskControl()?.task?.title ?? null,
  );
  protected readonly progressPercent = computed(() => {
    const s = this.summary();
    if (s.itemsTotal === 0) return 0;
    return Math.round((s.itemsDone / s.itemsTotal) * 100);
  });

  protected readonly orphanRunningRuns = computed<AgentRun[]>(() => {
    const linkedRunIds = new Set<string>();
    for (const lane of this.lanes()) {
      for (const card of lane.cards) {
        for (const run of card.linkedRuns) linkedRunIds.add(run.id);
      }
    }
    return this.store
      .runs()
      .filter((run) => run.status === 'running' && !linkedRunIds.has(run.id));
  });

  constructor() {
    const timer = window.setInterval(() => this.now.set(Date.now()), 1000);
    this.destroyRef.onDestroy(() => window.clearInterval(timer));
  }

  protected runDuration(run: AgentRun): string {
    return fmtElapsedLabel(run.startedAt, run.completedAt, this.now());
  }

  protected ownerAgentId(card: MissionGraphCard): AgentId | null {
    if (card.activeRun) return card.activeRun.agentId;
    if (card.item.ownerAgentId) return card.item.ownerAgentId as AgentId;
    return null;
  }

  protected pillLabelFor(card: MissionGraphCard): string | null {
    if (card.activeRun) return null;
    if (card.tone === 'blocked') return 'blocked';
    if (card.tone === 'waiting') return 'waiting';
    if (card.tone === 'ready') return 'ready';
    if (card.tone === 'skipped') return 'skipped';
    return null;
  }

  protected onPillClick(run: AgentRun, event: Event): void {
    event.stopPropagation();
    this.runOpened.emit(run.id);
  }

  protected onStopClick(run: AgentRun, event: Event): void {
    event.stopPropagation();
    this.runStopRequested.emit(run.id);
  }

  protected onHistoryClick(): void {
    this.completedRunsRequested.emit();
  }

  // Manual collapse overrides — `undefined` means use the status-based default
  // (done phases collapsed, everything else expanded). Once the user toggles a
  // lane its preference sticks for the session.
  private readonly userCollapseOverrides = signal<Record<string, boolean>>({});

  protected isLaneCollapsed(lane: MissionGraphLane): boolean {
    const override = this.userCollapseOverrides()[lane.id];
    if (override !== undefined) return override;
    return lane.status === 'done';
  }

  protected toggleLane(lane: MissionGraphLane, event: Event): void {
    event.preventDefault();
    const currentlyCollapsed = this.isLaneCollapsed(lane);
    this.userCollapseOverrides.update((overrides) => ({
      ...overrides,
      [lane.id]: !currentlyCollapsed,
    }));
  }
}
