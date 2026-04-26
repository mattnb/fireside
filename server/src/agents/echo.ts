// server/src/agents/echo.ts
import type { AgentSpec } from './types.js';

// The echo adapter is the test-only stand-in for a real CLI. It spawns
// `node -e "process.stdout.write(...)"` so we exercise the actual
// runSubprocess code path (PATHEXT shimming, UTF-8, stdio piping) without
// depending on Claude / Codex / Gemini being installed.
export const echoSpec: AgentSpec = {
  id: 'echo',
  displayName: 'Echo Bot',
  command: 'node',
  defaultTimeoutMs: 5_000,
  buildArgs(prompt) {
    return ['-e', `process.stdout.write(${JSON.stringify('echo: ' + prompt)})`];
  },
  parseOutput(stdout, stderr) {
    return { text: stdout, sessionId: 'echo-static', raw: { stdout, stderr } };
  },
};
