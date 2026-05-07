import type { ProviderId, RoomAgentProfile } from '../agents/types.js';
import type { AgentContextUsage } from '../context-usage.js';
import { codexContextWindowForModel, geminiContextWindowForModel } from '../context-usage.js';

export interface AutoCompactionConfig {
  enabled: boolean;
  percentThreshold: number;
  tokenThreshold: number;
  /** When true, this agent is the room lead. The lead branch lowers the
   *  threshold and switches the action from `compact` to `reset-session`. */
  isLead?: boolean;
  /** Percentage of the standard threshold at which the lead deterministically
   *  resets. Only honored when `isLead === true` and the value is in (0, 100].
   *  Defaults to 60 in production via env override; tests set it explicitly. */
  leadResetPercent?: number;
}

export type AutoContextMaintenanceAction = 'compact' | 'reset-session';

export interface AutoContextMaintenanceDecision {
  action: AutoContextMaintenanceAction;
  providerId: ProviderId;
  model: string;
  usedTokens: number;
  thresholdTokens: number;
  contextWindow?: number;
  reason: string;
}

const CLAUDE_OPUS_CONTEXT_WINDOW = 1_000_000;
const CLAUDE_STANDARD_CONTEXT_WINDOW = 256_000;

function positiveNumber(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function cleanModel(model: string | undefined): string {
  return (model ?? '').trim();
}

export function modelContextWindow(
  providerId: ProviderId,
  model: string | undefined,
): number | undefined {
  const cleaned = cleanModel(model);
  const lower = cleaned.toLowerCase();
  if (providerId === 'claude') {
    if (/\[1m\]/.test(lower) || /claude-opus-4-[67]\b/.test(lower)) {
      return CLAUDE_OPUS_CONTEXT_WINDOW;
    }
    if (/claude-(sonnet|haiku)-4-\d+\b/.test(lower) || /\b(sonnet|haiku)\b/.test(lower)) {
      return CLAUDE_STANDARD_CONTEXT_WINDOW;
    }
    if (/\bopus\b/.test(lower)) return CLAUDE_OPUS_CONTEXT_WINDOW;
    return undefined;
  }
  if (providerId === 'codex') return codexContextWindowForModel(cleaned);
  if (providerId === 'gemini') return geminiContextWindowForModel(cleaned);
  return undefined;
}

function providerMaintenanceAction(providerId: ProviderId): AutoContextMaintenanceAction | null {
  if (providerId === 'claude' || providerId === 'codex' || providerId === 'gemini') {
    return 'compact';
  }
  return null;
}

export function autoContextMaintenanceDecision(
  profile: Pick<RoomAgentProfile, 'providerId' | 'modelId'>,
  usage: AgentContextUsage,
  config: AutoCompactionConfig,
): AutoContextMaintenanceDecision | null {
  if (!config.enabled || usage.quotaOnly) return null;
  if (usage.provider !== profile.providerId) return null;
  const action = providerMaintenanceAction(profile.providerId);
  if (!action) return null;

  const model = cleanModel(profile.modelId) || cleanModel(usage.model) || profile.providerId;
  const contextWindow =
    positiveNumber(usage.contextWindow ?? 0) ?? modelContextWindow(profile.providerId, model);

  const thresholds: number[] = [];
  const absoluteThreshold = positiveNumber(config.tokenThreshold);
  if (absoluteThreshold) thresholds.push(Math.floor(absoluteThreshold));

  const usageCompactThreshold = positiveNumber(usage.autoCompactAtTokens ?? 0);
  if (usageCompactThreshold) thresholds.push(Math.floor(usageCompactThreshold));

  const percentThreshold = positiveNumber(config.percentThreshold);
  if (contextWindow && percentThreshold) {
    thresholds.push(Math.floor(contextWindow * (percentThreshold / 100)));
  }

  const baseThreshold = Math.min(...thresholds.filter((value) => value > 0));
  if (!Number.isFinite(baseThreshold)) return null;

  const leadResetPercent = positiveNumber(config.leadResetPercent ?? 0);
  const useLeadBranch =
    config.isLead === true && leadResetPercent !== null && leadResetPercent <= 100;
  const effectiveAction: AutoContextMaintenanceAction = useLeadBranch ? 'reset-session' : action;
  const thresholdTokens = useLeadBranch
    ? Math.max(1, Math.floor(baseThreshold * (leadResetPercent / 100)))
    : baseThreshold;
  if (usage.usedTokens < thresholdTokens) return null;

  const windowDetail = contextWindow ? ` of ${contextWindow} context window` : '';
  return {
    action: effectiveAction,
    providerId: profile.providerId,
    model,
    usedTokens: usage.usedTokens,
    thresholdTokens,
    ...(contextWindow ? { contextWindow } : {}),
    reason: `${model} context is ${usage.usedTokens}/${thresholdTokens} tokens${windowDetail}; ${effectiveAction === 'compact' ? 'auto-compacting' : 'resetting resumable session'} before the next turn${useLeadBranch ? ' (lead reset)' : ''}`,
  };
}
