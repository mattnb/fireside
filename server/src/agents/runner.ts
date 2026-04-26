// server/src/agents/runner.ts
import { runSubprocess } from '../windows/spawn.js';
import type { AgentReply, AgentSpec } from './types.js';

export interface RunAgentOptions {
  spec: AgentSpec;
  prompt: string;
  sessionId: string | null;
  timeoutMs?: number;
  cwd?: string;
}

export async function runAgentTurn(opts: RunAgentOptions): Promise<AgentReply> {
  const { spec, prompt, sessionId } = opts;
  const args = spec.buildArgs(prompt, sessionId);
  const stdin = spec.buildStdin?.(prompt, sessionId);
  // Caller-supplied cwd wins; otherwise use the agent's defaultCwd if set
  // (e.g. gemini's neutral tmpdir to suppress its project auto-detection);
  // otherwise inherit the parent process cwd by omitting the field.
  const effectiveCwd = opts.cwd ?? spec.defaultCwd;
  const result = await runSubprocess({
    command: spec.command,
    args,
    stdin: stdin ?? '',
    timeoutMs: opts.timeoutMs ?? spec.defaultTimeoutMs,
    ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
  });
  // We deliberately don't bail on non-zero exit codes here. Some CLIs exit
  // non-zero on benign warnings while still emitting parseable output on
  // stdout; the parser is the right place to decide whether the payload is
  // usable. If the parser cannot find what it needs it will throw
  // AgentParseError carrying both stdout and stderr for diagnosis.
  return spec.parseOutput(result.stdout, result.stderr);
}
