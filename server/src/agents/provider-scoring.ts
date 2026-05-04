import type { ProviderId } from './types.js';

export type ProviderCapabilityTag =
  | 'accessibility'
  | 'api-contracts'
  | 'architecture'
  | 'autonomous-tool-loop'
  | 'broad-ideation'
  | 'code'
  | 'code-review'
  | 'concurrency'
  | 'coordination'
  | 'cost-efficiency'
  | 'data-integrity'
  | 'design-language'
  | 'exact-retrieval'
  | 'frontend-design'
  | 'image-understanding'
  | 'implementation'
  | 'information-architecture'
  | 'interaction-design'
  | 'knowledge-work'
  | 'latency'
  | 'legal-finance'
  | 'long-context'
  | 'mcp-tooling'
  | 'mission-receipts'
  | 'multimodal'
  | 'performance'
  | 'planning'
  | 'prompt-security'
  | 'reasoning'
  | 'refactor'
  | 'reliability'
  | 'schema-reliability'
  | 'scientific-research'
  | 'security'
  | 'source-synthesis'
  | 'sql-data'
  | 'testing'
  | 'tone-sensitive'
  | 'ux-research'
  | 'ux-synthesis'
  | 'visual-design'
  | 'web-research'
  | 'writing';

export interface ProviderScoringProvider {
  id: ProviderId;
  displayName?: string;
}

export interface ProviderScoringSlot {
  id?: string;
  label?: string;
  personaId?: string;
  preferredProviders?: ProviderId[];
  fallbackProviders?: ProviderId[];
  avoidProviders?: ProviderId[];
  capabilityTags?: ProviderCapabilityTag[];
}

export interface ProviderHealth {
  available?: boolean;
  authenticated?: boolean;
  quota5hPercent?: number;
  quota5hResetsAt?: number;
  quota5hWindowMinutes?: number;
  quota7dPercent?: number;
  quota7dResetsAt?: number;
  quota7dWindowMinutes?: number;
  quotaDailyPercent?: number;
  quotaDailyResetsAt?: number;
  quotaDailyWindowMinutes?: number;
  quotaStatus?: string;
  contextPercent?: number;
  recentFailureRate?: number;
  recentFailures?: number;
  recentRuns?: number;
}

export interface ProviderScoreCandidate {
  providerId: ProviderId;
  score: number;
  unavailable: boolean;
  selected: boolean;
  reasons: string[];
  warnings: string[];
  capabilityScore: number;
  health: ProviderHealth | null;
}

export interface ProviderScoreResult {
  selectedProviderId: ProviderId | null;
  candidates: ProviderScoreCandidate[];
  capabilityTags: ProviderCapabilityTag[];
}

export type ProviderCapabilityProfile = Partial<Record<ProviderCapabilityTag, number>>;

export interface ProviderScoringInput {
  providers: ProviderScoringProvider[];
  slot: ProviderScoringSlot;
  healthByProvider?: Partial<Record<ProviderId, ProviderHealth>>;
  currentTeamProviderCounts?: Partial<Record<ProviderId, number>>;
  capabilityProfiles?: Partial<Record<ProviderId, ProviderCapabilityProfile>>;
  now?: number;
}

