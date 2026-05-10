import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  effect,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { FiresideApi } from '../api.service';
import type { SearchHit, SearchKind } from '../api.types';

interface ScopeChip {
  id: SearchKind | 'all';
  label: string;
}

const SCOPE_CHIPS: readonly ScopeChip[] = [
  { id: 'all', label: 'all' },
  { id: 'room', label: 'rooms' },
  { id: 'task', label: 'tasks' },
  { id: 'message', label: 'messages' },
  { id: 'checklist', label: 'checklist' },
  { id: 'acceptance', label: 'AC' },
  { id: 'clarifying', label: 'Q&A' },
  { id: 'plan', label: 'plans' },
  { id: 'phase', label: 'phases' },
  { id: 'activity', label: 'activity' },
  { id: 'collab', label: 'notes' },
];

const KIND_GROUPS: ReadonlyArray<{ kinds: ReadonlyArray<SearchKind>; label: string }> = [
  { kinds: ['room', 'project'], label: 'Rooms & projects' },
  { kinds: ['task', 'phase', 'plan'], label: 'Missions' },
  { kinds: ['checklist', 'acceptance', 'clarifying'], label: 'Mission state' },
  { kinds: ['message'], label: 'Messages' },
  { kinds: ['activity', 'collab'], label: 'Activity & notes' },
];

const KIND_LABEL: Record<SearchKind, string> = {
  room: 'room',
  project: 'project',
  task: 'task',
  phase: 'phase',
  plan: 'plan',
  checklist: 'checklist',
  acceptance: 'AC',
  clarifying: 'Q&A',
  message: 'message',
  activity: 'activity',
  collab: 'note',
};

export interface PaletteSelection {
  hit: SearchHit;
}

@Component({
  selector: 'fs-command-palette',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './command-palette.html',
  styleUrl: './command-palette.css',
})
export class CommandPalette {
  private readonly api = inject(FiresideApi);
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inflightId = 0;

  @ViewChild('input', { static: true }) private inputRef?: ElementRef<HTMLInputElement>;

  readonly closed = output<void>();
  readonly selected = output<PaletteSelection>();

  protected readonly scopeChips = SCOPE_CHIPS;
  protected readonly kindLabel = KIND_LABEL;

  readonly query = signal('');
  readonly activeScope = signal<SearchKind | 'all'>('all');
  readonly hits = signal<SearchHit[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly cursor = signal(0);

  readonly groupedHits = computed(() => {
    const all = this.hits();
    if (all.length === 0) return [];
    const byKind = new Map<SearchKind, SearchHit[]>();
    for (const hit of all) {
      const list = byKind.get(hit.kind) ?? [];
      list.push(hit);
      byKind.set(hit.kind, list);
    }
    const result: Array<{ label: string; hits: SearchHit[] }> = [];
    for (const group of KIND_GROUPS) {
      const collected = group.kinds.flatMap((kind) => byKind.get(kind) ?? []);
      if (collected.length === 0) continue;
      result.push({ label: group.label, hits: collected });
    }
    return result;
  });

  readonly flatHits = computed(() => this.groupedHits().flatMap((group) => group.hits));

  readonly empty = computed(() => !this.loading() && this.query().trim().length > 0 && this.flatHits().length === 0);

  constructor() {
    // Run a search whenever the query or scope changes (debounced).
    effect(() => {
      const text = this.query().trim();
      const scope = this.activeScope();
      // Cancel any pending search.
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      if (!text) {
        this.hits.set([]);
        this.error.set(null);
        this.loading.set(false);
        this.cursor.set(0);
        return;
      }
      this.loading.set(true);
      this.debounceTimer = setTimeout(() => {
        const requestId = ++this.inflightId;
        const opts = scope === 'all' ? {} : { scope: [scope] };
        this.api.search.universal(text, opts).subscribe({
          next: (response) => {
            if (requestId !== this.inflightId) return;
            this.hits.set(response.hits);
            this.cursor.set(0);
            this.loading.set(false);
            this.error.set(null);
          },
          error: (err) => {
            if (requestId !== this.inflightId) return;
            this.hits.set([]);
            this.loading.set(false);
            this.error.set(err?.message ?? 'search failed');
          },
        });
      }, 120);
    });
  }

  ngAfterViewInit(): void {
    // Focus the input when the palette mounts.
    queueMicrotask(() => this.inputRef?.nativeElement.focus());
  }

  setScope(scope: SearchKind | 'all'): void {
    this.activeScope.set(scope);
  }

  onQueryInput(value: string): void {
    this.query.set(value);
  }

  @HostListener('keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closed.emit();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const flat = this.flatHits();
      if (flat.length === 0) return;
      this.cursor.update((c) => Math.min(flat.length - 1, c + 1));
      this.scrollSelectedIntoView();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.cursor.update((c) => Math.max(0, c - 1));
      this.scrollSelectedIntoView();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const flat = this.flatHits();
      const hit = flat[this.cursor()];
      if (hit) this.selected.emit({ hit });
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      // Cycle scope chips with Tab.
      const idx = this.scopeChips.findIndex((chip) => chip.id === this.activeScope());
      const next = event.shiftKey
        ? (idx - 1 + this.scopeChips.length) % this.scopeChips.length
        : (idx + 1) % this.scopeChips.length;
      const chip = this.scopeChips[next];
      if (chip) this.setScope(chip.id);
    }
  }

  selectHit(hit: SearchHit): void {
    this.selected.emit({ hit });
  }

  protected isCurrent(hit: SearchHit): boolean {
    return this.flatHits()[this.cursor()] === hit;
  }

  /** Render snippet text with `<mark>` wrappers around match offsets.
   *  Returns a list of text/match segments so the template can avoid using
   *  innerHTML and stay safe against any stray HTML in DB content. */
  protected renderSnippetSegments(hit: SearchHit): Array<{ text: string; mark: boolean }> {
    const segments: Array<{ text: string; mark: boolean }> = [];
    const snippet = hit.snippet ?? '';
    if (!snippet) return segments;
    if (!hit.matches || hit.matches.length === 0) {
      segments.push({ text: snippet, mark: false });
      return segments;
    }
    const sorted = [...hit.matches].sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const m of sorted) {
      const start = Math.max(cursor, Math.min(snippet.length, m.start));
      const end = Math.max(start, Math.min(snippet.length, m.end));
      if (start > cursor) {
        segments.push({ text: snippet.slice(cursor, start), mark: false });
      }
      if (end > start) {
        segments.push({ text: snippet.slice(start, end), mark: true });
      }
      cursor = end;
    }
    if (cursor < snippet.length) {
      segments.push({ text: snippet.slice(cursor), mark: false });
    }
    return segments;
  }

  private scrollSelectedIntoView(): void {
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>('.cmd-palette__hit.is-current');
      el?.scrollIntoView({ block: 'nearest' });
    });
  }
}
