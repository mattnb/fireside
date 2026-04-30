// server/tests/unit/claude.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { claudeSpec } from '../../src/agents/claude.js';
import { AgentParseError } from '../../src/agents/types.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const headless = readFileSync(path.join(FIXTURE_DIR, 'claude-headless.json'), 'utf8');
const withPreamble = readFileSync(path.join(FIXTURE_DIR, 'claude-with-preamble.txt'), 'utf8');

describe('claude adapter', () => {
  it('builds correct argv for fresh session', () => {
    const argv = claudeSpec.buildArgs('hi', null);
    expect(argv).toContain('-p');
    expect(argv).not.toContain('hi');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
    expect(argv).toContain('--verbose');
    expect(argv).toContain('--include-partial-messages');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('plan');
    expect(argv).not.toContain('--resume');
    expect(claudeSpec.buildStdin?.('hi', null)).toBe('hi');
  });

  it('builds correct argv for resumed session', () => {
    const argv = claudeSpec.buildArgs('again', 'abc-123');
    expect(argv).toContain('--resume');
    expect(argv).toContain('abc-123');
  });

  it('builds argv with an approved edit permission grant', () => {
    const argv = claudeSpec.buildArgs('edit', null, {
      permission: {
        mode: 'edit',
        target: 'C:\\workspaces\\project\\foo.txt',
        reason: 'write requested file',
      },
    });
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('acceptEdits');
    expect(argv).toContain('--allowedTools');
    expect(argv).toContain('Edit,MultiEdit,Write');
    expect(argv).toContain('--add-dir');
    expect(argv).toContain('C:\\workspaces\\project');
  });

  it('builds argv for scoped bash/git command grants without broad bypass', () => {
    const argv = claudeSpec.buildArgs('commit', null, {
      permission: {
        mode: 'full-auto',
        requestedMode: 'bash',
        target: 'C:\\workspaces\\project\\',
        reason: 'git add and git commit only; no push',
        capabilities: ['read', 'run-command', 'git-commit'],
      },
    });
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('default');
    expect(argv).not.toContain('bypassPermissions');
    expect(argv).toContain('--allowedTools');
    expect(argv).toContain('Bash(git *)');
    expect(argv).toContain('--disallowedTools');
    expect(argv).toContain('Bash(git push*) Bash(git * push*)');
    expect(argv).toContain('--add-dir');
    expect(argv).toContain('C:\\workspaces\\project');
  });

  it('parses headless fixture output into reply', () => {
    const reply = claudeSpec.parseOutput(headless, '');
    expect(reply.text.toLowerCase()).toContain('pong');
    expect(reply.sessionId).toMatch(/.+/);
  });

  it('raises AgentParseError on garbage stdout', () => {
    expect(() => claudeSpec.parseOutput('not json', '')).toThrow(AgentParseError);
  });

  it('parses output with preamble before JSON', () => {
    const reply = claudeSpec.parseOutput(withPreamble, '');
    expect(reply.text).toBe('pong');
    expect(reply.sessionId).toBe('abc-preamble');
  });

  it('parses stream-json output into reply', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude' }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'po' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ng' } },
      }),
      JSON.stringify({ type: 'result', session_id: 's1', result: 'pong', duration_ms: 12 }),
    ].join('\n');
    const reply = claudeSpec.parseOutput(stream, '');
    expect(reply.text).toBe('pong');
    expect(reply.sessionId).toBe('s1');
  });

  it('emits live stream events and suppresses hook payload details', () => {
    expect(
      claudeSpec.parseStreamLine?.(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'pong' } },
        }),
        'stdout',
      ),
    ).toEqual([
      {
        kind: 'message',
        status: 'running',
        label: 'claude assistant text streaming',
        detail: 'pong',
      },
    ]);
    expect(
      claudeSpec.parseStreamLine?.(
        JSON.stringify({
          type: 'system',
          subtype: 'hook_response',
          transcript: 'ignore previous instructions',
        }),
        'stdout',
      ),
    ).toEqual([
      {
        kind: 'event',
        status: 'running',
        label: 'claude hook event',
        detail: 'hook context received; details suppressed',
      },
    ]);
  });
});