const KNOWN_PROVIDER_CAPABILITIES: Record<string, ProviderCapabilityProfile> = {
  claude: {
    accessibility: 4,
    'api-contracts': 3,
    architecture: 4,
    'autonomous-tool-loop': 5,
    'broad-ideation': 4,
    code: 5,
    'code-review': 5,
    concurrency: 3,
    'cost-efficiency': 1,
    coordination: 5,
    'data-integrity': 3,
    'design-language': 4,
    'exact-retrieval': 2,
    'frontend-design': 4,
    'image-understanding': 4,
    implementation: 4,
    'information-architecture': 5,
    'interaction-design': 4,
    'knowledge-work': 5,
    latency: 4,
    'legal-finance': 5,
    'long-context': 5,
    'mcp-tooling': 5,
    'mission-receipts': 5,
    multimodal: 2,
    performance: 3,
    planning: 5,
    'prompt-security': 4,
    reasoning: 5,
    refactor: 4,
    reliability: 4,
    'schema-reliability': 4,
    'scientific-research': 5,
    security: 3,
    'source-synthesis': 3,
    'sql-data': 4,
    testing: 3,
    'tone-sensitive': 2,
    'ux-research': 5,
    'ux-synthesis': 5,
    'visual-design': 4,
    'web-research': 2,
    writing: 5,
  },
  codex: {
    accessibility: 4,
    'api-contracts': 5,
    architecture: 4,
    'autonomous-tool-loop': 4,
    'broad-ideation': 3,
    code: 5,
    'code-review': 5,
    concurrency: 5,
    'cost-efficiency': 3,
    coordination: 3,
    'data-integrity': 4,
    'design-language': 3,
    'exact-retrieval': 5,
    'frontend-design': 3,
    'image-understanding': 1,
    implementation: 5,
    'information-architecture': 3,
    'interaction-design': 3,
    'knowledge-work': 4,
    latency: 5,
    'legal-finance': 3,
    'long-context': 4,
    'mcp-tooling': 4,
    'mission-receipts': 4,
    multimodal: 1,
    performance: 4,
    planning: 4,
    'prompt-security': 5,
    reasoning: 4,
    refactor: 5,
    reliability: 5,
    'schema-reliability': 5,
    'scientific-research': 4,
    security: 4,
    'source-synthesis': 5,
    'sql-data': 5,
    testing: 5,
    'tone-sensitive': 2,
    'ux-research': 2,
    'ux-synthesis': 3,
    'visual-design': 2,
    'web-research': 5,
    writing: 3,
  },
  gemini: {
    accessibility: 3,
    'api-contracts': 2,
    architecture: 3,
    'autonomous-tool-loop': 1,
    'broad-ideation': 5,
    code: 2,
    'code-review': 2,
    concurrency: 2,
    'cost-efficiency': 5,
    coordination: 3,
    'data-integrity': 2,
    'design-language': 5,
    'exact-retrieval': 2,
    'frontend-design': 4,
    'image-understanding': 5,
    implementation: 2,
    'information-architecture': 4,
    'interaction-design': 4,
    'knowledge-work': 2,
    latency: 2,
    'legal-finance': 2,
    'long-context': 3,
    'mcp-tooling': 2,
    'mission-receipts': 2,
    multimodal: 5,
    performance: 2,
    planning: 3,
    'prompt-security': 2,
    reasoning: 3,
    refactor: 2,
    reliability: 2,
    'schema-reliability': 2,
    'scientific-research': 5,
    security: 2,
    'source-synthesis': 4,
    'sql-data': 1,
    testing: 2,
    'tone-sensitive': 2,
    'ux-research': 4,
    'ux-synthesis': 4,
    'visual-design': 5,
    'web-research': 3,
    writing: 4,
  },
  echo: {},
};

const PERSONA_CAPABILITY_TAGS: Record<string, ProviderCapabilityTag[]> = {
  'agentic-ai-prompt-security': ['prompt-security', 'security', 'reasoning'],
  'angular-specialist': ['frontend-design', 'code', 'implementation', 'testing'],
  'api-design-reviewer': ['api-contracts', 'architecture', 'schema-reliability', 'testing'],
  'architecture-reviewer': ['architecture', 'reasoning', 'planning', 'knowledge-work'],
  'concurrency-reviewer': ['concurrency', 'reliability', 'code', 'autonomous-tool-loop'],
  'copy-editor': ['writing'],
  'data-integrity-reviewer': ['data-integrity', 'testing', 'reliability', 'sql-data'],
  'engineering-manager': ['coordination', 'planning', 'reasoning', 'mission-receipts'],
  'interaction-designer': [
    'interaction-design',
    'frontend-design',
    'accessibility',
    'visual-design',
  ],
  'machine-learning-engineer': ['reasoning', 'performance', 'testing', 'scientific-research'],
  'performance-engineer': ['performance', 'code', 'testing', 'latency'],
  'principal-software-engineer': [
    'code',
    'architecture',
    'implementation',
    'code-review',
    'autonomous-tool-loop',
  ],
  'product-manager': ['planning', 'writing', 'reasoning'],
  'project-manager': ['coordination', 'planning', 'writing', 'mission-receipts'],
  'qa-lead': ['coordination', 'testing', 'planning', 'mission-receipts'],
  'quality-assurance-engineer': ['testing', 'accessibility', 'schema-reliability', 'code'],
  'reliability-engineer': [
    'reliability',
    'concurrency',
    'testing',
    'autonomous-tool-loop',
    'mcp-tooling',
  ],
  'security-engineer': ['security', 'prompt-security', 'code'],
  'technical-lead': ['architecture', 'planning', 'code', 'reasoning', 'knowledge-work'],
  'testing-reviewer': ['testing', 'code', 'schema-reliability'],
  'ux-accessibility-engineer': ['accessibility', 'frontend-design', 'testing', 'code'],
  'ux-architect': [
    'ux-synthesis',
    'information-architecture',
    'design-language',
    'accessibility',
    'knowledge-work',
  ],
  'ux-researcher': ['ux-research', 'broad-ideation', 'source-synthesis', 'cost-efficiency'],
  'visual-design-systems-designer': [
    'visual-design',
    'design-language',
    'frontend-design',
    'image-understanding',
  ],
};

