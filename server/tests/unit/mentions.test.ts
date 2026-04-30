// server/tests/unit/mentions.test.ts
import { describe, it, expect } from 'vitest';
import { parseAgentReferences, parseMentions } from '../../src/mentions.js';

describe('parseMentions', () => {
  it('returns empty when no @mentions present', () => {
    expect(parseMentions('hello everyone')).toEqual([]);
  });

  it('parses a single mention', () => {
    expect(parseMentions('hey @claude what do you think?')).toEqual(['claude']);
  });

  it('parses multiple distinct mentions', () => {
    expect(parseMentions('@claude @codex thoughts?')).toEqual(['claude', 'codex']);
  });

  it('deduplicates repeated mentions', () => {
    expect(parseMentions('@claude @claude')).toEqual(['claude']);
  });

  it('only recognizes known agent ids', () => {
    expect(parseMentions('@bogus @claude')).toEqual(['claude']);
  });

  it('ignores email-like @ tokens', () => {
    expect(parseMentions('email me at user@claude.com')).toEqual([]);
  });
});

describe('parseAgentReferences', () => {
  it('keeps @mention behavior', () => {
    expect(parseAgentReferences('hey @claude what do you think?')).toEqual(['claude']);
  });

  it('detects bare handoffs at sentence starts', () => {
    expect(parseAgentReferences('Codex, please verify the change.')).toEqual(['codex']);
    expect(parseAgentReferences('Claude: next step is yours.')).toEqual(['claude']);
  });

  it('detects markdown-styled agent labels', () => {
    expect(parseAgentReferences('**Codex:** verify the review-scope failure.')).toEqual([
      'codex',
    ]);
    expect(parseAgentReferences('__Gemini__, sanity check this.')).toEqual(['gemini']);
  });

  it('detects action phrasing without punctuation', () => {
    expect(parseAgentReferences('I think Claude should continue the UI slice.')).toEqual([
      'claude',
    ]);
  });

  it('detects handoff phrases in prose', () => {
    expect(parseAgentReferences('I am blocked here, handoff to Gemini for review.')).toEqual([
      'gemini',
    ]);
  });

  it('ignores bare labels without a handoff body', () => {
    expect(parseAgentReferences('Claude:')).toEqual([]);
    expect(parseAgentReferences('**Codex:**')).toEqual([]);
  });

  it('does not treat product names or code spans as handoffs', () => {
    expect(parseAgentReferences('Claude Code and Codex CLI are installed.')).toEqual([]);
    expect(parseAgentReferences('run `codex --help` before changing this')).toEqual([]);
  });
});
