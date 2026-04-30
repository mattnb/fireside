// server/tests/unit/gemini.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { geminiSpec } from '../../src/agents/gemini.js';
import { AgentParseError } from '../../src/agents/types.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const headless = readFileSync(path.join(FIXTURE_DIR, 'gemini-headless.json'), 'utf8');
const withPreamble = readFileSync(path.join(FIXTURE_DIR, 'gemini-with-preamble.json'), 'utf8');

describe('gemini adapter', () => {
  it('builds argv for fresh session and sends the prompt through stdin', () => {
    const argv = geminiSpec.buildArgs('hi', null);
    expect(argv).toEqual(['-p', '', '--output-format', 'stream-json', '--approval-mode', 'plan']);
    expect(argv).not.toContain('hi');
    expect(argv).not.toContain('--resume');
    expect(geminiSpec.buildStdin?.('hi', null)).toBe('hi');
  });

  it('builds argv for resumed session with explicit session id', () => {
    const argv = geminiSpec.buildArgs('again', 'session-abc');
    expect(argv).toEqual([
      '-p',
      '',
      '--output-format',
      'stream-json',
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
