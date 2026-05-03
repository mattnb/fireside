// server/src/agents/runner.ts
import { runSubprocess } from '../windows/spawn.js';
import type {
  AgentReply,
  AgentRunContext,
  AgentSpec,
  AgentStreamEvent,
  AgentStreamName,
} from './types.js';

export interface RunAgentOptions {
  spec: AgentSpec;
  prompt: string;
  sessionId: string | null;
  timeoutMs?: number | null;
  cwd?: string;
  permission?: AgentRunContext['permission'];
  cancelSignal?: AbortSignal;
  onStreamEvent?: (event: AgentStreamEvent) => void;
}

function emitStreamEvents(
  spec: AgentSpec,
  line: string,
  stream: AgentStreamName,
  sessionId: string | null,
  callback: ((event: AgentStreamEvent) => void) | undefined,
  suppressStderrFallback = false,
): void {
  if (!callback) return;
  let events: AgentStreamEvent[] = [];
  try {
    events = spec.parseStreamLine?.(line, stream, sessionId) ?? [];
  } catch {
    events = [];
  }
  if (events.length === 0 && stream === 'stderr' && line.trim() && !suppressStderrFallback) {
    events = [
      {
        kind: 'stderr',
        status: 'failed',
        label: 'stderr',
        detail: line.trim(),
      },
    ];
  }
  for (const event of events) {
    try {
      callback(event);
    } catch {
      // Streaming observers must not affect the provider turn.
    }
  }
}

export async function runAgentTurn(opts: RunAgentOptions): Promise<AgentReply> {
  const { spec, prompt, sessionId } = opts;
  const context: AgentRunContext | undefined = opts.permission
    ? { permission: opts.permission }
    : undefined;
  const args = context
    ? spec.buildArgs(prompt, sessionId, context)
    : spec.buildArgs(prompt, sessionId);
  const stdin = context
    ? spec.buildStdin?.(prompt, sessionId, context)
    : spec.buildStdin?.(prompt, sessionId);
  const env = context
    ? spec.buildEnv?.(prompt, sessionId, context)
    : spec.buildEnv?.(prompt, sessionId);
  // Caller-supplied cwd wins; otherwise let the adapter create a per-turn cwd;
  // otherwise use the adapter's static defaultCwd if set.
  const builtCwd =
    opts.cwd === undefined
      ? context
        ? spec.buildCwd?.(prompt, sessionId, context)
        : spec.buildCwd?.(prompt, sessionId)
      : undefined;
  const effectiveCwd = opts.cwd ?? builtCwd ?? spec.defaultCwd;
  const suppressStderrFallback =
    spec.id === 'claude' &&
    (env?.ANTHROPIC_LOG === 'debug' || process.env.ANTHROPIC_LOG === 'debug');
  const result = await runSubprocess({
    command: spec.command,
    args,
    stdin: stdin ?? '',
    timeoutMs: opts.timeoutMs === undefined ? spec.defaultTimeoutMs : opts.timeoutMs,
    ...(opts.cancelSignal !== undefined ? { cancelSignal: opts.cancelSignal } : {}),
    ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
    ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}),
    ...(opts.onStreamEvent !== undefined
      ? {
          onStdoutLine: (line: string) =>
            emitStreamEvents(spec, line, 'stdout', sessionId, opts.onStreamEvent),
          onStderrLine: (line: string) =>
            emitStreamEvents(
              spec,
              line,
              'stderr',
              sessionId,
              opts.onStreamEvent,
              suppressStderrFallback,
            ),
        }
      : {}),
  });
  // We deliberately don't bail on non-zero exit codes here. Some CLIs exit
  // non-zero on benign warnings while still emitting parseable output on
  // stdout; the parser is the right place to decide whether the payload is
  // usable. If the parser cannot find what it needs it will throw
  // AgentParseError carrying both stdout and stderr for diagnosis.
  return spec.parseOutput(result.stdout, result.stderr);
}
