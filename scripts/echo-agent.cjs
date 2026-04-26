#!/usr/bin/env node
// echo-agent.cjs — reads JSON {prompt, sessionId} on stdin, prints a JSON reply on stdout.
// Used as a stand-in for a real CLI in tests.
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (buf += chunk));
process.stdin.on('end', () => {
  let parsed;
  try {
    parsed = JSON.parse(buf || '{}');
  } catch {
    parsed = { prompt: buf };
  }
  const reply = {
    sessionId: parsed.sessionId || 'echo-session-1',
    text: `echo: ${parsed.prompt || '(empty)'}`,
  };
  process.stdout.write(JSON.stringify(reply));
});
