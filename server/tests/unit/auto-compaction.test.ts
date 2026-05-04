import { describe, expect, it } from 'vitest';
import {
  autoContextMaintenanceDecision,
  modelContextWindow,
} from '../../src/orchestration/auto-compaction.js';

describe('auto context maintenance policy', () => {
  it('maps known model context windows', () => {
    expect(modelContextWindow('claude', 'claude-opus-4-7[1m]')).toBe(1_000_000);
    expect(modelContextWindow('claude', 'claude-opus-4-6')).toBe(1_000_000);
    expect(modelContextWindow('claude', 'claude-sonnet-4-6')).toBe(256_000);
    expect(modelContextWindow('claude', 'claude-haiku-4-5')).toBe(256_000);
    expect(modelContextWindow('codex', 'gpt-5.4-mini')).toBe(400_000);
    expect(modelContextWindow('gemini', 'gemini-3.1-pro-preview')).toBe(1_000_000);
    expect(modelContextWindow('gemini', 'gemini-3-flash-preview')).toBe(1_000_000);
    expect(modelContextWindow('gemini', 'gemini-3.1-flash-lite-preview')).toBe(1_000_000);
  });

  it('uses the lower of percentage and absolute token thresholds', () => {
    const opusDecision = autoContextMaintenanceDecision(
      { providerId: 'claude', modelId: 'claude-opus-4-7[1m]' },
      {
        provider: 'claude',
        model: 'claude-opus-4-7[1m]',
        usedTokens: 230_000,
        source: 'test',
      },
      { enabled: true, percentThreshold: 70, tokenThreshold: 220_000 },
    );
    expect(opusDecision).toMatchObject({
      action: 'compact',
      thresholdTokens: 220_000,
      contextWindow: 1_000_000,
    });

    const sonnetDecision = autoContextMaintenanceDecision(
      { providerId: 'claude', modelId: 'claude-sonnet-4-6' },
      {
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        usedTokens: 180_000,
        source: 'test',
      },
      { enabled: true, percentThreshold: 70, tokenThreshold: 220_000 },
    );
    expect(sonnetDecision).toMatchObject({
      action: 'compact',
      thresholdTokens: 179_200,
      contextWindow: 256_000,
    });
  });

  it('ignores quota-only telemetry and uses provider compaction for Gemini', () => {
    expect(
      autoContextMaintenanceDecision(
        { providerId: 'claude', modelId: 'claude-opus-4-7[1m]' },
        {
          provider: 'claude',
          model: 'claude-opus-4-7[1m]',
          usedTokens: 0,
          quotaOnly: true,
          source: 'quota',
        },
        { enabled: true, percentThreshold: 70, tokenThreshold: 220_000 },
      ),
    ).toBeNull();

    expect(
      autoContextMaintenanceDecision(
        { providerId: 'gemini', modelId: 'gemini-3.1-pro-preview' },
        {
          provider: 'gemini',
          model: 'gemini-3.1-pro-preview',
          usedTokens: 760_000,
          source: 'test',
        },
        { enabled: true, percentThreshold: 70, tokenThreshold: 900_000 },
      ),
    ).toMatchObject({
      action: 'compact',
      thresholdTokens: 700_000,
    });
  });
});
