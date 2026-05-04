import type { AgentContextUsage, AgentQuotaWindowUsage } from './context-usage.js';

export interface ProviderCapacityBlock {
  providerId: string;
  status: string;
  resetsAt: number;
  source: string;
  createdAt: number;
  actionId?: string;
}

export interface ProviderCapacityAction {
  id: string;
  contextUsage?: AgentContextUsage | null;
  createdAt: number;
}

export const DEFAULT_PROVIDER_CAPACITY_RECHECK_MS = 30 * 60 * 1000;

function quotaResetMillis(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 10_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
}

function quotaStatus(usage: AgentContextUsage): string {
  const quota = usage.quota;
  if (!quota) return '';
  return (
    quota.rateLimitReachedType ||
    quota.overageStatus ||
    quota.fiveHour?.status ||
    quota.sevenDay?.status ||
    quota.daily?.status ||
    ''
  ).trim();
}

function isAllowedQuotaStatus(status: string): boolean {
  return /^(allowed|ok|available)$/i.test(status.trim());
}

function isBlockedQuotaStatus(status: string): boolean {
  return /(limited|exhausted|over.?quota|quota|capacity|blocked|denied|rejected|unavailable)/i.test(
    status,
  );
}

function futureResetsAt(
  windows: Array<AgentQuotaWindowUsage | undefined>,
  now: number,
): number | undefined {
  const resets = windows
    .map((window) => quotaResetMillis(window?.resetsAt))
    .filter((reset): reset is number => reset !== undefined && reset > now)
    .sort((a, b) => a - b);
  return resets[0];
}

export function capacityBlockFromContextUsage(
  usage: AgentContextUsage,
  now = Date.now(),
  createdAt = now,
): ProviderCapacityBlock | null {
  if (!usage.quota) return null;
  const status = quotaStatus(usage);
  if (!status || isAllowedQuotaStatus(status) || !isBlockedQuotaStatus(status)) return null;
  const resetsAt =
    futureResetsAt([usage.quota.fiveHour, usage.quota.sevenDay, usage.quota.daily], now) ??
    Math.max(now, createdAt) + DEFAULT_PROVIDER_CAPACITY_RECHECK_MS;
  if (resetsAt <= now) return null;
  return {
    providerId: usage.provider,
    status,
    resetsAt,
    source: usage.source,
    createdAt,
  };
}

export function latestProviderCapacityBlock(
  actions: ProviderCapacityAction[],
  providerId: string,
  now = Date.now(),
): ProviderCapacityBlock | null {
  for (const action of actions) {
    const usage = action.contextUsage;
    if (!usage || usage.provider !== providerId) continue;

    const block = capacityBlockFromContextUsage(usage, now, action.createdAt);
    if (block) {
      return { ...block, actionId: action.id };
    }

    if (!usage.quota || isAllowedQuotaStatus(quotaStatus(usage))) {
      return null;
    }
  }
  return null;
}

export function formatProviderCapacityBlock(block: ProviderCapacityBlock, now = Date.now()): string {
  const remainingMs = Math.max(0, block.resetsAt - now);
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const reset =
    hours > 0 ? `${hours}h${minutes ? ` ${minutes}m` : ''}` : `${Math.max(1, minutes)}m`;
  return `provider ${block.providerId} quota is ${block.status}; recheck after ${reset}`;
}