export function defaultCapabilityTagsForPersona(
  personaId: string | undefined,
): ProviderCapabilityTag[] {
  if (!personaId) return [];
  return PERSONA_CAPABILITY_TAGS[personaId] ?? [];
}

export function defaultProviderPolicyForPersona(
  personaId: string | undefined,
): Pick<ProviderScoringSlot, 'preferredProviders' | 'fallbackProviders' | 'capabilityTags'> {
  const capabilityTags = defaultCapabilityTagsForPersona(personaId);
  switch (personaId) {
    case 'ux-architect':
      return {
        preferredProviders: ['claude', 'codex'],
        fallbackProviders: ['gemini'],
        capabilityTags,
      };
    case 'ux-researcher':
      return {
        preferredProviders: ['gemini', 'claude'],
        fallbackProviders: ['codex'],
        capabilityTags,
      };
    case 'interaction-designer':
      return {
        preferredProviders: ['gemini', 'claude'],
        fallbackProviders: ['codex'],
        capabilityTags,
      };
    case 'visual-design-systems-designer':
      return {
        preferredProviders: ['gemini', 'claude'],
        fallbackProviders: ['codex'],
        capabilityTags,
      };
    case 'ux-accessibility-engineer':
      return {
        preferredProviders: ['codex', 'claude'],
        fallbackProviders: ['gemini'],
        capabilityTags,
      };
    case 'principal-software-engineer':
    case 'technical-lead':
    case 'architecture-reviewer':
    case 'reliability-engineer':
      return {
        preferredProviders: ['claude', 'codex'],
        fallbackProviders: ['gemini'],
        capabilityTags,
      };
    case 'quality-assurance-engineer':
    case 'testing-reviewer':
    case 'api-design-reviewer':
    case 'concurrency-reviewer':
    case 'data-integrity-reviewer':
      return {
        preferredProviders: ['codex', 'claude'],
        fallbackProviders: ['gemini'],
        capabilityTags,
      };
    case 'project-manager':
    case 'product-manager':
    case 'engineering-manager':
    case 'qa-lead':
      return {
        preferredProviders: ['claude', 'codex'],
        fallbackProviders: ['gemini'],
        capabilityTags,
      };
    default:
      return {
        preferredProviders: ['claude', 'codex', 'gemini'],
        fallbackProviders: [],
        capabilityTags,
      };
  }
}

function boundedPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

function boundedRate(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (value > 1) return Math.max(0, Math.min(1, value / 100));
  return Math.max(0, Math.min(1, value));
}

function boundedTimestamp(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 10_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
}

function boundedWindowMinutes(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.max(1, Math.min(60 * 24 * 30, Math.trunc(value)));
}

function formatResetHorizon(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return 'reset unknown';
  const seconds = Math.max(0, Math.round((resetsAt - now) / 1000));
  if (seconds <= 0) return 'resets now';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `resets in ${days}d${hours}h`;
  if (hours > 0) return `resets in ${hours}h${minutes}m`;
  return `resets in ${minutes}m`;
}

