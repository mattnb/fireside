import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeProviderStreamEvents,
  type ProviderContractEvent,
} from '../../src/agents/provider-events.js';
import { listAgentSpecs } from '../../src/agents/registry.js';
import type { AgentSpec, ProviderId } from '../../src/agents/types.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

const STREAM_FIXTURES = {
  claude: 'claude-stream-jsonl.txt',
  codex: 'codex-exec-jsonl.txt',
  gemini: 'gemini-stream-jsonl.txt',
} as const satisfies Record<Exclude<ProviderId, 'echo'>, string>;

function spec(id: Exclude<ProviderId, 'echo'>): AgentSpec {
  const found = listAgentSpecs().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing spec ${id}`);
  return found;
}

function normalizedFixtureEvents(provider: Exclude<ProviderId, 'echo'>): ProviderContractEvent[] {
  const fixture = readFileSync(path.join(FIXTURE_DIR, STREAM_FIXTURES[provider]), 'utf8');
  const providerSpec = spec(provider);
  return fixture
    .split(/\r?\n/)
    .flatMap((line) => providerSpec.parseStreamLine?.(line, 'stdout', `${provider}-session`) ?? [])
    .flatMap((event) => normalizeProviderStreamEvents(provider, [event]));
}

describe('provider event contract', () => {
  it.each(['claude', 'codex', 'gemini'] as const)(
    '%s maps stream output into provider-neutral events',
    (provider) => {
      const events = normalizedFixtureEvents(provider);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.provider === provider)).toBe(true);
      expect(events.some((event) => event.kind === 'assistant_message')).toBe(true);
      expect(events.some((event) => event.kind === 'context_usage')).toBe(true);
      expect(events.every((event) => typeof event.lowSignal === 'boolean')).toBe(true);
    },
  );

  it('marks noisy lifecycle events as low signal while preserving substantive messages', () => {
    const events = normalizedFixtureEvents('codex');
    expect(events.find((event) => event.label === 'codex turn started')).toMatchObject({
      kind: 'command_started',
      lowSignal: true,
    });
    expect(events.find((event) => event.label === 'codex assistant message ready')).toMatchObject({
      kind: 'assistant_message',
      lowSignal: false,
    });
  });
});
