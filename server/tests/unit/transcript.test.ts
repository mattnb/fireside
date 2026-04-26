// server/tests/unit/transcript.test.ts
import { describe, it, expect } from 'vitest';
import { buildTurnPrompt } from '../../src/transcript.js';

describe('buildTurnPrompt', () => {
  it('formats empty history with just the new message and ends on a turn cue', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'matt', authorKind: 'human', text: 'hi' },
    });
    expect(prompt).toContain('multi-user chat room');
    expect(prompt).toContain('claude');
    expect(prompt).toContain('Reply with the text');
    expect(prompt).toContain('matt: hi');
    // The prompt must end with a `<agentId>:` turn cue so the model is
    // primed to write its line as a chat continuation, not a meta reply.
    expect(prompt.endsWith('claude:')).toBe(true);
  });

  it('includes recent history in chronological order followed by the new message and turn cue', () => {
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
    // The agent's own turn cue must come AFTER the most recent message line.
    expect(prompt.indexOf('third')).toBeLessThan(prompt.lastIndexOf('claude:'));
    expect(prompt.endsWith('claude:')).toBe(true);
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
});