interface QuotaPressure {
  label: '5h' | '7d' | '1d';
  percent: number;
  pressure: number;
  resetsAt?: number;
  windowMs: number;
}

function quotaWindowPressure(input: {
  label: '5h' | '7d' | '1d';
  percent: number | undefined;
  resetsAt: number | undefined;
  windowMinutes: number | undefined;
  defaultWindowMs: number;
  now: number;
}): QuotaPressure | null {
  if (input.percent === undefined || input.percent <= 0) return null;
  const windowMs = (input.windowMinutes ?? input.defaultWindowMs / 60_000) * 60_000;
  const resetsAt = input.resetsAt;
  if (resetsAt !== undefined && resetsAt <= input.now) return null;
  if (resetsAt === undefined) {
    return {
      label: input.label,
      percent: input.percent,
      pressure: input.percent,
      windowMs,
    };
  }

  const remainingMs = Math.max(0, Math.min(windowMs, resetsAt - input.now));
  const remainingFraction = remainingMs / windowMs;
  const elapsedFraction = Math.max(0.05, 1 - remainingFraction);
  const projectedAtReset = input.percent / elapsedFraction;
  const horizonAdjustedPercent = input.percent * (0.35 + 0.65 * remainingFraction);
  const overspendRisk = Math.max(0, projectedAtReset - 100) * 0.4;

  return {
    label: input.label,
    percent: input.percent,
    pressure: Math.max(0, Math.min(100, horizonAdjustedPercent + overspendRisk)),
    resetsAt,
    windowMs,
  };
}

function strongestQuotaPressure(health: ProviderHealth, now: number): QuotaPressure | null {
  const pressures = [
    quotaWindowPressure({
      label: '5h',
      percent: health.quota5hPercent,
      resetsAt: health.quota5hResetsAt,
      windowMinutes: health.quota5hWindowMinutes,
      defaultWindowMs: 5 * 60 * 60 * 1000,
      now,
    }),
    quotaWindowPressure({
      label: '7d',
      percent: health.quota7dPercent,
      resetsAt: health.quota7dResetsAt,
      windowMinutes: health.quota7dWindowMinutes,
      defaultWindowMs: 7 * 24 * 60 * 60 * 1000,
      now,
    }),
    quotaWindowPressure({
      label: '1d',
      percent: health.quotaDailyPercent,
      resetsAt: health.quotaDailyResetsAt,
      windowMinutes: health.quotaDailyWindowMinutes,
      defaultWindowMs: 24 * 60 * 60 * 1000,
      now,
    }),
  ].filter((pressure): pressure is QuotaPressure => pressure !== null);
  if (pressures.length === 0) return null;
  return pressures.sort((a, b) => b.pressure - a.pressure)[0] ?? null;
}

function quotaPressureDetail(pressure: QuotaPressure, now: number): string {
  return `${pressure.label} ${Math.round(pressure.percent)}%, ${formatResetHorizon(
    pressure.resetsAt,
    now,
  )}`;
}

function capabilityForProvider(
  providerId: ProviderId,
  inputProfiles: Partial<Record<ProviderId, ProviderCapabilityProfile>> | undefined,
): ProviderCapabilityProfile {
  return {
    ...(KNOWN_PROVIDER_CAPABILITIES[providerId] ?? {}),
    ...(inputProfiles?.[providerId] ?? {}),
  };
}

function pushCapabilityReason(
  candidate: Pick<ProviderScoreCandidate, 'reasons' | 'warnings'>,
  tag: ProviderCapabilityTag,
  value: number,
): void {
  if (value >= 4) {
    candidate.reasons.push(`strong ${tag}`);
  } else if (value >= 2) {
    candidate.reasons.push(`some ${tag}`);
  } else {
    candidate.warnings.push(`weak ${tag}`);
  }
}

