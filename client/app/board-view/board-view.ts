// client/app/board-view/board-view.ts
// Mission kanban board with swimlanes per phase. Owns its own UI selection
// state: which phases are collapsed, the auto-collapse-on-first-sight effect
// for done phases, and the parallelism-details disclosure. Receives mission
// graph data as inputs (the parent has the resolvers handy); emits item /
// run / batch actions for the parent to handle against App-level state.

import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { pad2 } from '../formatters';
import type {
  MissionBoardSwimlane,
  MissionGraphCard,
  MissionGraphLane,
  MissionGraphSummary,
} from '../mission-graph';
import type {
  TaskChecklistItem,
  TaskControl,
  TaskParallelismSummary,
} from '../api.types';

export interface MissionBoardColumnInfo {
  id: 'ready' | 'active' | 'blocked' | 'review' | 'done';
  label: string;
  summary: string;
}

@Component({
  selector: 'fs-board-view',
  standalone: true,
  templateUrl: './board-view.html',
  styleUrl: './board-view.css',
})
export class BoardView {
  protected readonly display = inject(AgentDisplayService);

  readonly taskControl = input<TaskControl | null>(null);
  readonly swimlanes = input<MissionBoardSwimlane[]>([]);
  readonly graphLanes = input<MissionGraphLane[]>([]);
  readonly summary = input<MissionGraphSummary | null>(null);
  readonly columns = input<MissionBoardColumnInfo[]>([]);
  readonly selectedItemId = input<string>('');

  readonly runLabel = input<(card: MissionGraphCard) => string>(() => '');
  readonly notePreview = input<(card: MissionGraphCard) => string>(() => '');

  readonly itemFocused = output<TaskChecklistItem>();
  readonly itemSelected = output<string>();
  readonly runOpened = output<{ card: MissionGraphCard; event: Event }>();
  readonly parallelBatchRequested = output<void>();
  readonly idCopied = output<{ id: string; event: Event }>();

  readonly collapsedPhases = signal<Set<string>>(new Set());
  private autoCollapsedPhases = new Set<string>();

  readonly showParallelismDetails = signal(false);

  readonly sortedSwimlanes = computed<MissionBoardSwimlane[]>(() => {
    const lanes = this.swimlanes();
    const graphLanes = this.graphLanes();
    const sortOrderById = new Map<string, number>(
      graphLanes.map((l, i) => [l.id, l.phase?.sortOrder ?? i] as const),
    );
    const groupRank = (status: string): number => {
      if (status === 'active') return 0;
      if (status === 'done') return 2;
      return 1;
    };
    return [...lanes].sort((a, b) => {
      const ra = groupRank(a.status);
      const rb = groupRank(b.status);
      if (ra !== rb) return ra - rb;
      const sa = sortOrderById.get(a.id) ?? 0;
      const sb = sortOrderById.get(b.id) ?? 0;
      return sa - sb;
    });
  });

  readonly parallelism = computed<TaskParallelismSummary | null>(
    () => this.taskControl()?.parallelism ?? null,
  );

  readonly parallelismConflictCells = computed(() =>
    (this.taskControl()?.parallelism.cells ?? [])
      .filter((cell) => cell.status !== 'can-run-together')
      .slice(0, 10),
  );

  readonly parallelismConflictOverflow = computed(() => {
    const total = (this.taskControl()?.parallelism.cells ?? []).filter(
      (cell) => cell.status !== 'can-run-together',
    ).length;
    return Math.max(0, total - this.parallelismConflictCells().length);
  });

  constructor() {
    effect(() => {
      const lanes = this.swimlanes();
      untracked(() => {
        const seen = this.autoCollapsedPhases;
        const newlyCollapse: string[] = [];
        for (const lane of lanes) {
          if (lane.status === 'done' && !seen.has(lane.id)) {
            seen.add(lane.id);
            newlyCollapse.push(lane.id);
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

  toggleCollapsed(phaseId: string): void {
    const set = new Set(this.collapsedPhases());
    if (set.has(phaseId)) set.delete(phaseId);
    else set.add(phaseId);
    this.collapsedPhases.set(set);
  }

  isCollapsed(phaseId: string): boolean {
    return this.collapsedPhases().has(phaseId);
  }

  phaseGroup(lane: MissionBoardSwimlane): 'active' | 'queued' | 'done' {
    if (lane.status === 'active') return 'active';
    if (lane.status === 'done') return 'done';
    return 'queued';
  }

  laneSortOrder(lane: MissionBoardSwimlane): number {
    const graphLane = this.graphLanes().find((l) => l.id === lane.id);
    return graphLane?.phase?.sortOrder ?? 0;
  }

  laneCounts(lane: MissionBoardSwimlane): {
    ready: number;
    active: number;
    blocked: number;
    review: number;
    done: number;
    total: number;
  } {
    const r = lane.cardsByColumn.ready.length;
    const a = lane.cardsByColumn.active.length;
    const b = lane.cardsByColumn.blocked.length;
    const v = lane.cardsByColumn.review.length;
    const d = lane.cardsByColumn.done.length;
    return { ready: r, active: a, blocked: b, review: v, done: d, total: r + a + b + v + d };
  }

  cardClass(card: MissionGraphCard): string {
    return `is-${card.tone}`;
  }

  parallelismItemTitle(itemId: string): string {
    const item = this.taskControl()?.checklistItems.find((candidate) => candidate.id === itemId);
    return item?.title ?? this.shortTaskId(itemId);
  }

  parallelismStatusLabel(status: string): string {
    if (status === 'blocked-by-dependency') return 'dependency';
    if (status === 'same-conflict-group') return 'conflict group';
    if (status === 'expected-touch-overlap') return 'file overlap';
    if (status === 'exclusive-lane') return 'exclusive lane';
    if (status === 'not-ready') return 'not ready';
    return 'compatible';
  }

  shortTaskId(id: string): string {
    return id.length > 10 ? id.slice(0, 10) : id;
  }

  pad2(value: number): string {
    return pad2(value);
  }

  toggleDetails(): void {
    this.showParallelismDetails.update((v) => !v);
  }

  focusItem(item: TaskChecklistItem): void {
    this.itemFocused.emit(item);
  }

  selectItem(itemId: string): void {
    this.itemSelected.emit(itemId);
  }

  openRun(card: MissionGraphCard, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (!card.activeRun && !card.latestRun) return;
    this.runOpened.emit({ card, event });
  }

  dispatchBatch(): void {
    this.parallelBatchRequested.emit();
  }

  copyId(id: string, event: Event): void {
    this.idCopied.emit({ id, event });
  }
}
