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
import { ringFillDash, ringTrackDash, quotaTone as ringQuotaTone } from './quota-ring';
import type {
  AgentContextUsage,
  AgentId,
  AgentQuotaUsage,
  AgentQuotaWindowUsage,
} from './api.types';

export type RingTone = 'green' | 'yellow' | 'red' | 'idle';

const QUOTA_PERCENT_ONLY_TTL_MS = 30 * 60 * 1000;

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
      const isExpired = (window: AgentQuotaWindowUsage | undefined): boolean =>
        window?.resetsAt !== undefined && window.resetsAt <= Date.now();
      const mergeWindow = (
        current: AgentQuotaWindowUsage | undefined,
        incoming: AgentQuotaWindowUsage | undefined,
        allowPartialFragmentMerge: boolean,
      ): AgentQuotaWindowUsage | undefined => {
        if (incoming && isExpired(incoming)) return undefined;
        if (current && isExpired(current)) return undefined;
        if (!incoming) return current;
        if (!current) return incoming;
        if (
          incoming.resetsAt !== undefined &&
          incoming.percent === undefined &&
          current.percent !== undefined &&
          current.resetsAt !== incoming.resetsAt &&
          !allowPartialFragmentMerge
        ) {
          return incoming;
        }
        if (
          current.resetsAt !== undefined &&
          current.percent === undefined &&
          incoming.percent !== undefined &&
          incoming.resetsAt !== current.resetsAt &&
          !allowPartialFragmentMerge
        ) {
          return current;
        }
        return { ...current, ...incoming };
      };
      const merged: AgentQuotaUsage = {
        ...(existing ?? {}),
        ...next,
        source: next.source,
      };
      delete merged.fiveHour;
      delete merged.sevenDay;
      delete merged.daily;
      const allowPartialFragmentMerge = existing?.source === next.source;
      const fiveHour = mergeWindow(existing?.fiveHour, next.fiveHour, allowPartialFragmentMerge);
      const sevenDay = mergeWindow(existing?.sevenDay, next.sevenDay, allowPartialFragmentMerge);
      const daily = mergeWindow(existing?.daily, next.daily, allowPartialFragmentMerge);
      if (fiveHour) merged.fiveHour = fiveHour;
      if (sevenDay) merged.sevenDay = sevenDay;
      if (daily) merged.daily = daily;
      if (!fiveHour && !sevenDay && !daily && !merged.planType && !merged.rateLimitReachedType) {
        return undefined;
      }
      return merged;
    };
    const sanitizeQuota = (
      quota: AgentQuotaUsage | undefined,
      createdAt: number,
    ): AgentQuotaUsage | undefined => {
      if (!quota) return undefined;
      const sanitizeWindow = (
        window: AgentQuotaWindowUsage | undefined,
      ): AgentQuotaWindowUsage | undefined => {
        if (!window) return undefined;
        if (
          window.percent !== undefined &&
          window.resetsAt === undefined &&
          Date.now() - createdAt > QUOTA_PERCENT_ONLY_TTL_MS
        ) {
          return undefined;
        }
        return window;
      };
      const sanitized: AgentQuotaUsage = { ...quota };
      delete sanitized.fiveHour;
      delete sanitized.sevenDay;
      delete sanitized.daily;
      const fiveHour = sanitizeWindow(quota.fiveHour);
      const sevenDay = sanitizeWindow(quota.sevenDay);
      const daily = sanitizeWindow(quota.daily);
      if (fiveHour) sanitized.fiveHour = fiveHour;
      if (sevenDay) sanitized.sevenDay = sevenDay;
      if (daily) sanitized.daily = daily;
      if (
        !fiveHour &&
        !sevenDay &&
        !daily &&
        !sanitized.planType &&
        !sanitized.rateLimitReachedType
      ) {
        return undefined;
      }
      return sanitized;
    };
    const pruneQuotaForDisplay = (quota: AgentQuotaUsage | undefined): AgentQuotaUsage | undefined => {
      if (!quota) return undefined;
      const pruneWindow = (
        window: AgentQuotaWindowUsage | undefined,
      ): AgentQuotaWindowUsage | undefined => {
        if (!window) return undefined;
        if (window.resetsAt !== undefined && window.resetsAt <= Date.now()) return undefined;
        return window;
      };
      const pruned: AgentQuotaUsage = { ...quota };
      delete pruned.fiveHour;
      delete pruned.sevenDay;
      delete pruned.daily;
      const fiveHour = pruneWindow(quota.fiveHour);
      const sevenDay = pruneWindow(quota.sevenDay);
      const daily = pruneWindow(quota.daily);
      if (fiveHour) pruned.fiveHour = fiveHour;
      if (sevenDay) pruned.sevenDay = sevenDay;
      if (daily) pruned.daily = daily;
      if (!fiveHour && !sevenDay && !daily && !pruned.planType && !pruned.rateLimitReachedType) {
        return undefined;
      }
      return pruned;
    };
    const sanitizeUsage = (usage: AgentContextUsage, createdAt: number): AgentContextUsage => {
      const quota = sanitizeQuota(usage.quota, createdAt);
      if (quota) return { ...usage, quota };
      const { quota: _quota, ...rest } = usage;
      return rest;
    };
    const pruneUsageForDisplay = (usage: AgentContextUsage): AgentContextUsage => {
      const quota = pruneQuotaForDisplay(usage.quota);
      if (quota) return { ...usage, quota };
      const { quota: _quota, ...rest } = usage;
      return rest;
    };
    // Mechanical turns are routed to a small bookkeeping model (Haiku by
    // default) regardless of the agent's profile. Their context-usage rows
    // therefore reflect the bookkeeping model's view of the conversation,
    // not the agent's own. We still merge quota fragments from these rows
    // (quota state belongs to the provider, not the model), but we never
    // let them overwrite the agent's primary used/window/model row — that
    // belongs to the most recent NON-mechanical turn.
    const isMechanicalTurn = (usage: AgentContextUsage): boolean =>
      usage.turnKind === 'workflow-repair' || usage.turnKind === 'maintenance-compaction';

    for (const entry of this.store.stateSnapshot()?.contextUsage?.byAgent ?? []) {
      usageByAgent.set(entry.agentId, { ...entry.usage });
    }
    const actions = [...this.store.runActions()].sort((a, b) => a.createdAt - b.createdAt);
    for (const action of actions) {
      if (!action.agentId || !action.contextUsage) continue;
      const actionUsage = sanitizeUsage(action.contextUsage, action.createdAt);
      const existing = usageByAgent.get(action.agentId);
      if (actionUsage.quotaOnly && existing) {
        const merged = { ...existing };
        const quota = mergeQuota(existing.quota, actionUsage.quota);
        if (quota) merged.quota = quota;
        else delete merged.quota;
        usageByAgent.set(action.agentId, merged);
        continue;
      }
      // Mechanical turn rows: merge quota into the existing primary row,
      // but never replace the primary used/window/model. If we don't have
      // a primary yet (cold start), fall through and let it become the
      // primary so the UI has SOMETHING to show; subsequent non-mechanical
      // rows will replace it.
      if (isMechanicalTurn(actionUsage) && existing && !isMechanicalTurn(existing)) {
        const merged = { ...existing };
        const quota = mergeQuota(existing.quota, actionUsage.quota);
        if (quota) merged.quota = quota;
        else delete merged.quota;
        usageByAgent.set(action.agentId, merged);
        continue;
      }
      const merged: AgentContextUsage = { ...actionUsage };
      const quota = mergeQuota(existing?.quota, merged.quota);
      if (quota) merged.quota = quota;
      else delete merged.quota;
      usageByAgent.set(action.agentId, merged);
    }
    for (const [agentId, usage] of usageByAgent) {
      usageByAgent.set(agentId, pruneUsageForDisplay(usage));
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
      usage.outputTokens !== undefined ? `output: ${this.formatTokens(usage.outputTokens)}` : '',
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
        return this.fallbackQuotaForDisplay(action.contextUsage.quota, action.createdAt);
      }
    }
    return null;
  }

  private fallbackQuotaForDisplay(
    quota: AgentQuotaUsage | undefined,
    createdAt: number,
  ): AgentQuotaUsage | null {
    if (!quota) return null;
    const windowForDisplay = (
      window: AgentQuotaWindowUsage | undefined,
    ): AgentQuotaWindowUsage | undefined => {
      if (!window) return undefined;
      if (window.resetsAt !== undefined && window.resetsAt <= Date.now()) return undefined;
      if (
        window.percent !== undefined &&
        window.resetsAt === undefined &&
        Date.now() - createdAt > QUOTA_PERCENT_ONLY_TTL_MS
      ) {
        return undefined;
      }
      return window;
    };
    const displayQuota: AgentQuotaUsage = { ...quota };
    delete displayQuota.fiveHour;
    delete displayQuota.sevenDay;
    delete displayQuota.daily;
    const fiveHour = windowForDisplay(quota.fiveHour);
    const sevenDay = windowForDisplay(quota.sevenDay);
    const daily = windowForDisplay(quota.daily);
    if (fiveHour) displayQuota.fiveHour = fiveHour;
    if (sevenDay) displayQuota.sevenDay = sevenDay;
    if (daily) displayQuota.daily = daily;
    if (
      !fiveHour &&
      !sevenDay &&
      !daily &&
      !displayQuota.planType &&
      !displayQuota.rateLimitReachedType
    ) {
      return null;
    }
    return displayQuota;
  }

  fiveHourUsage(agentId: AgentId): AgentQuotaWindowUsage | null {
    const quota = this.quotaUsage(agentId);
    if (this.display.agentProviderId(agentId) === 'gemini') {
      return quota?.daily ?? quota?.fiveHour ?? null;
    }
    return quota?.fiveHour ?? null;
  }

  sevenDayUsage(agentId: AgentId): AgentQuotaWindowUsage | null {
    return this.quotaUsage(agentId)?.sevenDay ?? null;
  }

  primaryQuotaLabel(agentId: AgentId): string {
    return this.display.agentProviderId(agentId) === 'gemini' ? '1d' : '5h';
  }

  secondaryQuotaLabel(_agentId: AgentId): string {
    return '7d';
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
    const label = this.primaryQuotaLabel(agentId);
    if (!data) return `${label} quota usage: not yet tracked`;
    const reset = data.resetsAt
      ? ` (resets in ${formatResetWindow(data.resetsAt - Date.now())})`
      : '';
    const status = data.status ? ` / ${data.status}` : '';
    return data.percent === undefined
      ? `${label} quota${reset}: usage percent unavailable${status}`
      : `${label} quota usage${reset}: ${Math.round(data.percent)}%${status}`;
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
    const label = this.secondaryQuotaLabel(agentId);
    if (!data) return `${label} quota usage: not yet tracked`;
    const reset = data.resetsAt
      ? ` (resets in ${formatResetWindow(data.resetsAt - Date.now())})`
      : '';
    const status = data.status ? ` / ${data.status}` : '';
    return data.percent === undefined
      ? `${label} quota${reset}: usage percent unavailable${status}`
      : `${label} quota usage${reset}: ${Math.round(data.percent)}%${status}`;
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
    if (providerId === 'gemini') {
      return 'Manual compaction asks Gemini CLI to compress its stored CLI session context.';
    }
    return 'Manual compaction is not configured for this provider yet.';
  }

  // ---- Token formatter (re-export for templates) -------------------------

  formatTokens(tokens: number | undefined): string {
    return fmtTokenCount(tokens);
  }
}
