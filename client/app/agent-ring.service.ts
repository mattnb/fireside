// client/app/agent-ring.service.ts
// All ring + context-usage math for the agents-panel SVG rings and the
// compact-agent modal: per-agent context usage resolution, percent / used /
// estimated calculations, tone classes, ring track + fill stroke-dasharray
// strings, ctx/5h/7d tooltips, and the model label / compact-now click
// guard. Pure functions of MissionStore + AgentDisplayService state.

import { Injectable, computed, inject } from '@angular/core';

import { AgentDisplayService } from './agent-display.service';
import { formatResetWindow, formatTokenCount as fmtTokenCount } from './formatters';
import { MissionStore } from './mission-store';
import {
  ringFillDash,
  ringTrackDash,
  quotaTone as ringQuotaTone,
} from './quota-ring';
import type {
  AgentContextUsage,
  AgentId,
  AgentQuotaUsage,
  AgentQuotaWindowUsage,
} from './api.types';

export type RingTone = 'green' | 'yellow' | 'red' | 'idle';

@Injectable({ providedIn: 'root' })
export class AgentRingService {
  private readonly store = inject(MissionStore);
  private readonly display = inject(AgentDisplayService);

  /**
   * Latest context-usage snapshot per agent, derived from the state
   * snapshot's per-agent context-usage table plus any quota updates
   * recorded in the runActions log. Quota-only entries merge into the
   * existing record rather than replacing it.
   */
  readonly latestContextUsageByAgent = computed(() => {
    const usageByAgent = new Map<AgentId, AgentContextUsage>();
    const mergeQuota = (
      existing: AgentQuotaUsage | undefined,
      next: AgentQuotaUsage | undefined,
    ): AgentQuotaUsage | undefined => {
      if (!next) return existing;
      const mergeWindow = (
        current: AgentQuotaWindowUsage | undefined,
        incoming: AgentQuotaWindowUsage | undefined,
      ): AgentQuotaWindowUsage | undefined =>
        incoming ? { ...(current ?? {}), ...incoming } : current;
      const merged: AgentQuotaUsage = {
        ...(existing ?? {}),
        ...next,
        source: next.source,
      };
      const fiveHour = mergeWindow(existing?.fiveHour, next.fiveHour);
      const sevenDay = mergeWindow(existing?.sevenDay, next.sevenDay);
      if (fiveHour) merged.fiveHour = fiveHour;
      if (sevenDay) merged.sevenDay = sevenDay;
      return merged;
    };
    for (const entry of this.store.stateSnapshot()?.contextUsage?.byAgent ?? []) {
      usageByAgent.set(entry.agentId, { ...entry.usage });
    }
    const actions = [...this.store.runActions()].sort((a, b) => a.createdAt - b.createdAt);
    for (const action of actions) {
      if (!action.agentId || !action.contextUsage) continue;
      const existing = usageByAgent.get(action.agentId);
      if (action.contextUsage.quotaOnly && existing) {
        const merged = { ...existing };
        const quota = mergeQuota(existing.quota, action.contextUsage.quota);
        if (quota) merged.quota = quota;
        usageByAgent.set(action.agentId, merged);
        continue;
      }
      const merged: AgentContextUsage = { ...action.contextUsage };
      const quota = mergeQuota(existing?.quota, merged.quota);
      if (quota) merged.quota = quota;
      usageByAgent.set(action.agentId, merged);
    }
    return usageByAgent;
  });

  // ---- Per-agent context resolution ---------------------------------------

  contextUsage(agentId: AgentId): AgentContextUsage | null {
    const usage = this.latestContextUsageByAgent().get(agentId) ?? null;
    return usage?.quotaOnly ? null : usage;
  }

  contextUsedTokens(usage: AgentContextUsage): number {
    if (
      usage.provider === 'codex' &&
      usage.contextWindow &&
      usage.inputTokens !== undefined &&
      usage.inputTokens > usage.contextWindow &&
      usage.cachedInputTokens !== undefined
    ) {
      return Math.max(0, usage.inputTokens - usage.cachedInputTokens + (usage.outputTokens ?? 0));
    }
    if (
      usage.provider === 'claude' &&
      usage.contextWindow &&
      usage.usedTokens > usage.contextWindow &&
      usage.cacheReadInputTokens !== undefined
    ) {
      return Math.max(0, usage.usedTokens - usage.cacheReadInputTokens);
    }
    return usage.usedTokens;
  }

