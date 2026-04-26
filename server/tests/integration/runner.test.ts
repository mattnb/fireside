// server/tests/integration/runner.test.ts
//
// Integration smoke test that wires together registry → runner → spec
// using the echo adapter. The echo adapter spawns `node -e "..."` to
// emit a synthetic reply, so this exercises the real runSubprocess path
// without depending on any external CLI (Claude/Codex/Gemini). Phase 8
// owns the real-CLI smoke test.
import { describe, it, expect } from 'vitest';
import { runAgentTurn } from '../../src/agents/runner.js';
import { getAgentSpec, listAgentSpecs } from '../../src/agents/registry.js';

describe('runAgentTurn (echo adapter)', () => {
  it('runs the echo agent end-to-end and returns the synthetic reply', async () => {
    const spec = getAgentSpec('echo');
    const reply = await runAgentTurn({ spec, prompt: 'hello', sessionId: null });
    expect(reply.text).toBe('echo: hello');
    expect(reply.sessionId).toBe('echo-static');
    expect(reply.raw.stdout).toContain('echo: hello');
  });

  it('exposes claude, codex, gemini, and echo via the registry', () => {
    const ids = listAgentSpecs()
      .map((s) => s.id)
      .sort();
    expect(ids).toEqual(['claude', 'codex', 'echo', 'gemini']);
  });
});
