#!/usr/bin/env node
// Usage: node scripts/debug-agent.cjs <claude|codex|gemini> "<message text>"
//
// Runs one turn against the real CLI using the broker's exact prompt and
// prints raw stdout/stderr/exitCode/parse-result for diagnosis. This script
// invokes the CLI through the same adapter contract as the broker (registry,
// buildArgs/buildStdin/buildCwd/defaultCwd + runSubprocess) so the captured
// output reflects what the broker would see in production. Intended for use AFTER `npm run build` so the
// `dist/server/src/...` ESM entrypoints exist.

(async () => {
  const [agentId, message] = process.argv.slice(2);
  if (!agentId || !message) {
    console.error('Usage: node scripts/debug-agent.cjs <agent> "<message>"');
    process.exit(2);
  }

  const { runSubprocess } = await import('../dist/server/src/windows/spawn.js');
  const { getAgentSpec } = await import('../dist/server/src/agents/registry.js');
  const { buildTurnPrompt } = await import('../dist/server/src/transcript.js');

  const spec = getAgentSpec(agentId);
  const prompt = buildTurnPrompt({
    agentId,
    roomName: 'debug',
    history: [],
    newMessage: { authorId: 'human', authorKind: 'human', text: message },
  });

  console.log('=== PROMPT (broker prompt) ===');
  console.log(prompt);
  console.log('=== ARGS ===');
  const args = spec.buildArgs(prompt, null);
  console.log(JSON.stringify(args, null, 2));
  const stdin = spec.buildStdin ? spec.buildStdin(prompt, null) : '';
  if (stdin) {
    console.log('=== STDIN ===');
    console.log(stdin);
  }
  const cwd = spec.buildCwd ? spec.buildCwd(prompt, null) : spec.defaultCwd;
  if (cwd) {
    console.log('=== CWD ===');
    console.log(cwd);
  }
  console.log('=== RUNNING ===');
  const t0 = Date.now();
  let result;
  try {
    result = await runSubprocess({
      command: spec.command,
      args,
      stdin,
      timeoutMs: spec.defaultTimeoutMs,
      ...(cwd !== undefined ? { cwd } : {}),
    });
  } catch (err) {
    const elapsed = Date.now() - t0;
    console.log(`elapsed: ${elapsed}ms`);
    console.log(`runSubprocess threw: ${err && err.name}: ${err && err.message}`);
    if (err && err.stdout !== undefined) {
      console.log('--- err.stdout ---');
      console.log(err.stdout);
    }
    if (err && err.stderr !== undefined) {
      console.log('--- err.stderr ---');
      console.log(err.stderr);
    }
    process.exit(1);
  }
  const elapsed = Date.now() - t0;
  console.log(
    `elapsed: ${elapsed}ms  exitCode: ${result.exitCode}  timedOut: ${result.timedOut}`,
  );
  console.log('=== RAW STDOUT ===');
  console.log(result.stdout);
  console.log('=== RAW STDERR ===');
  console.log(result.stderr);
  console.log('=== PARSE ATTEMPT ===');
  try {
    const reply = spec.parseOutput(result.stdout, result.stderr);
    console.log('parse OK:');
    console.log('  text     :', JSON.stringify(reply.text));
    console.log('  sessionId:', reply.sessionId);
  } catch (err) {
    console.log('parse FAILED:', err && err.message);
  }
})().catch((err) => {
  console.error('crashed:', err);
  process.exit(1);
});
