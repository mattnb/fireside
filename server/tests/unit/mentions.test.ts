// server/tests/unit/mentions.test.ts
import { describe, it, expect } from 'vitest';
import { parseMentions } from '../../src/mentions.js';

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
