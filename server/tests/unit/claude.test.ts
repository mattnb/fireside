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
    expect(argv).toContain('hi');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('json');
    expect(argv).not.toContain('--resume');
  });

  it('builds correct argv for resumed session', () => {
    const argv = claudeSpec.buildArgs('again', 'abc-123');
    expect(argv).toContain('--resume');
    expect(argv).toContain('abc-123');
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
});
