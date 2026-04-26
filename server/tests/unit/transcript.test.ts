// server/tests/unit/transcript.test.ts
import { describe, it, expect } from 'vitest';
import { buildTurnPrompt } from '../../src/transcript.js';

describe('buildTurnPrompt', () => {
  it('formats empty history with just the new message', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'matt', authorKind: 'human', text: 'hi' },
    });
    expect(prompt).toContain('You are participating');
    expect(prompt).toContain('claude');
    expect(prompt).toContain('matt: hi');
    expect(prompt).toContain('your reply');
  });

  it('includes recent history in chronological order', () => {
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
  });

  it('does not echo the agent\'s own previous messages with a special prefix that would confuse it', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [{ authorId: 'claude', authorKind: 'agent', text: 'hi' }],
      newMessage: { authorId: 'matt', authorKind: 'human', text: 'whats up' },
    });
    // History should mark agent's own messages with "(you)" so the agent sees its own contributions.
    expect(prompt).toContain('claude (you)');
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
