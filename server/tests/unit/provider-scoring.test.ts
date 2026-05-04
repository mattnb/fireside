import { describe, expect, it } from 'vitest';

import {
  defaultProviderPolicyForPersona,
  scoreProvidersForSlot,
  type ProviderScoringProvider,
} from '../../src/agents/provider-scoring.js';

const providers: ProviderScoringProvider[] = [
  { id: 'claude', displayName: 'Claude' },
  { id: 'codex', displayName: 'Codex' },
  { id: 'gemini', displayName: 'Gemini' },
];

describe('provider scoring', () => {
  it('selects a strong UX architect provider from persona defaults', () => {
    const policy = defaultProviderPolicyForPersona('ux-architect');
    const result = scoreProvidersForSlot({
      providers,
      slot: { personaId: 'ux-architect', ...policy },
      healthByProvider: {
        claude: { available: true, authenticated: true, quota5hPercent: 12, contextPercent: 20 },
        codex: { available: true, authenticated: true, contextPercent: 18 },
        gemini: { available: true, authenticated: true },
      },
    });

    expect(result.selectedProviderId).toBe('claude');
    expect(result.capabilityTags).toContain('ux-synthesis');
    expect(result.candidates[0]).toMatchObject({
      providerId: 'claude',
      selected: true,
      unavailable: false,
    });
    expect(result.candidates[0]?.reasons).toEqual(
      expect.arrayContaining(['preferred provider for this slot', 'strong ux-synthesis']),
    );
  });

  it('prefers Codex for implementation-heavy accessibility review', () => {
    const policy = defaultProviderPolicyForPersona('ux-accessibility-engineer');
    const result = scoreProvidersForSlot({
      providers,
      slot: { personaId: 'ux-accessibility-engineer', ...policy },
      healthByProvider: {
        claude: { available: true, authenticated: true, quota5hPercent: 8 },
        codex: { available: true, authenticated: true, contextPercent: 10 },
        gemini: { available: true, authenticated: true },
      },
    });

    expect(result.selectedProviderId).toBe('codex');
    expect(result.candidates[0]?.reasons).toEqual(
      expect.arrayContaining(['preferred provider for this slot', 'strong testing']),
    );
  });

  it('moves away from a preferred provider when quota is hot', () => {
    const result = scoreProvidersForSlot({
      providers,
      slot: {
        personaId: 'ux-architect',
        preferredProviders: ['claude'],
        fallbackProviders: ['codex', 'gemini'],
        capabilityTags: ['ux-synthesis', 'information-architecture', 'reasoning'],
      },
      healthByProvider: {
        claude: {
          available: true,
          authenticated: true,
          quota5hPercent: 97,
          quota7dPercent: 88,
          contextPercent: 94,
        },
        codex: { available: true, authenticated: true, contextPercent: 20 },
        gemini: { available: true, authenticated: true, contextPercent: 15 },
      },
    });

    expect(result.selectedProviderId).toBe('gemini');
    const claude = result.candidates.find((candidate) => candidate.providerId === 'claude');
    expect(claude?.warnings).toEqual(
      expect.arrayContaining(['quota critical pressure 97 (5h 97%, reset unknown)']),
    );
    expect(claude?.warnings.some((warning) => warning.includes('context'))).toBe(false);
  });

  it('normalizes context telemetry without using it for provider scoring', () => {
    const result = scoreProvidersForSlot({
      providers,
      slot: {
        personaId: 'quality-assurance-engineer',
        preferredProviders: ['codex', 'claude'],
        fallbackProviders: ['gemini'],
        capabilityTags: ['testing', 'schema-reliability', 'code'],
      },
      healthByProvider: {
        codex: { available: true, authenticated: true, contextPercent: 99 },
        claude: { available: true, authenticated: true, contextPercent: 5 },
        gemini: { available: true, authenticated: true },
      },
    });

    const codex = result.candidates.find((candidate) => candidate.providerId === 'codex');
    expect(result.selectedProviderId).toBe('codex');
    expect(codex?.health?.contextPercent).toBe(99);
    expect(codex?.warnings.some((warning) => warning.includes('context'))).toBe(false);
    expect(codex?.reasons.some((reason) => reason.includes('context'))).toBe(false);
  });

  it('uses reset horizon instead of raw quota percent alone', () => {
    const now = 1_800_000_000_000;
    const result = scoreProvidersForSlot({
      now,
      providers,
      slot: {
        personaId: 'technical-lead',
        preferredProviders: ['claude', 'codex'],
        fallbackProviders: ['gemini'],
        capabilityTags: ['reasoning'],
      },
      healthByProvider: {
        claude: {
          available: true,
          authenticated: true,
          quota7dPercent: 80,
          quota7dResetsAt: now + 8 * 60 * 60 * 1000,
          quota7dWindowMinutes: 7 * 24 * 60,
        },
        codex: {
          available: true,
          authenticated: true,
          quota7dPercent: 50,
          quota7dResetsAt: now + 5 * 24 * 60 * 60 * 1000,
          quota7dWindowMinutes: 7 * 24 * 60,
        },
        gemini: { available: true, authenticated: true },
      },
    });

    expect(result.selectedProviderId).toBe('claude');
    expect(
      result.candidates.find((candidate) => candidate.providerId === 'claude')?.reasons,
    ).toContain('quota manageable pressure 30 (7d 80%, resets in 8h0m)');
    expect(
      result.candidates.find((candidate) => candidate.providerId === 'codex')?.warnings,
    ).toContain('quota elevated pressure 71 (7d 50%, resets in 5d0h)');
  });

  it('uses Gemini daily quota pressure when available', () => {
    const now = 1_800_000_000_000;
    const result = scoreProvidersForSlot({
      now,
      providers,
      slot: {
        personaId: 'ux-researcher',
        preferredProviders: ['gemini', 'claude'],
        capabilityTags: ['ux-research', 'broad-ideation'],
      },
      healthByProvider: {
        gemini: {
          available: true,
          authenticated: true,
          quotaDailyPercent: 92,
          quotaDailyResetsAt: now + 20 * 60 * 60 * 1000,
          quotaDailyWindowMinutes: 24 * 60,
        },
        claude: { available: true, authenticated: true },
      },
    });

    expect(
      result.candidates.find((candidate) => candidate.providerId === 'gemini')?.warnings,
    ).toContain('quota critical pressure 100 (1d 92%, resets in 20h0m)');
  });

  it('ignores expired quota windows instead of treating them as active pressure', () => {
    const now = 1_800_000_000_000;
    const result = scoreProvidersForSlot({
      now,
      providers,
      slot: {
        personaId: 'quality-assurance-engineer',
        preferredProviders: ['codex', 'claude'],
        fallbackProviders: ['gemini'],
        capabilityTags: ['testing', 'schema-reliability', 'code'],
      },
      healthByProvider: {
        codex: {
          available: true,
          authenticated: true,
          quota5hPercent: 78,
          quota5hResetsAt: now - 60_000,
          quota5hWindowMinutes: 300,
          contextPercent: 20,
          recentFailureRate: 0,
        },
        claude: {
          available: true,
          authenticated: true,
          quota7dPercent: 37,
          quota7dResetsAt: now + 3 * 24 * 60 * 60 * 1000,
          quota7dWindowMinutes: 7 * 24 * 60,
          contextPercent: 19,
        },
        gemini: { available: true, authenticated: true },
      },
    });

    expect(result.selectedProviderId).toBe('codex');
    const codex = result.candidates.find((candidate) => candidate.providerId === 'codex');
    const codexWarnings = codex?.warnings ?? [];
    expect(codexWarnings.some((warning) => warning.includes('quota'))).toBe(false);
    expect(codex?.health?.quota5hPercent).toBeUndefined();
    expect(codex?.health?.quota5hResetsAt).toBeUndefined();
  });

  it('penalizes recent provider failures', () => {
    const result = scoreProvidersForSlot({
      providers,
      slot: {
        personaId: 'technical-lead',
        preferredProviders: ['codex', 'claude'],
        fallbackProviders: ['gemini'],
        capabilityTags: ['code', 'architecture', 'reasoning'],
      },
      healthByProvider: {
        codex: { available: true, authenticated: true, recentFailureRate: 0.67 },
        claude: { available: true, authenticated: true, recentFailureRate: 0 },
        gemini: { available: true, authenticated: true },
      },
    });

    expect(result.selectedProviderId).toBe('claude');
    expect(
      result.candidates.find((candidate) => candidate.providerId === 'codex')?.warnings,
    ).toContain('recent failure rate 67%');
  });

  it('uses team balance as a tie breaker without making health unknown fatal', () => {
    const result = scoreProvidersForSlot({
      providers,
      slot: {
        personaId: 'project-manager',
        preferredProviders: ['claude', 'codex'],
        fallbackProviders: ['gemini'],
        capabilityTags: ['planning', 'coordination'],
      },
      currentTeamProviderCounts: { claude: 3, codex: 0, gemini: 0 },
    });

    expect(result.selectedProviderId).toBe('codex');
    expect(
      result.candidates.find((candidate) => candidate.providerId === 'claude')?.warnings,
    ).toEqual(
      expect.arrayContaining([
        'team already has 3 Claude slot(s)',
        'health unknown; using static capability profile only',
      ]),
    );
  });

  it('excludes unavailable providers from selection', () => {
    const result = scoreProvidersForSlot({
      providers,
      slot: {
        personaId: 'visual-design-systems-designer',
        preferredProviders: ['gemini'],
        fallbackProviders: ['claude', 'codex'],
        capabilityTags: ['visual-design', 'design-language', 'frontend-design'],
      },
      healthByProvider: {
        gemini: { available: false, authenticated: true },
        claude: { available: true, authenticated: true },
        codex: { available: true, authenticated: true },
      },
    });

    expect(result.selectedProviderId).toBe('claude');
    const gemini = result.candidates.find((candidate) => candidate.providerId === 'gemini');
    expect(gemini).toMatchObject({ unavailable: true, selected: false });
    expect(gemini?.warnings).toContain('provider unavailable');
  });

  it('routes source synthesis and exact retrieval toward Codex/GPT priors', () => {
    const result = scoreProvidersForSlot({
      providers,
      slot: {
        id: 'research',
        preferredProviders: ['codex'],
        fallbackProviders: ['claude', 'gemini'],
        capabilityTags: ['web-research', 'source-synthesis', 'exact-retrieval'],
      },
    });

    expect(result.selectedProviderId).toBe('codex');
    expect(result.candidates[0]?.reasons).toEqual(
      expect.arrayContaining(['strong web-research', 'strong exact-retrieval']),
    );
    expect(
      result.candidates.find((candidate) => candidate.providerId === 'claude')?.reasons,
    ).toContain('some exact-retrieval');
  });

  it('routes long autonomous tool loops toward Claude while flagging Gemini weakness', () => {
    const result = scoreProvidersForSlot({
      providers,
      slot: {
        id: 'loop',
        preferredProviders: ['claude'],
        fallbackProviders: ['codex'],
        avoidProviders: ['gemini'],
        capabilityTags: ['autonomous-tool-loop', 'mcp-tooling', 'mission-receipts'],
      },
    });

    expect(result.selectedProviderId).toBe('claude');
    const gemini = result.candidates.find((candidate) => candidate.providerId === 'gemini');
    expect(gemini?.warnings).toEqual(
      expect.arrayContaining([
        'provider explicitly avoided for this slot',
        'weak autonomous-tool-loop',
      ]),
    );
  });

  it('routes cheap multimodal background analysis toward Gemini', () => {
    const result = scoreProvidersForSlot({
      providers,
      slot: {
        id: 'multimodal',
        preferredProviders: ['gemini'],
        fallbackProviders: ['claude', 'codex'],
        capabilityTags: ['cost-efficiency', 'multimodal', 'image-understanding', 'broad-ideation'],
      },
    });

    expect(result.selectedProviderId).toBe('gemini');
    expect(result.candidates[0]?.reasons).toEqual(
      expect.arrayContaining(['strong cost-efficiency', 'strong multimodal']),
    );
  });

  it('keeps Gemini away from SQL/data reasoning lanes', () => {
    const result = scoreProvidersForSlot({
      providers,
      slot: {
        id: 'sql',
        preferredProviders: ['codex'],
        fallbackProviders: ['claude'],
        avoidProviders: ['gemini'],
        capabilityTags: ['sql-data', 'data-integrity', 'schema-reliability'],
      },
    });

    expect(result.selectedProviderId).toBe('codex');
    expect(
      result.candidates.find((candidate) => candidate.providerId === 'gemini')?.warnings,
    ).toEqual(
      expect.arrayContaining(['provider explicitly avoided for this slot', 'weak sql-data']),
    );
  });
});
