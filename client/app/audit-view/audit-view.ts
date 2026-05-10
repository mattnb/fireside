import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import { FiresideApi } from '../api.service';
import { formatDateTime, formatRelativeAgo } from '../formatters';
import type { AuditEvent, AuditEventKind } from '../api.types';

interface KindChip {
  id: AuditEventKind | 'all';
  label: string;
}

const KIND_CHIPS: readonly KindChip[] = [
  { id: 'all', label: 'all' },
  { id: 'tool-call', label: 'tools' },
  { id: 'mission-command', label: 'mission' },
  { id: 'run-action', label: 'runs' },
  { id: 'routing-decision', label: 'routing' },
  { id: 'permission-request', label: 'permissions' },
  { id: 'turn-outcome', label: 'turns' },
];

const KIND_LABEL: Record<AuditEventKind, string> = {
  'run-action': 'run',
  'mission-command': 'mission',
  'routing-decision': 'routing',
  'tool-call': 'tool',
  'permission-request': 'permission',
  'turn-outcome': 'turn',
};

@Component({
  selector: 'fs-audit-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './audit-view.html',
  styleUrl: './audit-view.css',
})
export class AuditView {
  private readonly api = inject(FiresideApi);
  private inflightId = 0;

  readonly roomId = input<string | null>(null);
  readonly roomAgents = input<string[]>([]);

  protected readonly kindChips = KIND_CHIPS;
  protected readonly kindLabel = KIND_LABEL;

  readonly activeKind = signal<AuditEventKind | 'all'>('all');
  readonly activeAgent = signal<string>('all');
  readonly events = signal<AuditEvent[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly visibleEvents = computed(() => {
    const kind = this.activeKind();
    const agent = this.activeAgent();
    return this.events().filter((event) => {
      if (kind !== 'all' && event.kind !== kind) return false;
      if (agent !== 'all' && event.agentId !== agent) return false;
      return true;
    });
  });

  readonly empty = computed(() => !this.loading() && this.visibleEvents().length === 0);

  constructor() {
    effect(() => {
      const id = this.roomId();
      if (!id) {
        this.events.set([]);
        return;
      }
      this.refresh();
    });
  }

  refresh(): void {
    const id = this.roomId();
    if (!id) return;
    this.loading.set(true);
    this.error.set(null);
    const requestId = ++this.inflightId;
    this.api.audit.stream(id, { limit: 200 }).subscribe({
      next: (response) => {
        if (requestId !== this.inflightId) return;
        this.events.set(response.events ?? []);
        this.loading.set(false);
      },
      error: (err) => {
        if (requestId !== this.inflightId) return;
        this.events.set([]);
        this.error.set(err?.message ?? 'audit stream load failed');
        this.loading.set(false);
      },
    });
  }

  setKind(kind: AuditEventKind | 'all'): void {
    this.activeKind.set(kind);
  }

  setAgent(agent: string): void {
    this.activeAgent.set(agent);
  }

  formatRelative(timestamp: number): string {
    return formatRelativeAgo(timestamp, Date.now());
  }

  formatAbsolute(timestamp: number): string {
    return formatDateTime(timestamp);
  }
}
