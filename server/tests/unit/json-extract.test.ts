// server/tests/unit/json-extract.test.ts
import { describe, it, expect } from 'vitest';
import { extractTopLevelJsonObject } from '../../src/agents/json-extract.js';

describe('extractTopLevelJsonObject', () => {
  it('parses a plain JSON object string', () => {
    const out = extractTopLevelJsonObject('{"a":1,"b":"two"}');
    expect(out).toEqual({ a: 1, b: 'two' });
  });

  it('parses JSON when preceded by preamble text', () => {
    const stdout = 'Greetings, sire.\n{"result":"pong","session_id":"abc"}';
    const out = extractTopLevelJsonObject(stdout);
    expect(out).toEqual({ result: 'pong', session_id: 'abc' });
  });

  it('parses JSON when followed by postamble text', () => {
    const stdout = '{"result":"pong","session_id":"abc"}\nthanks for chatting!';
    const out = extractTopLevelJsonObject(stdout);
    expect(out).toEqual({ result: 'pong', session_id: 'abc' });
  });

  it('parses JSON sandwiched between preamble and postamble', () => {
    const stdout = 'hello\n{"result":"pong"}\nbye';
    const out = extractTopLevelJsonObject(stdout);
    expect(out).toEqual({ result: 'pong' });
  });

  it('returns the LAST top-level JSON object when multiple are present', () => {
    const stdout = '{"first":true}\n{"first":false,"second":"latest"}';
    const out = extractTopLevelJsonObject(stdout);
    expect(out).toEqual({ first: false, second: 'latest' });
  });

  it('does not let a literal "{" or "}" inside a string mislead the depth counter', () => {
    const stdout = 'preamble\n{"text":"this has } and { in it","ok":true}';
    const out = extractTopLevelJsonObject(stdout);
    expect(out).toEqual({ text: 'this has } and { in it', ok: true });
  });

  it('handles escaped quotes inside strings', () => {
    const stdout = '{"text":"she said \\"hi\\" then left","ok":1}';
    const out = extractTopLevelJsonObject(stdout);
    expect(out).toEqual({ text: 'she said "hi" then left', ok: 1 });
  });

  it('returns null on empty or garbage input', () => {
    expect(extractTopLevelJsonObject('')).toBeNull();
    expect(extractTopLevelJsonObject('   ')).toBeNull();
    expect(extractTopLevelJsonObject('not json at all')).toBeNull();
  });

  it('returns null on truncated JSON (missing closing brace)', () => {
    expect(extractTopLevelJsonObject('{"a":1')).toBeNull();
    expect(extractTopLevelJsonObject('preamble\n{"a":1,"b":[1,2')).toBeNull();
  });

  it('handles nested objects and arrays', () => {
    const stdout = 'pre\n{"outer":{"inner":[1,2,{"deep":"x"}]},"id":42}';
    const out = extractTopLevelJsonObject(stdout);
    expect(out).toEqual({ outer: { inner: [1, 2, { deep: 'x' }] }, id: 42 });
  });
});
