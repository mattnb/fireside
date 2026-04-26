// server/tests/unit/gemini.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { geminiSpec } from '../../src/agents/gemini.js';
import { AgentParseError } from '../../src/agents/types.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const headless = readFileSync(path.join(FIXTURE_DIR, 'gemini-headless.json'), 'utf8');
const withPreamble = readFileSync(path.join(FIXTURE_DIR, 'gemini-with-preamble.json'), 'utf8');

describe('gemini adapter', () => {
  it('builds argv for fresh session', () => {
    const argv = geminiSpec.buildArgs('hi', null);
    expect(argv).toEqual(expect.arrayContaining(['-p', 'hi', '--output-format', 'json']));
    expect(argv).not.toContain('--resume');
  });

  it('builds argv for resumed session', () => {
    const argv = geminiSpec.buildArgs('again', 'session-abc');
    expect(argv).toContain('--resume');
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

  it('declares a defaultCwd outside the project so gemini stays in pure-chat mode', () => {
    // Without this, gemini-cli detects the broker's cwd as a project (it sees
    // `docs/`, source files, package.json) and switches into agentic /
    // tool-using mode, narrating intent and never producing JSON. The exact
    // path doesn't matter — only that the spec advertises one.
    expect(typeof geminiSpec.defaultCwd).toBe('string');
    expect((geminiSpec.defaultCwd as string).length).toBeGreaterThan(0);
  });
});
