// server/tests/unit/encoding.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeLineEndings, stripBom, ensureTrailingNewline } from '../../src/windows/encoding.js';

describe('encoding helpers', () => {
  it('normalizes CRLF to LF', () => {
    expect(normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  it('preserves bare LF unchanged', () => {
    expect(normalizeLineEndings('a\nb\nc')).toBe('a\nb\nc');
  });

  it('handles bare CR (old mac line endings)', () => {
    expect(normalizeLineEndings('a\rb\rc')).toBe('a\nb\nc');
  });

  it('strips a UTF-8 BOM', () => {
    expect(stripBom('﻿hello')).toBe('hello');
  });

  it('leaves text without BOM unchanged', () => {
    expect(stripBom('hello')).toBe('hello');
  });

  it('adds a trailing newline if missing', () => {
    expect(ensureTrailingNewline('hello')).toBe('hello\n');
  });

  it('does not add a duplicate trailing newline', () => {
    expect(ensureTrailingNewline('hello\n')).toBe('hello\n');
  });
});