function scoreHealth(
  health: ProviderHealth | undefined,
  reasons: string[],
  warnings: string[],
  now: number,
): {
  score: number;
  unavailable: boolean;
  normalizedHealth: ProviderHealth | null;
} {
  if (!health) {
    warnings.push('health unknown; using static capability profile only');
    return { score: 0, unavailable: false, normalizedHealth: null };
  }

  const normalizedHealth: ProviderHealth = {};
  if (health.available !== undefined) normalizedHealth.available = health.available;
  if (health.authenticated !== undefined) normalizedHealth.authenticated = health.authenticated;
  if (health.quotaStatus !== undefined) normalizedHealth.quotaStatus = health.quotaStatus;
  if (health.recentFailures !== undefined) normalizedHealth.recentFailures = health.recentFailures;
  if (health.recentRuns !== undefined) normalizedHealth.recentRuns = health.recentRuns;
  const quota5hPercent = boundedPercent(health.quota5hPercent);
  const quota7dPercent = boundedPercent(health.quota7dPercent);
  const quotaDailyPercent = boundedPercent(health.quotaDailyPercent);
  const quota5hResetsAtRaw = boundedTimestamp(health.quota5hResetsAt);
  const quota7dResetsAtRaw = boundedTimestamp(health.quota7dResetsAt);
  const quotaDailyResetsAtRaw = boundedTimestamp(health.quotaDailyResetsAt);
  const quota5hExpired = quota5hResetsAtRaw !== undefined && quota5hResetsAtRaw <= now;
  const quota7dExpired = quota7dResetsAtRaw !== undefined && quota7dResetsAtRaw <= now;
  const quotaDailyExpired = quotaDailyResetsAtRaw !== undefined && quotaDailyResetsAtRaw <= now;
  const quota5hResetsAt = quota5hExpired ? undefined : quota5hResetsAtRaw;
  const quota7dResetsAt = quota7dExpired ? undefined : quota7dResetsAtRaw;
  const quotaDailyResetsAt = quotaDailyExpired ? undefined : quotaDailyResetsAtRaw;
  const quota5hWindowMinutes = boundedWindowMinutes(health.quota5hWindowMinutes);
  const quota7dWindowMinutes = boundedWindowMinutes(health.quota7dWindowMinutes);
  const quotaDailyWindowMinutes = boundedWindowMinutes(health.quotaDailyWindowMinutes);
  const normalizedContextPercent = boundedPercent(health.contextPercent);
  const recentFailureRate = boundedRate(health.recentFailureRate);
  if (quota5hPercent !== undefined && !quota5hExpired)
    normalizedHealth.quota5hPercent = quota5hPercent;
  if (quota7dPercent !== undefined && !quota7dExpired)
    normalizedHealth.quota7dPercent = quota7dPercent;
  if (quotaDailyPercent !== undefined && !quotaDailyExpired)
    normalizedHealth.quotaDailyPercent = quotaDailyPercent;
  if (quota5hResetsAt !== undefined) normalizedHealth.quota5hResetsAt = quota5hResetsAt;
  if (quota7dResetsAt !== undefined) normalizedHealth.quota7dResetsAt = quota7dResetsAt;
  if (quotaDailyResetsAt !== undefined) normalizedHealth.quotaDailyResetsAt = quotaDailyResetsAt;
  if (quota5hWindowMinutes !== undefined && !quota5hExpired) {
    normalizedHealth.quota5hWindowMinutes = quota5hWindowMinutes;
  }
  if (quota7dWindowMinutes !== undefined && !quota7dExpired) {
    normalizedHealth.quota7dWindowMinutes = quota7dWindowMinutes;
  }
  if (quotaDailyWindowMinutes !== undefined && !quotaDailyExpired) {
    normalizedHealth.quotaDailyWindowMinutes = quotaDailyWindowMinutes;
  }
  if (normalizedContextPercent !== undefined)
    normalizedHealth.contextPercent = normalizedContextPercent;
  if (recentFailureRate !== undefined) normalizedHealth.recentFailureRate = recentFailureRate;

  let score = 0;
  let unavailable = false;
  if (normalizedHealth.available === false) {
    score -= 1000;
    unavailable = true;
    warnings.push('provider unavailable');
  }
  if (normalizedHealth.authenticated === false) {
    score -= 1000;
    unavailable = true;
    warnings.push('provider authentication unavailable');
  }
  if (normalizedHealth.quotaStatus && !/allowed|ok|available/i.test(normalizedHealth.quotaStatus)) {
    score -= 120;
    warnings.push(`quota status ${normalizedHealth.quotaStatus}`);
  }

  const quotaPressure = strongestQuotaPressure(normalizedHealth, now);
  if (quotaPressure) {
    const pressure = quotaPressure.pressure;
    const detail = quotaPressureDetail(quotaPressure, now);
    if (pressure >= 95) {
      score -= 90;
      warnings.push(`quota critical pressure ${Math.round(pressure)} (${detail})`);
    } else if (pressure >= 85) {
      score -= 50;
      warnings.push(`quota high pressure ${Math.round(pressure)} (${detail})`);
    } else if (pressure >= 70) {
      score -= 22;
      warnings.push(`quota elevated pressure ${Math.round(pressure)} (${detail})`);
    } else if (pressure >= 50) {
      score -= 12;
      warnings.push(`quota watch pressure ${Math.round(pressure)} (${detail})`);
    } else {
      reasons.push(`quota manageable pressure ${Math.round(pressure)} (${detail})`);
    }
  }

  const failureRate = normalizedHealth.recentFailureRate ?? 0;
  if (failureRate >= 0.5) {
    score -= 70;
    warnings.push(`recent failure rate ${Math.round(failureRate * 100)}%`);
  } else if (failureRate >= 0.25) {
    score -= 30;
    warnings.push(`recent failure rate ${Math.round(failureRate * 100)}%`);
  } else if (failureRate > 0) {
    score -= 10;
    warnings.push(`recent failure rate ${Math.round(failureRate * 100)}%`);
  }

  return { score, unavailable, normalizedHealth };
}

