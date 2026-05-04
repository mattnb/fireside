import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeContextUsage,
  claudeDebugQuotaUsage,
  claudeQuotaUsage,
  codexContextUsage,
  codexContextWindowForModel,
  formatQuotaUsage,
  geminiContextUsage,
  geminiStatsModelQuotaUsage,
  readCodexConfig,
  readLatestCodexRolloutTokenUsage,
} from '../../src/context-usage.js';

const ORIGINAL_ENV = {
  CODEX_HOME: process.env.CODEX_HOME,
  FIRESIDE_CODEX_MODEL: process.env.FIRESIDE_CODEX_MODEL,
  FIRESIDE_CODEX_REASONING_EFFORT: process.env.FIRESIDE_CODEX_REASONING_EFFORT,
  FIRESIDE_CODEX_CONTEXT_WINDOW: process.env.FIRESIDE_CODEX_CONTEXT_WINDOW,
  FIRESIDE_CODEX_AUTO_COMPACT_TOKENS: process.env.FIRESIDE_CODEX_AUTO_COMPACT_TOKENS,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('context usage telemetry', () => {
  beforeEach(() => {
    restoreEnv();
    delete process.env.FIRESIDE_CODEX_MODEL;
    delete process.env.FIRESIDE_CODEX_REASONING_EFFORT;
    delete process.env.FIRESIDE_CODEX_CONTEXT_WINDOW;
    delete process.env.FIRESIDE_CODEX_AUTO_COMPACT_TOKENS;
  });

  afterEach(() => {
    restoreEnv();
  });

  it('uses known Codex context windows for Codex models', () => {
    expect(codexContextWindowForModel('gpt-5.5')).toBe(400_000);
    expect(codexContextWindowForModel('gpt-5.3-codex')).toBe(400_000);
    expect(codexContextWindowForModel('unknown-model')).toBeUndefined();
  });

  it('reads Codex model settings from root config keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fireside-codex-config-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(
      configPath,
      [
        'model = "gpt-5.5"',
        'model_reasoning_effort = "xhigh"',
        'model_context_window = 500_000',
        'model_auto_compact_token_limit = 460000',
        '',
        '[tui]',
        'status_line = "ignored"',
      ].join('\n'),
    );

    expect(readCodexConfig(configPath)).toMatchObject({
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      contextWindow: 500_000,
      autoCompactAtTokens: 460_000,
      source: `config:${configPath}`,
    });
  });

  it('builds Codex usage with configured model defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fireside-codex-home-'));
    fs.writeFileSync(
      path.join(dir, 'config.toml'),
      ['model = "gpt-5.5"', 'model_reasoning_effort = "xhigh"'].join('\n'),
    );
    process.env.CODEX_HOME = dir;

    const usage = codexContextUsage({
      input_tokens: 13713,
      cached_input_tokens: 11136,
      output_tokens: 24,
      reasoning_output_tokens: 17,
    });

    expect(usage).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      usedTokens: 13737,
      inputTokens: 13713,
      outputTokens: 24,
      reasoningOutputTokens: 17,
      cachedInputTokens: 11136,
      contextWindow: 400_000,
      remainingTokens: 386_263,
    });
    expect(usage?.percentUsed).toBeCloseTo(3.43, 1);
  });

  it('adjusts impossible Codex cumulative token totals for context display', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fireside-codex-home-'));
    fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "gpt-5.5"\n');
    process.env.CODEX_HOME = dir;

    const usage = codexContextUsage({
      input_tokens: 4_472_333,
      cached_input_tokens: 4_281_856,
      output_tokens: 27_029,
      reasoning_output_tokens: 10_060,
    });

    expect(usage).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      usedTokens: 217_506,
      reportedUsedTokens: 4_499_362,
      estimated: true,
      contextWindow: 400_000,
    });
    expect(usage?.percentUsed).toBeCloseTo(54.38, 1);
  });

  it('prefers Codex local rollout last-token usage over cumulative JSONL totals', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fireside-codex-rollout-'));
    const threadId = '019ddf41-f38c-7100-91fd-f18b3a712da9';
    const rolloutDir = path.join(dir, 'sessions', '2026', '04', '30');
    fs.mkdirSync(rolloutDir, { recursive: true });
    fs.writeFileSync(
      path.join(rolloutDir, `rollout-2026-04-30T13-38-54-${threadId}.jsonl`),
      [
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 30_877_128,
                cached_input_tokens: 29_767_424,
                output_tokens: 135_176,
                reasoning_output_tokens: 56_290,
                total_tokens: 31_012_304,
              },
              last_token_usage: {
                input_tokens: 206_185,
                cached_input_tokens: 205_696,
                output_tokens: 1_420,
                reasoning_output_tokens: 0,
                total_tokens: 207_605,
              },
              model_context_window: 258_400,
            },
            rate_limits: {
              primary: {
                used_percent: 9.2,
                window_minutes: 300,
                resets_at: 1777610101,
              },
              secondary: {
                used_percent: 26.4,
                window_minutes: 10080,
                resets_at: 1777977444,
              },
              plan_type: 'prolite',
              rate_limit_reached_type: null,
            },
          },
        }),
      ].join('\n'),
    );
    process.env.CODEX_HOME = dir;
    process.env.FIRESIDE_CODEX_MODEL = 'gpt-5.5';
    process.env.FIRESIDE_CODEX_REASONING_EFFORT = 'xhigh';

    expect(readLatestCodexRolloutTokenUsage(threadId, dir)).toMatchObject({
      totalTokens: 207_605,
      contextWindow: 258_400,
    });

    const usage = codexContextUsage(
      {
        input_tokens: 30_877_128,
        cached_input_tokens: 29_767_424,
        output_tokens: 135_176,
        reasoning_output_tokens: 56_290,
      },
      { threadId, codexHome: dir },
    );

    expect(usage).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      usedTokens: 207_605,
      reportedUsedTokens: 31_012_304,
      inputTokens: 206_185,
      cachedInputTokens: 205_696,
      outputTokens: 1_420,
      contextWindow: 258_400,
      quota: {
        fiveHour: { percent: 9.2, windowMinutes: 300, resetsAt: 1777610101000 },
        sevenDay: { percent: 26.4, windowMinutes: 10080, resetsAt: 1777977444000 },
        planType: 'prolite',
        rateLimitReachedType: null,
      },
    });
    expect(usage?.estimated).toBeUndefined();
    expect(usage?.percentUsed).toBeCloseTo(80.34, 1);
  });

  it('builds Claude usage from modelUsage result metadata', () => {
    const usage = claudeContextUsage({
      modelUsage: {
        'claude-opus-4-7[1m]': {
          inputTokens: 6,
          outputTokens: 6,
          cacheReadInputTokens: 19575,
          cacheCreationInputTokens: 21880,
          contextWindow: 1_000_000,
        },
      },
    });

    expect(usage).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-4-7[1m]',
      usedTokens: 41467,
      contextWindow: 1_000_000,
      remainingTokens: 958_533,
    });
  });

  it('attaches Claude quota windows when result metadata includes rate limits', () => {
    const usage = claudeContextUsage({
      rate_limits: {
        five_hour: { used_percentage: 43, resets_at: 1777610101 },
        seven_day: { used_percentage: 12, resets_at: 1777977444 },
      },
      modelUsage: {
        'claude-opus-4-7[1m]': {
          inputTokens: 6,
          outputTokens: 6,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 1_000_000,
        },
      },
    });

    expect(usage).toMatchObject({
      provider: 'claude',
      quota: {
        fiveHour: { percent: 43, windowMinutes: 300, resetsAt: 1777610101000 },
        sevenDay: { percent: 12, windowMinutes: 10080, resetsAt: 1777977444000 },
      },
    });
  });

  it('captures Claude reset-only rate limit events', () => {
    const usage = claudeQuotaUsage({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 1777776000,
        rateLimitType: 'five_hour',
      },
    });

    expect(usage).toMatchObject({
      provider: 'claude',
      quotaOnly: true,
      quota: {
        fiveHour: {
          windowMinutes: 300,
          resetsAt: 1777776000000,
          status: 'allowed',
        },
      },
    });
    expect(usage?.quota?.fiveHour?.percent).toBeUndefined();
  });

  it('captures Claude quota utilization from debug response headers', () => {
    const usage = claudeDebugQuotaUsage(
      [
        '"anthropic-ratelimit-unified-5h-utilization": "0.13"',
        '"anthropic-ratelimit-unified-5h-reset": "1777776000"',
        '"anthropic-ratelimit-unified-5h-status": "allowed"',
        '"anthropic-ratelimit-unified-7d-utilization": "0.23"',
        '"anthropic-ratelimit-unified-7d-reset": "1778101200"',
        '"anthropic-ratelimit-unified-7d-status": "allowed"',
        '"anthropic-ratelimit-unified-representative-claim": "five_hour"',
        '"anthropic-ratelimit-unified-overage-status": "rejected"',
      ].join('\n'),
      'claude-opus-4-7[1m]',
    );

    expect(usage).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-4-7[1m]',
      quotaOnly: true,
      quota: {
        fiveHour: {
          percent: 13,
          windowMinutes: 300,
          resetsAt: 1777776000000,
          status: 'allowed',
        },
        sevenDay: {
          percent: 23,
          windowMinutes: 10080,
          resetsAt: 1778101200000,
          status: 'allowed',
        },
        representativeClaim: 'five_hour',
        overageStatus: 'rejected',
      },
    });
  });

  it('uses Claude top-level usage and adjusts impossible aggregate cache totals', () => {
    const usage = claudeContextUsage({
      usage: {
        input_tokens: 23,
        output_tokens: 19_423,
        cache_read_input_tokens: 1_260_812,
        cache_creation_input_tokens: 74_958,
      },
      modelUsage: {
        'claude-opus-4-7[1m]': {
          inputTokens: 23,
          outputTokens: 19_423,
          cacheReadInputTokens: 1_260_812,
          cacheCreationInputTokens: 74_958,
          contextWindow: 1_000_000,
        },
      },
    });

    expect(usage).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-4-7[1m]',
      usedTokens: 94_404,
      reportedUsedTokens: 1_355_216,
      estimated: true,
      contextWindow: 1_000_000,
    });
  });

  it('builds Gemini usage from stream-json result stats', () => {
    const usage = geminiContextUsage({
      type: 'result',
      stats: {
        model: 'gemini-2.5-pro',
        usage_metadata: {
          input_token_count: 15,
          output_token_count: 8,
          total_token_count: 23,
          cached_content_token_count: 2,
        },
      },
    });

    expect(usage).toMatchObject({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      usedTokens: 23,
      inputTokens: 15,
      outputTokens: 8,
      cachedInputTokens: 2,
      source: 'gemini:stats.usage_metadata',
    });
  });

  it('parses Gemini /stats model quota output as a daily quota window', () => {
    const now = 1_800_000_000_000;
    const usage = geminiStatsModelQuotaUsage(
      [
        'Model: gemini-2.5-pro',
        'Daily quota usage: 37%',
        'Requests: 37 / 100 requests',
        'Resets in 2h15m',
        'Status: allowed',
      ].join('\n'),
      { now },
    );

    expect(usage).toMatchObject({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      usedTokens: 0,
      quotaOnly: true,
      quota: {
        daily: {
          percent: 37,
          windowMinutes: 1_440,
          resetsAt: now + 8_100_000,
          status: 'allowed',
        },
        source: 'gemini:stats-model',
      },
    });
    expect(formatQuotaUsage(usage!.quota!)).toBe('quota 1d 37%');
  });

  it('derives Gemini /stats model quota percentage from remaining request counts', () => {
    const usage = geminiStatsModelQuotaUsage(
      'Gemini model stats\nModel ID: gemini-2.5-flash\n75 requests remaining of 100 daily quota',
      { now: 1_800_000_000_000 },
    );

    expect(usage?.quota?.daily).toMatchObject({
      percent: 25,
      windowMinutes: 1_440,
    });
  });
});
