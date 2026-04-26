// server/tests/unit/transcript.test.ts
import { describe, it, expect } from 'vitest';
import { buildTurnPrompt } from '../../src/transcript.js';

describe('buildTurnPrompt', () => {
  it('formats empty history with the new message as the last transcript line', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'matt', authorKind: 'human', text: 'hi' },
    });
    expect(prompt).toContain('produce only the next message');
    expect(prompt).toContain('claude');
    expect(prompt).toContain('Transcript:');
    expect(prompt).toContain('matt: hi');
    // With empty history, the transcript section is just the new message line.
    // The prompt must end with that line, not a turn cue.
    expect(prompt.endsWith('matt: hi')).toBe(true);
  });

  it('includes recent history in chronological order followed by the new message', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [
        { authorId: 'matt', authorKind: 'human', text: 'first' },
        { authorId: 'codex', authorKind: 'agent', text: 'second' },
      ],
      newMessage: { authorId: 'gemini', authorKind: 'agent', text: 'third' },
    });
    expect(prompt.indexOf('first')).toBeLessThan(prompt.indexOf('second'));
    expect(prompt.indexOf('second')).toBeLessThan(prompt.indexOf('third'));
    // Transcript ends with the new (latest) message — no trailing turn cue.
    expect(prompt.endsWith('gemini: third')).toBe(true);
  });

  it('marks the agent\'s own previous messages with "(you)"', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [{ authorId: 'claude', authorKind: 'agent', text: 'hi' }],
      newMessage: { authorId: 'matt', authorKind: 'human', text: 'whats up' },
    });
    expect(prompt).toContain('claude (you)');
  });

  it('does not tell the model to avoid JSON (CLI handles JSON wrapping)', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'matt', authorKind: 'human', text: 'hi' },
    });
    expect(prompt.toLowerCase()).not.toContain('no json');
    expect(prompt.toLowerCase()).not.toContain("don't use json");
    expect(prompt.toLowerCase()).not.toContain('avoid json');
  });

  it('truncates history beyond the configured cap', () => {
    const history = Array.from({ length: 200 }, (_, i) => ({
      authorId: 'matt',
      authorKind: 'human' as const,
      text: `message ${i}`,
    }));
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history,
      newMessage: { authorId: 'matt', authorKind: 'human', text: 'final' },
      maxHistory: 50,
    });
    expect(prompt).not.toContain('message 0');
    expect(prompt).toContain('message 199');
    expect(prompt).toContain('final');
  });

  it('forbids common acknowledgement-style preambles', () => {
    const prompt = buildTurnPrompt({
      agentId: 'codex',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'matt', authorKind: 'human', text: 'hi' },
    });
    // Guards against re-introducing roleplay framing
    expect(prompt.toLowerCase()).not.toContain('you are');
    // Explicit forbidden-preamble examples should appear in the instructions
    expect(prompt).toContain('Understood');
  });
});