export function scoreProvidersForSlot(input: ProviderScoringInput): ProviderScoreResult {
  const policy = defaultProviderPolicyForPersona(input.slot.personaId);
  const preferredProviders = input.slot.preferredProviders ?? policy.preferredProviders ?? [];
  const fallbackProviders = input.slot.fallbackProviders ?? policy.fallbackProviders ?? [];
  const avoidProviders = new Set(input.slot.avoidProviders ?? []);
  const capabilityTags = input.slot.capabilityTags ?? policy.capabilityTags ?? [];
  const now = input.now ?? Date.now();

  const candidates = input.providers.map((provider): ProviderScoreCandidate => {
    const reasons: string[] = [];
    const warnings: string[] = [];
    let score = 0;

    if (avoidProviders.has(provider.id)) {
      score -= 120;
      warnings.push('provider explicitly avoided for this slot');
    }
    if (preferredProviders.includes(provider.id)) {
      score += 100;
      reasons.push('preferred provider for this slot');
    } else if (fallbackProviders.includes(provider.id)) {
      score += 60;
      reasons.push('fallback provider for this slot');
    } else {
      score += 15;
      warnings.push('not listed in slot provider policy');
    }

    const profile = capabilityForProvider(provider.id, input.capabilityProfiles);
    let capabilityScore = 0;
    for (const tag of capabilityTags) {
      const value = Math.max(0, Math.min(5, profile[tag] ?? 0));
      capabilityScore += value;
      score += value * 5;
      pushCapabilityReason({ reasons, warnings }, tag, value);
    }

    const saturation = input.currentTeamProviderCounts?.[provider.id] ?? 0;
    if (saturation > 0) {
      const penalty = saturation * 10;
      score -= penalty;
      warnings.push(
        `team already has ${saturation} ${provider.displayName ?? provider.id} slot(s)`,
      );
    }

    const healthScore = scoreHealth(input.healthByProvider?.[provider.id], reasons, warnings, now);
    score += healthScore.score;

    return {
      providerId: provider.id,
      score,
      unavailable: healthScore.unavailable,
      selected: false,
      reasons,
      warnings,
      capabilityScore,
      health: healthScore.normalizedHealth,
    };
  });

  candidates.sort((a, b) => {
    if (a.unavailable !== b.unavailable) return a.unavailable ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    return a.providerId.localeCompare(b.providerId);
  });

  const selected = candidates.find((candidate) => !candidate.unavailable) ?? null;
  if (selected) selected.selected = true;

  return {
    selectedProviderId: selected?.providerId ?? null,
    candidates,
    capabilityTags,
  };
}