  contextIsEstimated(usage: AgentContextUsage): boolean {
    return usage.estimated === true || this.contextUsedTokens(usage) !== usage.usedTokens;
  }

  contextPercent(usage: AgentContextUsage): number {
    const usedTokens = this.contextUsedTokens(usage);
    if (usage.usedTokens === usedTokens && Number.isFinite(usage.percentUsed)) {
      return Math.max(0, Math.min(100, usage.percentUsed ?? 0));
    }
    if (!usage.contextWindow) return 0;
    return Math.max(0, Math.min(100, (usedTokens / usage.contextWindow) * 100));
  }

  contextPercentRounded(usage: AgentContextUsage): number {
    return Math.round(this.contextPercent(usage));
  }

  contextTone(usage: AgentContextUsage): string {
    const percent = this.contextPercent(usage);
    if (!usage.contextWindow) return 'agent-context--unknown';
    if (percent >= 88) return 'agent-context--red';
    if (percent >= 72) return 'agent-context--yellow';
    return 'agent-context--green';
  }

  contextLabel(usage: AgentContextUsage): string {
    const model = usage.reasoningEffort ? `${usage.model}/${usage.reasoningEffort}` : usage.model;
    const window = usage.contextWindow ? this.formatTokens(usage.contextWindow) : 'unknown';
    const prefix = this.contextIsEstimated(usage) ? '~' : '';
    return `${model} · ${prefix}${this.formatTokens(this.contextUsedTokens(usage))}/${window}`;
  }

  contextModelLabel(usage: AgentContextUsage): string {
    if (!usage.model) return '';
    return usage.reasoningEffort ? `${usage.model}/${usage.reasoningEffort}` : usage.model;
  }

  contextTitle(usage: AgentContextUsage): string {
    const usedTokens = this.contextUsedTokens(usage);
    const parts = [
      `model: ${usage.reasoningEffort ? `${usage.model}/${usage.reasoningEffort}` : usage.model}`,
      `used: ${this.formatTokens(usedTokens)} tokens${this.contextIsEstimated(usage) ? ' estimated' : ''}`,
      usage.contextWindow
        ? `window: ${this.formatTokens(usage.contextWindow)} tokens`
        : 'window unknown',
      usage.contextWindow
        ? `remaining: ${this.formatTokens(Math.max(0, usage.contextWindow - usedTokens))} tokens`
        : '',
      usage.reportedUsedTokens !== undefined && usage.reportedUsedTokens !== usedTokens
        ? `provider reported: ${this.formatTokens(usage.reportedUsedTokens)} tokens`
        : '',
      usage.inputTokens !== undefined ? `input: ${this.formatTokens(usage.inputTokens)}` : '',
      usage.outputTokens !== undefined
        ? `output: ${this.formatTokens(usage.outputTokens)}`
        : '',
      usage.reasoningOutputTokens !== undefined
        ? `reasoning: ${this.formatTokens(usage.reasoningOutputTokens)}`
        : '',
    ].filter(Boolean);
    return parts.join(' / ');
  }

  modelLabel(agentId: AgentId): string {
    const usage = this.contextUsage(agentId);
    if (!usage?.model) return '';
    return usage.reasoningEffort ? `${usage.model} · ${usage.reasoningEffort}` : usage.model;
  }

  // ---- Quota window resolution -------------------------------------------

  quotaUsage(agentId: AgentId): AgentQuotaUsage | null {
    const direct = this.latestContextUsageByAgent().get(agentId)?.quota;
    if (direct) return direct;
    const providerId = this.display.agentProviderId(agentId);
    const actions = [...this.store.runActions()].sort((a, b) => b.createdAt - a.createdAt);
    for (const action of actions) {
      if (!action.agentId || !action.contextUsage?.quota) continue;
      if (this.display.agentProviderId(action.agentId) === providerId) {
        return action.contextUsage.quota;
      }
    }
    return null;
  }

  fiveHourUsage(agentId: AgentId): AgentQuotaWindowUsage | null {
    return this.quotaUsage(agentId)?.fiveHour ?? null;
  }

  sevenDayUsage(agentId: AgentId): AgentQuotaWindowUsage | null {
    return this.quotaUsage(agentId)?.sevenDay ?? null;
  }

