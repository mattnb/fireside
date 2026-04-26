// server/tests/unit/codex.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { codexSpec, _resetSchemaPathForTests } from '../../src/agents/codex.js';
import { AgentParseError } from '../../src/agents/types.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const fresh = readFileSync(path.join(FIXTURE_DIR, 'codex-exec-jsonl.txt'), 'utf8');

describe('codex adapter', () => {
  beforeEach(() => {
    _resetSchemaPathForTests();
  });

  it('builds argv for fresh session (prompt via stdin)', () => {
    const argv = codexSpec.buildArgs('hi', null);
    expect(argv[0]).toBe('exec');
    expect(argv).toContain('--json');
    expect(argv).toContain('--output-schema');
    expect(argv.includes('resume')).toBe(false);
    // Prompt is no longer in argv — codex reads it from stdin via positional `-`.
    expect(argv[argv.length - 1]).toBe('-');
    expect(argv).not.toContain('hi');

    // --output-schema path must exist on disk and contain the schema we expect.
    const schemaIdx = argv.indexOf('--output-schema');
    expect(schemaIdx).toBeGreaterThan(-1);
    const schemaPath = argv[schemaIdx + 1];
    expect(typeof schemaPath).toBe('string');
    expect(fs.existsSync(schemaPath as string)).toBe(true);
    const schema = JSON.parse(fs.readFileSync(schemaPath as string, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(schema['type']).toBe('object');
    const props = schema['properties'] as Record<string, unknown>;
    expect(props['message']).toBeDefined();
    expect(schema['required']).toEqual(['message']);
  });

  it('builds argv for resumed session (prompt via stdin)', () => {
    const argv = codexSpec.buildArgs('again', 'abc-123');
    // codex exec resume --json --output-schema <path> <SESSION_ID> -
    expect(argv[0]).toBe('exec');
    expect(argv[1]).toBe('resume');
    expect(argv).toContain('abc-123');
    expect(argv).not.toContain('--last');
    expect(argv).toContain('--json');
    expect(argv).toContain('--output-schema');
    expect(argv[argv.length - 1]).toBe('-');
    expect(argv).not.toContain('again');
  });

  it('passes the prompt via stdin', () => {
    expect(codexSpec.buildStdin?.('hello prompt', null)).toBe('hello prompt');
    expect(codexSpec.buildStdin?.('multi\nline\nprompt', 'sid')).toBe('multi\nline\nprompt');
  });

  it('reuses the same schema file across calls', () => {
    const a = codexSpec.buildArgs('first', null);
    const b = codexSpec.buildArgs('second', null);
    const aPath = a[a.indexOf('--output-schema') + 1];
    const bPath = b[b.indexOf('--output-schema') + 1];
    expect(aPath).toBe(bPath);
  });

  it('parses fresh JSONL fixture (raw text fallback when text is not JSON)', () => {
    // The legacy fixture's agent_message.text is the bare word "pong" — not
    // valid JSON. The parser should fall through and return the raw text so
    // older / non-schema codex output keeps working (graceful degradation).
    const reply = codexSpec.parseOutput(fresh, '');
    expect(reply.text.toLowerCase()).toContain('pong');
    expect(reply.sessionId).toMatch(/.+/);
  });

  it('extracts message field when agent_message.text is schema-constrained JSON', () => {
    // With --output-schema enforced, codex constrains the model to emit a
    // JSON document. The agent_message.text becomes the JSON-stringified
    // form; the parser must pull out the `message` field.
    const stream = [
      JSON.stringify({ type: 'thread.started', thread_id: 's1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: '{"message":"pong"}' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    const reply = codexSpec.parseOutput(stream, '');
    expect(reply.text).toBe('pong');
    expect(reply.sessionId).toBe('s1');
  });

  it('falls back to raw text when JSON in agent_message.text lacks required message field', () => {
    // Defensive: if the JSON parses but doesn't match the schema shape,
    // return the raw text so a human can still read it. Don't crash.
    const stream = [
      JSON.stringify({ type: 'thread.started', thread_id: 's1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: '{"unrelated":"value"}' },
      }),
    ].join('\n');
    const reply = codexSpec.parseOutput(stream, '');
    expect(reply.text).toBe('{"unrelated":"value"}');
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
