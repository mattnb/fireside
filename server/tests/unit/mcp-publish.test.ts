// Tests for the codex-output parsing helper. The full publish flow shells out
// to `codex` and `gemini` CLIs, so it's covered by manual integration. Here we
// only pin the JSON / fallback parsing paths that are pure logic.

import { describe, expect, it } from 'vitest';
import { __test__ } from '../../src/mcp-publish.js';

const { codexHasFiresideEntry, geminiListIncludesFireside } = __test__;

describe('codexHasFiresideEntry', () => {
  it('detects fireside in an array of entries with name property', () => {
    const json = JSON.stringify([
      { name: 'github', url: 'https://example' },
      { name: 'fireside', url: 'http://127.0.0.1:8787/api/mcp' },
    ]);
    expect(codexHasFiresideEntry(json)).toBe(true);
  });

  it('detects fireside in an object map keyed by name', () => {
    const json = JSON.stringify({
      github: { url: 'https://example' },
      fireside: { url: 'http://127.0.0.1:8787/api/mcp' },
    });
    expect(codexHasFiresideEntry(json)).toBe(true);
  });

  it('detects fireside under an object.servers array', () => {
    const json = JSON.stringify({
      servers: [
        { name: 'fireside', url: 'http://127.0.0.1:8787/api/mcp' },
      ],
    });
    expect(codexHasFiresideEntry(json)).toBe(true);
  });

  it('returns false for an empty list', () => {
    expect(codexHasFiresideEntry('[]')).toBe(false);
    expect(codexHasFiresideEntry('{}')).toBe(false);
  });

  it('returns false when only other servers are present', () => {
    const json = JSON.stringify([{ name: 'github' }, { name: 'sqlite' }]);
    expect(codexHasFiresideEntry(json)).toBe(false);
  });

  it('falls back to substring match when stdout is not JSON (older codex versions)', () => {
    const text = 'Configured servers:\n  - fireside (http://127.0.0.1:8787/api/mcp)\n';
    expect(codexHasFiresideEntry(text)).toBe(true);
  });

  it('substring fallback returns false when fireside is absent from plain text', () => {
    const text = 'No MCP servers configured yet.';
    expect(codexHasFiresideEntry(text)).toBe(false);
  });
});

describe('geminiListIncludesFireside', () => {
  // gemini-cli on Windows occasionally exits non-zero with a libuv assertion
  // even when the listing succeeded. We have to trust stdout content; these
  // cases pin the parser against real fixtures captured from gemini 0.41.x.

  it('detects a connected fireside entry', () => {
    const stdout = [
      'Configured MCP servers:',
      '',
      '✓ fireside: http://127.0.0.1:8787/api/mcp (http) - Connected',
      '',
    ].join('\n');
    expect(geminiListIncludesFireside(stdout)).toBe(true);
  });

  it('detects a disconnected fireside entry (so we still treat it as already-configured)', () => {
    const stdout = [
      'Configured MCP servers:',
      '',
      '✗ fireside: http://127.0.0.1:8787/api/mcp (http) - Disconnected',
      '',
    ].join('\n');
    expect(geminiListIncludesFireside(stdout)).toBe(true);
  });

  it('returns false when no MCP servers are configured', () => {
    expect(geminiListIncludesFireside('No MCP servers configured.')).toBe(false);
    expect(geminiListIncludesFireside('Configured MCP servers:\n')).toBe(false);
  });

  it('returns false when other servers are configured but fireside is absent', () => {
    const stdout = [
      'Configured MCP servers:',
      '',
      '✓ github: https://example (sse) - Connected',
      '',
    ].join('\n');
    expect(geminiListIncludesFireside(stdout)).toBe(false);
  });

  it('does not falsely match prose mentions of "fireside" without the trailing colon or space', () => {
    // Defensive: we anchor on `fireside:` or `fireside ` to avoid matching
    // free-text help output that might mention the word.
    expect(geminiListIncludesFireside('# fireside-help.md')).toBe(false);
  });
});
