import { beforeEach, describe, expect, it } from 'vitest';
import {
  GEMINI_STATS_SAMPLE_INTERVAL_MS,
  maybeSampleGeminiStatsModelQuota,
  resetGeminiStatsSamplerForTesting,
} from '../../src/agents/gemini-quota.js';

describe('Gemini quota sampler', () => {
  beforeEach(() => {
    resetGeminiStatsSamplerForTesting();
  });

  it('samples /stats model output once per throttle window', async () => {
    let calls = 0;
    const runStatsModel = async (): Promise<string> => {
      calls += 1;
      return 'Model: gemini-2.5-pro\nDaily quota usage: 11%\nStatus: allowed';
    };

    const first = await maybeSampleGeminiStatsModelQuota({
      now: () => 1_800_000_000_000,
      runStatsModel,
    });
    const second = await maybeSampleGeminiStatsModelQuota({
      now: () => 1_800_000_001_000,
      runStatsModel,
    });
    const third = await maybeSampleGeminiStatsModelQuota({
      now: () => 1_800_000_000_000 + GEMINI_STATS_SAMPLE_INTERVAL_MS + 1,
      runStatsModel,
    });

    expect(first?.quota?.daily?.percent).toBe(11);
    expect(second).toBeNull();
    expect(third?.quota?.daily?.percent).toBe(11);
    expect(calls).toBe(2);
  });

  it('fails soft when interactive stats output is unavailable', async () => {
    const usage = await maybeSampleGeminiStatsModelQuota({
      force: true,
      runStatsModel: async () => null,
    });

    expect(usage).toBeNull();
  });
});
