// server/tests/unit/codex.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { codexSpec } from '../../src/agents/codex.js';
import { AgentParseError } from '../../src/agents/types.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const fresh = readFileSync(path.join(FIXTURE_DIR, 'codex-exec-jsonl.txt'), 'utf8');

describe('codex adapter', () => {
  it('builds argv for fresh session', () => {
    const argv = codexSpec.buildArgs('hi', null);
    expect(argv[0]).toBe('exec');
    expect(argv).toContain('--json');
    expect(argv).toContain('hi');
    expect(argv.includes('resume')).toBe(false);
  });

  it('builds argv for resumed session', () => {
    const argv = codexSpec.buildArgs('again', 'abc-123');
    expect(argv).toEqual(expect.arrayContaining(['exec', 'resume', '--last', '--json', 'again']));
  });

  it('parses fresh JSONL fixture', () => {
    const reply = codexSpec.parseOutput(fresh, '');
    expect(reply.text.toLowerCase()).toContain('pong');
    expect(reply.sessionId).toMatch(/.+/);
  });

  it('throws when no assistant message event present', () => {
    expect(() =>
      codexSpec.parseOutput(
        '{"type":"thread.started","thread_id":"s1"}\n{"type":"unknown"}',
        '',
      ),
    ).toThrow(AgentParseError);
  });
});
