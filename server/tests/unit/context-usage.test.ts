import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeContextUsage,
  codexContextUsage,
  codexContextWindowForModel,
  readCodexConfig,
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
});
