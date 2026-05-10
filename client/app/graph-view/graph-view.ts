import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { computeDagLayout, type DagInputNode } from '../dag-layout';
import type { MissionGraphCard, MissionGraphLane } from '../mission-graph';
import type { TaskChecklistItem } from '../api.types';

interface FilterChip {
  id: 'all' | 'active' | 'ready' | 'blocked' | 'cycles' | 'done';
  label: string;
}

const FILTERS: readonly FilterChip[] = [
  { id: 'all', label: 'all' },
  { id: 'active', label: 'active' },
  { id: 'ready', label: 'ready' },
  { id: 'blocked', label: 'blocked' },
  { id: 'cycles', label: 'cycles' },
  { id: 'done', label: 'done' },
];

@Component({
  selector: 'fs-graph-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './graph-view.html',
  styleUrl: './graph-view.css',
})
export class GraphView {
  protected readonly display = inject(AgentDisplayService);

  readonly lanes = input<MissionGraphLane[]>([]);
  readonly selectedItemId = input<string>('');

  readonly itemFocused = output<TaskChecklistItem>();

  readonly activeFilter = signal<FilterChip['id']>('all');
  protected readonly filters = FILTERS;

  /** Flattened cards across every phase lane, with phase id stamped on each
   *  for context labels. We layout the entire mission as one DAG instead of
   *  per-lane because dependency_refs naturally cross phase boundaries. */
  readonly allCards = computed<MissionGraphCard[]>(() =>
    this.lanes().flatMap((lane) => lane.cards),
  );

  readonly inputNodes = computed<DagInputNode[]>(() => {
    const lanes = this.lanes();
    const phaseTitleById = new Map<string, string>();
    for (const lane of lanes) {
      if (lane.phase) phaseTitleById.set(lane.phase.id, lane.phase.title);
    }
    return this.allCards().map((card) => {
      const ownerLabel = card.activeRun
        ? `${this.display.name(card.activeRun.agentId)} · running`
        : card.item.ownerAgentId
          ? this.display.name(card.item.ownerAgentId)
          : 'unassigned';
      const phaseTitle = card.item.phaseId ? phaseTitleById.get(card.item.phaseId) ?? '' : '';
      const context = [phaseTitle, ownerLabel].filter(Boolean).join(' · ');
      return {
        id: card.item.id,
        title: card.item.title,
        status: card.item.status,
        tone: card.tone,
        sortOrder: card.item.sortOrder,
        dependencyIds: card.item.dependencyIds ?? [],
        active: card.activeRun !== null,
        context,
      };
    });
  });

  readonly layout = computed(() => computeDagLayout(this.inputNodes()));

  readonly visibleNodeIds = computed<ReadonlySet<string>>(() => {
    const filter = this.activeFilter();
    const layout = this.layout();
    const cards = this.allCards();
    const cardsById = new Map(cards.map((card) => [card.item.id, card]));
    if (filter === 'all') return new Set(layout.nodes.map((n) => n.id));
    const ids = new Set<string>();
    for (const node of layout.nodes) {
      const card = cardsById.get(node.id);
      if (!card) continue;
      switch (filter) {
        case 'active':
          if (card.activeRun) ids.add(node.id);
          break;
        case 'ready':
          if (card.ready) ids.add(node.id);
          break;
        case 'blocked':
          if (card.item.status === 'blocked' || card.waiting) ids.add(node.id);
          break;
        case 'done':
          if (card.item.status === 'done' || card.item.status === 'skipped') ids.add(node.id);
          break;
        case 'cycles':
          if (node.inCycle) ids.add(node.id);
          break;
      }
    }
    return ids;
  });

  readonly hasCycles = computed(() => this.layout().cycleNodeIds.size > 0);

  readonly cycleSummary = computed(() => {
    const ids = this.layout().cycleNodeIds;
    const cards = this.allCards();
    const titles = cards
      .filter((card) => ids.has(card.item.id))
      .map((card) => card.item.title);
    return { count: ids.size, titles };
  });

  readonly summary = computed(() => {
    const cards = this.allCards();
    return {
      total: cards.length,
      active: cards.filter((card) => card.activeRun).length,
      ready: cards.filter((card) => card.ready).length,
      blocked: cards.filter((card) => card.item.status === 'blocked' || card.waiting).length,
      done: cards.filter((card) => card.item.status === 'done' || card.item.status === 'skipped').length,
    };
  });

  setFilter(filter: FilterChip['id']): void {
    this.activeFilter.set(filter);
  }

  isVisible(id: string): boolean {
    return this.visibleNodeIds().has(id);
  }

  isFaded(id: string): boolean {
    if (this.activeFilter() === 'all') return false;
    return !this.visibleNodeIds().has(id);
  }

  isSelected(id: string): boolean {
    return this.selectedItemId() === id;
  }

  /** SVG path between two nodes — left edge of source's right side to right
   *  edge of target's left side, with a smooth horizontal cubic bezier. */
  edgePath(source: { x: number; y: number; width: number; height: number }, target: { x: number; y: number; width: number; height: number }): string {
    const x1 = source.x + source.width;
    const y1 = source.y + source.height / 2;
    const x2 = target.x;
    const y2 = target.y + target.height / 2;
    const dx = Math.max(40, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  nodeById(id: string) {
    return this.layout().nodes.find((node) => node.id === id) ?? null;
  }

  focus(id: string): void {
    const card = this.allCards().find((c) => c.item.id === id);
    if (card) this.itemFocused.emit(card.item);
  }
}
