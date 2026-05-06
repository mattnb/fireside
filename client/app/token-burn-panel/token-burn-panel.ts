// client/app/token-burn-panel/token-burn-panel.ts
// Chat-side room/mission token accounting. Uses durable provider usage events
// from the status snapshot; prompt estimates are displayed only as fallback
// context because they are not actual provider burn.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import {
  formatDateTime as fmtDateTime,
  formatTokenCount as fmtTokenCount,
} from '../formatters';
import { MissionStore } from '../mission-store';
import type {
  StatusSnapshotTokenUsage,
  StatusSnapshotTokenUsageBucket,
  StatusSnapshotTokenUsageEvent,
} from '../api.types';

interface TokenBurnBar {
  id: string;
  height: number;
  label: string;
  title: string;
  provider: string;
}

@Component({
  selector: 'fs-token-burn-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './token-burn-panel.html',
  styleUrl: './token-burn-panel.css',
})
export class TokenBurnPanel {
  protected readonly display = inject(AgentDisplayService);
  private readonly store = inject(MissionStore);

  protected readonly roomUsage = computed(
    () => this.store.selectedRoomSnapshot()?.tokenUsage ?? null,
  );
  protected readonly activeMissionUsage = computed(
    () => this.store.selectedRoomSnapshot()?.activeMissionTokenUsage ?? null,
  );
  protected readonly totalLabel = computed(() => {
    const usage = this.roomUsage();
    if (!usage) return '0';
    if (usage.totalTokens > 0) return fmtTokenCount(usage.totalTokens);
    return usage.promptEstimateTokens > 0 ? `~${fmtTokenCount(usage.promptEstimateTokens)}` : '0';
  });
  protected readonly totalSubLabel = computed(() => {
    const usage = this.roomUsage();
    if (!usage) return 'room lifetime';
    return usage.totalTokens > 0 ? 'room lifetime observed' : 'room lifetime estimate';
  });
  protected readonly missionLabel = computed(() => this.usageLabel(this.activeMissionUsage()));
  protected readonly recentBurnLabel = computed(() => {
    const usage = this.roomUsage();
    if (!usage) return '0';
    const snapshotAt = this.store.stateSnapshot()?.generatedAt ?? Date.now();
    return fmtTokenCount(this.sumRecentEvents(usage, 15 * 60_000, snapshotAt));
  });
  protected readonly lastSnapshotLabel = computed(() => {
    const events = this.roomUsage()?.recentEvents ?? [];
    if (events.length === 0) return 'none';
    return fmtDateTime(Math.max(...events.map((event) => event.createdAt)));
  });
  protected readonly splitLabel = computed(() => {
    const usage = this.roomUsage();
    if (!usage) return 'input 0 / output 0';
    return `input ${fmtTokenCount(usage.inputTokens)} / output ${fmtTokenCount(usage.outputTokens)}`;
  });
  protected readonly cacheLabel = computed(() => {
    const usage = this.roomUsage();
    if (!usage || (!usage.cacheCreationInputTokens && !usage.cacheReadInputTokens)) return null;
    return `cache ${fmtTokenCount(usage.cacheCreationInputTokens)} write / ${fmtTokenCount(usage.cacheReadInputTokens)} read`;
  });
  protected readonly providerRows = computed(() => this.sortedTopBuckets(this.roomUsage()?.byProvider ?? []));
  protected readonly agentRows = computed(() => this.sortedTopBuckets(this.roomUsage()?.byAgent ?? []));
  protected readonly burnBars = computed<TokenBurnBar[]>(() => {
    const events = this.roomUsage()?.recentEvents ?? [];
    const max = Math.max(1, ...events.map((event) => event.totalTokens));
    return events.map((event) => ({
      id: event.id,
      height: Math.max(8, Math.round((event.totalTokens / max) * 100)),
      label: fmtTokenCount(event.totalTokens),
      title: this.eventTitle(event),
      provider: event.provider,
    }));
  });
  protected readonly graphEmpty = computed(() => this.burnBars().length === 0);

  protected formatBucketTokens(bucket: StatusSnapshotTokenUsageBucket): string {
    return fmtTokenCount(bucket.totalTokens || bucket.promptEstimateTokens);
  }

  protected bucketPercent(bucket: StatusSnapshotTokenUsageBucket): number {
    const total = this.roomUsage()?.totalTokens || this.roomUsage()?.promptEstimateTokens || 1;
    const value = bucket.totalTokens || bucket.promptEstimateTokens;
    return Math.max(4, Math.min(100, Math.round((value / total) * 100)));
  }

  protected providerClass(provider: string): string {
    return `token-burn__bar is-${provider || 'unknown'}`;
  }

  private usageLabel(usage: StatusSnapshotTokenUsage | null): string {
    if (!usage) return '0';
    if (usage.totalTokens > 0) return fmtTokenCount(usage.totalTokens);
    return usage.promptEstimateTokens > 0 ? `~${fmtTokenCount(usage.promptEstimateTokens)}` : '0';
  }

  private sortedTopBuckets(
    buckets: StatusSnapshotTokenUsageBucket[],
  ): StatusSnapshotTokenUsageBucket[] {
    return [...buckets]
      .filter((bucket) => bucket.totalTokens > 0 || bucket.promptEstimateTokens > 0)
      .sort(
        (a, b) =>
          b.totalTokens - a.totalTokens ||
          b.promptEstimateTokens - a.promptEstimateTokens ||
          a.label.localeCompare(b.label),
      )
      .slice(0, 4);
  }

  private sumRecentEvents(
    usage: StatusSnapshotTokenUsage,
    windowMs: number,
    snapshotAt: number,
  ): number {
    const events = usage.recentEvents ?? [];
    if (events.length === 0) return 0;
    return events
      .filter((event) => snapshotAt - event.createdAt >= 0 && snapshotAt - event.createdAt <= windowMs)
      .reduce((sum, event) => sum + event.totalTokens, 0);
  }

  private eventTitle(event: StatusSnapshotTokenUsageEvent): string {
    const agent = this.display.name(event.agentId);
    const parts = [
      `${agent} / ${event.provider}`,
      `${fmtTokenCount(event.totalTokens)} tokens`,
      event.model,
    ].filter(Boolean);
    return parts.join('\n');
  }
}
