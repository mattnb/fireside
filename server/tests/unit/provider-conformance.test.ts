import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listAgentSpecs } from '../../src/agents/registry.js';
import type { AgentId, AgentSpec } from '../../src/agents/types.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

const PROVIDER_IDS = ['claude', 'codex', 'gemini'] as const satisfies readonly AgentId[];
const LONG_PROMPT = [
  'You are an agent in Fireside.',
  'Reply with exactly: pong',
  'This prompt deliberately contains enough text that passing it through argv would be fragile.',
].join('\n');

function providerSpecs(): AgentSpec[] {
  const specs = new Map(listAgentSpecs().map((spec) => [spec.id, spec]));
  return PROVIDER_IDS.map((id) => specs.get(id)!);
}

function fixtureFor(id: AgentId): string {
  switch (id) {
    case 'claude':
      return readFileSync(path.join(FIXTURE_DIR, 'claude-headless.json'), 'utf8');
    case 'codex':
      return readFileSync(path.join(FIXTURE_DIR, 'codex-exec-jsonl.txt'), 'utf8');
    case 'gemini':
      return readFileSync(path.join(FIXTURE_DIR, 'gemini-headless.json'), 'utf8');
    case 'echo':
      throw new Error('echo is not part of provider conformance');
    default:
      throw new Error(`unknown provider fixture: ${id}`);
  }
}

describe('provider adapter conformance', () => {
  it('covers every production provider', () => {
    expect(providerSpecs().map((spec) => spec.id)).toEqual([...PROVIDER_IDS]);
  });

  it.each(providerSpecs())('%s sends broker prompts through stdin, not argv', (spec) => {
    const argv = spec.buildArgs(LONG_PROMPT, null);
    expect(argv).not.toContain(LONG_PROMPT);
    expect(argv.join('\n')).not.toContain('Reply with exactly: pong');
    expect(spec.buildStdin?.(LONG_PROMPT, null)).toBe(LONG_PROMPT);
  });

  it.each(providerSpecs())('%s builds session and permission variants safely', (spec) => {
    const variants = [
      spec.buildArgs(LONG_PROMPT, 'session-123'),
      spec.buildArgs(LONG_PROMPT, null, {
        permission: {
          mode: 'edit',
          target: 'C:\\workspaces\\project\\docs\\brief.md',
          reason: 'edit a scoped document',
        },
      }),
      spec.buildArgs(LONG_PROMPT, null, {
        permission: {
          mode: 'full-auto',
          requestedMode: 'bash',
          target: 'C:\\workspaces\\project',
          reason: 'run scoped verification',
          capabilities: ['read', 'run-command', 'git-commit'],
        },
      }),
    ];

    for (const argv of variants) {
      expect(argv.length).toBeGreaterThan(0);
      expect(argv.every((part) => typeof part === 'string')).toBe(true);
      expect(argv.join('\n')).not.toContain('Reply with exactly: pong');
    }
  });

  it.each(providerSpecs())('%s exposes streaming and timeout contracts', (spec) => {
    expect(spec.defaultTimeoutMs).toBeGreaterThanOrEqual(600_000);
    expect(spec.parseStreamLine).toBeTypeOf('function');
    expect(() => spec.parseStreamLine?.('not json', 'stdout', 'session-123')).not.toThrow();
    expect(() =>
      spec.parseStreamLine?.('provider stderr detail', 'stderr', 'session-123'),
    ).not.toThrow();
  });

  it.each(providerSpecs())('%s parses the canonical pong fixture', (spec) => {
    const reply = spec.parseOutput(fixtureFor(spec.id), '');
    expect(reply.text.toLowerCase()).toContain('pong');
  });
});
