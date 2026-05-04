// client/app/briefing.service.ts
// Owns the mission-briefing flow: loading the list (which feeds the
// sidebar count badge), opening a specific briefing for the briefings tab
// to render, and saving a new briefing from mission-toolbar's "save
// briefing" button. The list and currently-open briefing live on
// MissionStore (already shared between components); selection +
// loading/error state live here because they are pure orchestration UI
// state with no readers outside of this service's own consumers.

import { Injectable, inject, signal } from '@angular/core';

import { FiresideApi } from './api.service';
import { MissionStore } from './mission-store';
import type { MissionBriefingSummary } from './api.types';

@Injectable({ providedIn: 'root' })
export class BriefingService {
  private readonly api = inject(FiresideApi);
  private readonly store = inject(MissionStore);

  readonly selectedBriefingId = signal<string | null>(null);
  readonly briefingLoading = signal(false);
  readonly briefingError = signal('');

  constructor() {
    this.loadList();
  }

  loadList(): void {
    this.api.briefings.list().subscribe({
      next: (briefings) => {
        this.store.briefings.set(briefings);
        const selected = this.selectedBriefingId();
        if (selected && briefings.some((briefing) => briefing.id === selected)) return;
        if (briefings[0]) {
          this.openBriefing(briefings[0].id, true);
        } else {
          this.selectedBriefingId.set(null);
          this.store.selectedBriefing.set(null);
        }
      },
      error: (err: unknown) => {
        this.briefingError.set(
          err instanceof Error ? err.message : 'failed to load briefings',
        );
      },
    });
  }

  openBriefing(briefingId: string, keepExisting = false): void {
    this.selectedBriefingId.set(briefingId);
    this.briefingError.set('');
    this.briefingLoading.set(true);
    if (!keepExisting) this.store.selectedBriefing.set(null);
    this.api.briefings.detail(briefingId).subscribe({
      next: (briefing) => {
        if (this.selectedBriefingId() !== briefingId) return;
        this.store.selectedBriefing.set(briefing);
        this.briefingLoading.set(false);
      },
      error: (err: unknown) => {
        if (this.selectedBriefingId() !== briefingId) return;
        this.briefingError.set(
          err instanceof Error ? err.message : 'failed to load briefing',
        );
        this.briefingLoading.set(false);
      },
    });
  }

  createBriefing(input: { roomId: string; taskId: string | null; authorName: string }): void {
    this.briefingLoading.set(true);
    this.briefingError.set('');
    this.api.briefings
      .create(input.roomId, {
        taskId: input.taskId ?? null,
        createdBy: input.authorName,
      })
      .subscribe({
        next: (briefing) => {
          const summary: MissionBriefingSummary = {
            id: briefing.id,
            roomId: briefing.roomId,
            taskId: briefing.taskId,
            title: briefing.title,
            summary: briefing.summary,
            createdBy: briefing.createdBy,
            createdAt: briefing.createdAt,
            messageCount: briefing.messageCount,
            runCount: briefing.runCount,
          };
          this.store.briefings.update((briefings) => upsertBriefing(briefings, summary));
          this.selectedBriefingId.set(briefing.id);
          this.store.selectedBriefing.set(briefing);
          this.briefingLoading.set(false);
        },
        error: (err: unknown) => {
          this.briefingError.set(
            err instanceof Error ? err.message : 'failed to save briefing',
          );
          this.briefingLoading.set(false);
        },
      });
  }
}

function upsertBriefing(
  briefings: MissionBriefingSummary[],
  summary: MissionBriefingSummary,
): MissionBriefingSummary[] {
  return [summary, ...briefings.filter((existing) => existing.id !== summary.id)];
}
