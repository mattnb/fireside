// client/app/briefings-tab/briefings-tab.ts
// Mission Briefings tab. Reads briefings list and the loaded briefing
// detail from MissionStore directly. Selection + loading state lives on
// BriefingService, which both this tab and mission-toolbar inject — App
// stays out of the briefing flow entirely.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AgentDisplayService } from '../agent-display.service';
import { BriefingService } from '../briefing.service';
import { MissionStore } from '../mission-store';
import { formatDateTime, formatShortTime, oneLine } from '../formatters';
import { markdownToHtml } from '../markdown';
import type { Message, MissionBriefing } from '../api.types';

@Component({
  selector: 'fs-briefings-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './briefings-tab.html',
  styleUrl: './briefings-tab.css',
})
export class BriefingsTab {
  private readonly store = inject(MissionStore);
  protected readonly display = inject(AgentDisplayService);
  protected readonly briefingService = inject(BriefingService);

  readonly briefings = this.store.briefings;
  readonly selectedBriefing = this.store.selectedBriefing;
  readonly selectedBriefingId = this.briefingService.selectedBriefingId;
  readonly briefingLoading = this.briefingService.briefingLoading;
  readonly briefingError = this.briefingService.briefingError;

  formatShortTime(ts: number | undefined): string {
    return formatShortTime(ts);
  }

  formatDateTime(ts: number | undefined | null): string {
    return formatDateTime(ts);
  }

  oneLine(text: string | undefined | null, maxChars?: number): string {
    return oneLine(text, maxChars);
  }

  briefingStatusCounts(briefing: MissionBriefing): string {
    const items = briefing.payload.checklistItems;
    const done = items.filter((item) => item.status === 'done').length;
    const blocked = items.filter((item) => item.status === 'blocked').length;
    return `${done}/${items.length} done${blocked ? ` / ${blocked} blocked` : ''}`;
  }

  briefingPhaseCounts(briefing: MissionBriefing): string {
    const phases = briefing.payload.phases;
    const done = phases.filter((phase) => phase.status === 'done').length;
    return `${done}/${phases.length} gates complete`;
  }

  briefingMessages(briefing: MissionBriefing): Message[] {
    return briefing.payload.messages.slice(-80);
  }

  briefingPlanHtml(body: string): string {
    return markdownToHtml(body);
  }

  briefingPlanLabel(briefing: MissionBriefing, planId: string | null | undefined): string {
    if (!planId) return '';
    const plan = briefing.payload.plans.find((candidate) => candidate.id === planId);
    return plan?.title ?? planId;
  }

  briefingChecklistNotes(briefing: MissionBriefing, itemId: string) {
    return briefing.payload.checklistNotes.filter((note) => note.itemId === itemId);
  }

  refresh(): void {
    this.briefingService.loadList();
  }

  selectBriefing(id: string): void {
    this.briefingService.openBriefing(id);
  }
}
