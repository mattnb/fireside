// client/app/evidence-view/evidence-view.ts
// Renders the unified evidence timeline. Owns the filter pill state. The
// upstream merge (mission receipts + collaboration + artifacts + runs) lives
// in App; this component takes the merged event list as an input.

import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FiresideApi } from '../api.service';
import { formatDateTime, formatShortTime } from '../formatters';
import type {
  EvidenceEvent,
  EvidenceFilter,
} from '../evidence-timeline';
import type { Artifact } from '../api.types';

@Component({
  selector: 'fs-evidence-view',
  standalone: true,
  templateUrl: './evidence-view.html',
  styleUrl: './evidence-view.css',
})
export class EvidenceView {
  private readonly api = inject(FiresideApi);

  readonly events = input<EvidenceEvent[]>([]);
  readonly roomId = input<string | null>(null);

  readonly openRunRequested = output<string>();

  readonly filter = signal<EvidenceFilter>('all');

  readonly filteredEvents = computed<EvidenceEvent[]>(() => {
    const filter = this.filter();
    const all = this.events();
    if (filter === 'all') return all;
    return all.filter((event) => event.bucket === filter);
  });

  bucketCount(bucket: EvidenceFilter): number {
    if (bucket === 'all') return this.events().length;
    return this.events().filter((event) => event.bucket === bucket).length;
  }

  setFilter(filter: EvidenceFilter): void {
    this.filter.set(filter);
  }

  eventKindLabel(event: EvidenceEvent): string {
    if (event.kind === 'run-completed') return 'run · completed';
    if (event.kind === 'run-failed') return 'run · failed';
    if (event.kind === 'artifact' && event.artifact) return `artifact · ${event.artifact.kind}`;
    if (event.actor) return `${event.kind} · ${event.actor}`;
    return event.kind;
  }

  formatShortTime(timestamp: number | undefined): string {
    return formatShortTime(timestamp);
  }

  formatDateTime(timestamp: number | undefined | null): string {
    return formatDateTime(timestamp);
  }

  openArtifact(artifact: Artifact): void {
    const roomId = this.roomId();
    if (!roomId) return;
    this.api.artifacts.open(roomId, artifact).subscribe({
      error: (err) => console.warn('Failed to open artifact', err),
    });
  }

  openRun(runId: string): void {
    this.openRunRequested.emit(runId);
  }
}
