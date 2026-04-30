#!/usr/bin/env node
// Calls each real CLI through the runner once. Run AFTER `verify-clis` and AFTER fixtures are captured.
//
// Two passes:
//   1. Direct prompt — exercises the CLI parsing path with a minimal prompt.
//      Proves stdout shape and parsing assumptions still hold.
//   2. Broker transcript prompt — wraps the same intent in `buildTurnPrompt`
//      (the exact prompt the broker would send). Proves the CLI behaves
//      sanely against the broker's actual prompt format, including the
//      role-cue suffix `${agentId}:` and the system preamble. Direct-prompt
//      passing while transcript-prompt failing has been observed in the
//      wild — that gap is the whole point of this second pass.
(async () => {
  const { runAgentTurn } = await import('../dist/server/src/agents/runner.js');
  const { getAgentSpec } = await import('../dist/server/src/agents/registry.js');
  const { buildTurnPrompt } = await import('../dist/server/src/transcript.js');

  const cases = [
    { id: 'claude', prompt: 'reply with exactly: pong' },
    { id: 'codex',  prompt: 'reply with exactly: pong' },
    { id: 'gemini', prompt: 'reply with exactly: pong' },
  ];

  console.log('--- Pass 1: direct prompts ---');
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

  console.log('\n--- Pass 2: broker transcript prompts ---');
  for (const c of cases) {
    process.stdout.write(`[${c.id}] (transcript) running... `);
    const transcriptPrompt = buildTurnPrompt({
      agentId: c.id,
      roomName: 'smoke',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: c.prompt },
    });
    try {
      const reply = await runAgentTurn({ spec: getAgentSpec(c.id), prompt: transcriptPrompt, sessionId: null });
      const ok = reply.text.toLowerCase().includes('pong');
      console.log(ok ? `OK (sessionId=${reply.sessionId})` : `WRONG: ${JSON.stringify(reply.text).slice(0,200)}`);
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
    }
  }
})().catch((err) => {
  console.error('smoke-test crashed:', err);
  process.exit(1);
});