  // ---- Ring geometry (r=26, C=2π·26=163.36; 116° wedge = 52.64 of arc) ----

  trackDash(): string {
    return ringTrackDash();
  }

  fillDash(percent: number | null | undefined): string {
    return ringFillDash(percent);
  }

  ctxPercent(agentId: AgentId): number {
    const usage = this.contextUsage(agentId);
    return usage ? this.contextPercent(usage) : 0;
  }

  ctxPercentRounded(agentId: AgentId): number {
    const usage = this.contextUsage(agentId);
    return usage ? this.contextPercentRounded(usage) : 0;
  }

  ctxDash(agentId: AgentId): string {
    return this.fillDash(this.ctxPercent(agentId));
  }

  ctxTooltip(agentId: AgentId): string {
    const usage = this.contextUsage(agentId);
    if (!usage) return 'Compact context (no usage data yet)';
    const pct = this.contextPercentRounded(usage);
    const used = this.formatTokens(this.contextUsedTokens(usage));
    const window = usage.contextWindow ? this.formatTokens(usage.contextWindow) : '?';
    const action = this.display.canCompactAgent(agentId)
      ? this.display.isAgentRunning(agentId)
        ? ' — compact when this agent is idle'
        : this.store.compactingAgent() === agentId
          ? ' — compacting…'
          : ' — click to compact'
      : '';
    return `Context: ${pct}% used · ${used} / ${window} tokens${action}`;
  }

  fiveHourPercent(agentId: AgentId): number | null {
    return this.fiveHourUsage(agentId)?.percent ?? null;
  }

  fiveHourPercentRounded(agentId: AgentId): string {
    const percent = this.fiveHourPercent(agentId);
    return percent === null ? '—' : `${Math.round(percent)}%`;
  }

  fiveHourDash(agentId: AgentId): string {
    return this.fillDash(this.fiveHourPercent(agentId));
  }

  fiveHourTone(agentId: AgentId): RingTone {
    return ringQuotaTone(this.fiveHourPercent(agentId));
  }

  fiveHourTooltip(agentId: AgentId): string {
    const data = this.fiveHourUsage(agentId);
    if (!data) return '5h quota usage: not yet tracked';
    const reset = data.resetsAt
      ? ` (resets in ${formatResetWindow(data.resetsAt - Date.now())})`
      : '';
    const status = data.status ? ` / ${data.status}` : '';
    return data.percent === undefined
      ? `5h quota${reset}: usage percent unavailable${status}`
      : `5h quota usage${reset}: ${Math.round(data.percent)}%${status}`;
  }

  sevenDayPercent(agentId: AgentId): number | null {
    return this.sevenDayUsage(agentId)?.percent ?? null;
  }

  sevenDayPercentRounded(agentId: AgentId): string {
    const percent = this.sevenDayPercent(agentId);
    return percent === null ? '—' : `${Math.round(percent)}%`;
  }

  sevenDayDash(agentId: AgentId): string {
    return this.fillDash(this.sevenDayPercent(agentId));
  }

  sevenDayTone(agentId: AgentId): RingTone {
    return ringQuotaTone(this.sevenDayPercent(agentId));
  }

  sevenDayTooltip(agentId: AgentId): string {
    const data = this.sevenDayUsage(agentId);
    if (!data) return '7d quota usage: not yet tracked';
    const reset = data.resetsAt
      ? ` (resets in ${formatResetWindow(data.resetsAt - Date.now())})`
      : '';
    const status = data.status ? ` / ${data.status}` : '';
    return data.percent === undefined
      ? `7d quota${reset}: usage percent unavailable${status}`
      : `7d quota usage${reset}: ${Math.round(data.percent)}%${status}`;
  }

  // ---- Compact-agent helpers ---------------------------------------------

  compactDescription(agentId: AgentId): string {
    const providerId = this.display.agentProviderId(agentId);
    if (providerId === 'claude') {
      return 'Manual compaction asks Claude Code to compact its stored CLI session context.';
    }
    if (providerId === 'codex') {
      return 'Manual compaction asks Codex CLI to compact its stored CLI session context.';
    }
    return 'Manual compaction is not configured for this provider yet.';
  }

  // ---- Token formatter (re-export for templates) -------------------------

  formatTokens(tokens: number | undefined): string {
    return fmtTokenCount(tokens);
  }
}
