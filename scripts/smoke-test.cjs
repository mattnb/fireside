#!/usr/bin/env node
// Calls each real CLI through the runner once. Run AFTER `verify-clis` and AFTER fixtures are captured.
(async () => {
  const { runAgentTurn } = await import('../dist/server/src/agents/runner.js');
  const { getAgentSpec } = await import('../dist/server/src/agents/registry.js');

  const cases = [
    { id: 'claude', prompt: 'reply with exactly: pong' },
    { id: 'codex',  prompt: 'reply with exactly: pong' },
    { id: 'gemini', prompt: 'reply with exactly: pong' },
  ];
  for (const c of cases) {
    process.stdout.write(`[${c.id}] running... `);
    try {
      const reply = await runAgentTurn({ spec: getAgentSpec(c.id), prompt: c.prompt, sessionId: null });
      const ok = reply.text.toLowerCase().includes('pong');
      console.log(ok ? `OK (sessionId=${reply.sessionId})` : `WRONG: ${JSON.stringify(reply.text).slice(0,100)}`);
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
    }
  }
})().catch((err) => {
  console.error('smoke-test crashed:', err);
  process.exit(1);
});
