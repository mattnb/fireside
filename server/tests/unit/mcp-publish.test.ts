// Tests for the codex-output parsing helper. The full publish flow shells out
// to `codex` and `gemini` CLIs, so it's covered by manual integration. Here we
// only pin the JSON / fallback parsing paths that are pure logic.

import { describe, expect, it } from 'vitest';
import { __test__ } from '../../src/mcp-publish.js';

const { codexHasFiresideEntry } = __test__;

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
