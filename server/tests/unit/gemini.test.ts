// server/tests/unit/gemini.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { geminiSpec } from '../../src/agents/gemini.js';
import { AgentParseError } from '../../src/agents/types.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const headless = readFileSync(path.join(FIXTURE_DIR, 'gemini-headless.json'), 'utf8');
const withPreamble = readFileSync(path.join(FIXTURE_DIR, 'gemini-with-preamble.json'), 'utf8');

describe('gemini adapter', () => {
  it('builds argv for fresh session and sends the prompt through stdin', () => {
    const argv = geminiSpec.buildArgs('hi', null);
    expect(argv).toEqual([
      '-p',
      '',
      '--output-format',
      'stream-json',
      '--skip-trust',
      '--approval-mode',
      'plan',
    ]);
    expect(argv).not.toContain('hi');
    expect(argv).not.toContain('--resume');
    expect(geminiSpec.buildStdin?.('hi', null)).toBe('hi');
    expect(geminiSpec.buildEnv?.('hi', null)).toEqual({
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
    });
  });

  it('builds argv for resumed session with explicit session id', () => {
    const argv = geminiSpec.buildArgs('again', 'session-abc');
    expect(argv).toEqual([
      '-p',
      '',
      '--output-format',
      'stream-json',
      '--skip-trust',
      '--approval-mode',
      'plan',
      '--resume',
      'session-abc',
    ]);
  });

  it('builds argv with an approved edit permission grant', () => {
    const argv = geminiSpec.buildArgs('edit', null, {
      permission: {
        mode: 'edit',
        target: 'C:\\workspaces\\project\\foo.txt',
        reason: 'write requested file',
      },
    });
    expect(argv).toContain('--approval-mode');
    expect(argv).toContain('auto_edit');
    expect(argv).toContain('--include-directories');
    expect(argv).toContain('C:\\workspaces\\project');
  });

  it('expands unrestricted YOLO into concrete trusted include directories', () => {
    const argv = geminiSpec.buildArgs('edit anywhere', null, {
      permission: {
        mode: 'full-auto',
        target: 'unrestricted filesystem',
        reason: 'YOLO run',
        filesystemScope: 'unrestricted',
      },
    });
    const includeIndex = argv.indexOf('--include-directories');
    expect(argv).toContain('--skip-trust');
    expect(argv).toContain('yolo');
    expect(includeIndex).toBeGreaterThanOrEqual(0);
    const includeDirs = argv[includeIndex + 1] ?? '';
    expect(includeDirs).toContain(process.cwd());
    expect(includeDirs).toContain(path.resolve(process.cwd(), '..'));
    expect(includeDirs).toContain(os.tmpdir());
  });

  it('parses headless fixture', () => {
    const reply = geminiSpec.parseOutput(headless, '');
    expect(reply.text.toLowerCase()).toContain('pong');
  });

  it('throws on garbage stdout', () => {
    expect(() => geminiSpec.parseOutput('not json', '')).toThrow(AgentParseError);
  });

  it('parses output with preamble before JSON', () => {
    const reply = geminiSpec.parseOutput(withPreamble, '');
    expect(reply.text).toBe('pong');
    expect(reply.sessionId).toBe('def-preamble');
  });

  it('parses stream-json output into reply', () => {
    const stream = [
      JSON.stringify({ type: 'init', session_id: 's1', model: 'gemini' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'po', delta: true }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'ng', delta: true }),
      JSON.stringify({ type: 'result', status: 'success', stats: { duration_ms: 12 } }),
    ].join('\n');
    const reply = geminiSpec.parseOutput(stream, '');
    expect(reply.text).toBe('pong');
    expect(reply.sessionId).toBe('s1');
  });

  it('ignores tool result output when parsing the visible stream reply', () => {
    const stream = [
      JSON.stringify({ type: 'init', session_id: 's1', model: 'gemini' }),
      JSON.stringify({
        type: 'tool_result',
        status: 'success',
        output: 'Read lines 1-100 of 510 from mockups-preview.html',
      }),
      JSON.stringify({ type: 'message', role: 'assistant', content: '@jimmy verified ', delta: true }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'the visual foundation.', delta: true }),
      JSON.stringify({
        type: 'tool_result',
        status: 'success',
        output: 'Read lines 110-160 of 510 from mockups-preview.html',
      }),
      JSON.stringify({ type: 'result', status: 'success', stats: { duration_ms: 12 } }),
    ].join('\n');

    const reply = geminiSpec.parseOutput(stream, '');
    expect(reply.text).toBe('@jimmy verified the visual foundation.');
  });

  it('does not treat a tool-only stream as a chat reply', () => {
    const stream = [
      JSON.stringify({ type: 'init', session_id: 's1', model: 'gemini' }),
      JSON.stringify({
        type: 'tool_result',
        status: 'success',
        output: 'Found 12 matching file(s)',
      }),
      JSON.stringify({ type: 'result', status: 'success', stats: { duration_ms: 12 } }),
    ].join('\n');

    expect(() => geminiSpec.parseOutput(stream, '')).toThrow(AgentParseError);
  });

  it('emits live stream events from stream-json lines', () => {
    expect(
      geminiSpec.parseStreamLine?.(
        JSON.stringify({ type: 'message', role: 'assistant', content: 'pong', delta: true }),
        'stdout',
      ),
    ).toEqual([
      {
        kind: 'message',
        status: 'running',
        label: 'gemini assistant text streaming',
        detail: 'pong',
      },
    ]);
  });

  it('emits context usage from stream-json result stats', () => {
    expect(
      geminiSpec.parseStreamLine?.(
        JSON.stringify({
          type: 'result',
          status: 'success',
          stats: {
            usage_metadata: {
              input_token_count: 15,
              output_token_count: 8,
              total_token_count: 23,
              cached_content_token_count: 0,
            },
            duration_ms: 450,
            model: 'gemini-2.0-flash-exp',
          },
        }),
        'stdout',
      ),
    ).toEqual([
      {
        kind: 'usage',
        status: 'completed',
        label: 'gemini result received',
        detail: 'gemini-2.0-flash-exp: 23 used / window unknown',
        contextUsage: {
          provider: 'gemini',
          model: 'gemini-2.0-flash-exp',
          usedTokens: 23,
          inputTokens: 15,
          cachedInputTokens: 0,
          outputTokens: 8,
          source: 'gemini:stats.usage_metadata',
        },
      },
    ]);
  });

  it('emits context usage from legacy model token stats', () => {
    expect(
      geminiSpec.parseStreamLine?.(
        JSON.stringify({
          type: 'result',
          status: 'success',
          stats: {
            models: {
              'gemini-2.5-flash-lite': {
                tokens: { input: 10, output: 2, total: 12, cached: 3 },
              },
            },
          },
        }),
        'stdout',
      ),
    ).toEqual([
      {
        kind: 'usage',
        status: 'completed',
        label: 'gemini result received',
        detail: 'gemini-2.5-flash-lite: 12 used / window unknown',
        contextUsage: {
          provider: 'gemini',
          model: 'gemini-2.5-flash-lite',
          usedTokens: 12,
          inputTokens: 10,
          cachedInputTokens: 3,
          outputTokens: 2,
          source: 'gemini:stats.models.tokens',
        },
      },
    ]);
  });

  it('creates a fresh empty cwd per turn', () => {
    const first = geminiSpec.buildCwd?.('first', null);
    const second = geminiSpec.buildCwd?.('second', null);
    expect(typeof first).toBe('string');
    expect(typeof second).toBe('string');
    expect(first).not.toBe(second);
    expect(path.basename(first as string)).toMatch(/^fireside-gemini-cwd-/);
    expect(fs.existsSync(first as string)).toBe(true);
    expect(fs.readdirSync(first as string)).toEqual([]);
  });
});
