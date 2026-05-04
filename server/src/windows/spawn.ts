// server/src/windows/spawn.ts
import { execa, type ExecaError } from 'execa';
import { isPidAlive, killTree } from './tree-kill.js';
import { normalizeLineEndings, stripBom } from './encoding.js';

// Time we give a subprocess to react to a SIGINT before escalating to
// SIGKILL on POSIX platforms. Long enough for a provider CLI to flush
// partial output, short enough that a stuck process doesn't make the user
// wait. Windows skips this phase entirely — tree-kill maps every signal to
// `taskkill /T /F` so there's no graceful equivalent.
const GRACEFUL_CANCEL_KILL_DELAY_MS = 150;

/**
 * We never need `shell: true`. `execa` (via `cross-spawn`) already handles the
 * two Windows-specific concerns that originally motivated `shell: true`:
 *   1. PATHEXT resolution — bare names like `claude` resolve to `claude.cmd`
 *      automatically without involving cmd.exe.
 *   2. `.cmd` shim argument escaping — multi-line argv strings (e.g. broker
 *      prompts containing newlines) pass through untouched.
 *
 * Going through cmd.exe required us to manually concatenate one command line,
 * which cmd.exe terminates at the first embedded newline — that silently
 * truncated multi-line prompts and caused Phase 8 real-CLI test failures.
 *
 * Kept as a function (rather than inlining `false` at the call site) so tests
 * can document the always-false invariant.
 */
export function shouldUseShell(_command: string): boolean {
  return false;
}

export class SubprocessTimeoutError extends Error {
  constructor(
    public command: string,
    public timeoutMs: number,
    public stdout: string = '',
    public stderr: string = '',
  ) {
    super(`subprocess timed out after ${timeoutMs}ms: ${command}`);
    this.name = 'SubprocessTimeoutError';
  }
}

export class SubprocessSpawnError extends Error {
  constructor(
    public command: string,
    public override cause: unknown,
  ) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`failed to spawn subprocess: ${command} — ${causeMsg}`);
    this.name = 'SubprocessSpawnError';
  }
}

export class SubprocessCanceledError extends Error {
  constructor(
    public command: string,
    public stdout: string = '',
    public stderr: string = '',
  ) {
    super(`subprocess canceled: ${command}`);
    this.name = 'SubprocessCanceledError';
  }
}

export interface RunOptions {
  command: string;
  args?: string[];
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number | null;
  cancelSignal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT = 120_000;

function safeEmitLine(callback: ((line: string) => void) | undefined, line: string): void {
  if (!callback) return;
  try {
    callback(line);
  } catch {
    // Streaming observers must never affect the subprocess lifecycle.
  }
}

function safeEmitChunk(callback: ((chunk: string) => void) | undefined, chunk: string): void {
  if (!callback) return;
  try {
    callback(chunk);
  } catch {
    // Streaming observers must never affect the subprocess lifecycle.
  }
}

function attachLineObserver(
  stream: NodeJS.ReadableStream | null,
  onLine: ((line: string) => void) | undefined,
  onChunk: ((chunk: string) => void) | undefined,
): () => void {
  if (!stream || (!onLine && !onChunk)) return () => {};

  let buffer = '';
  let firstChunk = true;
  const onData = (chunk: Buffer | string): void => {
    let text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (firstChunk) {
      text = stripBom(text);
      firstChunk = false;
    }
    text = normalizeLineEndings(text);
    safeEmitChunk(onChunk, text);
    if (!onLine) return;

    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      safeEmitLine(onLine, line);
    }
  };

  stream.on('data', onData);
  return () => {
    stream.off('data', onData);
    if (buffer.length > 0) {
      safeEmitLine(onLine, buffer);
      buffer = '';
    }
  };
}

/**
 * True if the error from execa indicates the child process never started
 * (ENOENT, EACCES, invalid cwd, etc.). A real run that exited non-zero still
 * populates `exitCode` with a number; a spawn failure leaves `exitCode`
 * undefined and surfaces the underlying syscall failure on `code` (or on
 * `cause.code`). On Windows, execa's auto-cmd.exe wrapping can mask "command
 * not recognized" as a real exit-1 with stderr — those are NOT spawn failures,
 * they are actual cmd.exe runs that returned an error code.
 */
function isSpawnFailure(err: ExecaError): boolean {
  if (typeof err.exitCode === 'number') return false;
  const errCode = (err as ExecaError & { code?: unknown }).code;
  if (typeof errCode === 'string') return true;
  const cause = (err as ExecaError & { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause.code === 'string') return true;
  return (
    err.exitCode === undefined &&
    (err.stdout === undefined || err.stdout === '') &&
    (err.stderr === undefined || err.stderr === '')
  );
}

export async function runSubprocess(opts: RunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs === null ? null : (opts.timeoutMs ?? DEFAULT_TIMEOUT);
  // PYTHONIOENCODING helps any Python tool that ends up in the chain. We
  // deliberately do NOT set LANG/LC_ALL — those are POSIX locale knobs that
  // Windows ignores. UTF-8 of child stdout is handled by execa's
  // `encoding: 'utf8'` decode of the raw byte buffer, so no console-codepage
  // dance (`chcp 65001`) is required when we bypass cmd.exe entirely.
  const env = {
    PYTHONIOENCODING: 'utf-8',
    ...process.env,
    ...opts.env,
  };

  const actualCommand = opts.command;
  const actualArgs: string[] = opts.args ?? [];

  // Only open a stdin pipe when there is actually content to write. Opening a
  // pipe and immediately calling .end() still presents the child with a real
  // (but empty) stdin handle, and some CLIs interpret that as "input is being
  // streamed in" and append it to whatever was passed via argv. Codex in
  // particular logs `Reading additional input from stdin...` to stderr and
  // appends a `<stdin>` block AFTER the argv prompt, which mangles the turn
  // cue. With `stdio: 'ignore'` the child sees stdin as closed/unreadable from
  // the start and skips that path entirely.
  const hasStdin = typeof opts.stdin === 'string' && opts.stdin.length > 0;

  const child = execa(actualCommand, actualArgs, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env,
    encoding: 'utf8',
    windowsHide: true,
    // shell: false is critical on Windows. With shell: true, execa concatenates
    // a single command line and hands it to cmd.exe — cmd.exe terminates that
    // line at the first embedded newline, silently truncating multi-line argv
    // (e.g. broker prompts). cross-spawn (used internally by execa) handles
    // PATHEXT resolution and .cmd shim argument escaping with shell: false.
    shell: false,
    stdin: hasStdin ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    reject: false,
    stripFinalNewline: false,
  });

  // Write stdin and close it (EOF). Only when we actually have content —
  // otherwise stdin is 'ignore' and child.stdin is null.
  if (hasStdin && child.stdin) {
    child.stdin.write(opts.stdin as string, 'utf8');
    child.stdin.end();
  }

  const flushStdoutObserver = attachLineObserver(
    child.stdout,
    opts.onStdoutLine,
    opts.onStdoutChunk,
  );
  const flushStderrObserver = attachLineObserver(
    child.stderr,
    opts.onStderrLine,
    opts.onStderrChunk,
  );

  let completed = false;
  let timedOut = false;
  let canceled = false;
  const timer =
    timeoutMs === null
      ? null
      : setTimeout(async () => {
          // Race guard: if the child already finished and we're just waiting on the
          // event loop to clear the timer, don't flip timedOut and don't kill.
          if (completed) return;
          timedOut = true;
          if (child.pid) {
            try {
              await killTree(child.pid, 'SIGKILL');
            } catch {
              // best effort
            }
          }
        }, timeoutMs);
  const cancelListener = async (): Promise<void> => {
    if (completed) return;
    canceled = true;
    if (!child.pid) return;
    if (process.platform !== 'win32') {
      // Graceful phase: SIGINT lets the provider CLI flush partial output
      // and release resources before we hard-kill. If the process exits
      // cleanly within the grace window we never need to escalate.
      try {
        await killTree(child.pid, 'SIGINT');
      } catch {
        // best effort
      }
      await new Promise((resolve) => setTimeout(resolve, GRACEFUL_CANCEL_KILL_DELAY_MS));
      if (completed) return;
      if (!(await isPidAlive(child.pid))) return;
    }
    try {
      await killTree(child.pid, 'SIGKILL');
    } catch {
      // best effort
    }
  };
  if (opts.cancelSignal) {
    if (opts.cancelSignal.aborted) {
      void cancelListener();
    } else {
      opts.cancelSignal.addEventListener('abort', cancelListener, { once: true });
    }
  }

  let result: ExecaError | Awaited<typeof child> | undefined;
  try {
    result = await child;
  } catch (err) {
    result = err as ExecaError;
  }
  completed = true;
  flushStdoutObserver();
  flushStderrObserver();
  if (timer !== null) clearTimeout(timer);
  opts.cancelSignal?.removeEventListener('abort', cancelListener);

  // C1: distinguish a real run-with-non-zero-exit from a complete failure to
  // launch the binary (ENOENT etc). The latter must surface as a
  // SubprocessSpawnError so callers don't mistake "never ran" for "ran cleanly
  // with no output". Don't classify timeouts as spawn errors.
  if (result instanceof Error && isSpawnFailure(result as ExecaError) && !timedOut) {
    throw new SubprocessSpawnError(opts.command, result);
  }

  // Pre-compute normalized stdout/stderr (BOM strip, then CRLF → LF) so the
  // timeout error can carry whatever we managed to capture before the child
  // was killed.
  const stdout = normalizeLineEndings(
    stripBom(result && typeof result.stdout === 'string' ? result.stdout : ''),
  );
  const stderr = normalizeLineEndings(
    stripBom(result && typeof result.stderr === 'string' ? result.stderr : ''),
  );

  if (timedOut) {
    throw new SubprocessTimeoutError(opts.command, timeoutMs ?? DEFAULT_TIMEOUT, stdout, stderr);
  }

  if (canceled) {
    throw new SubprocessCanceledError(opts.command, stdout, stderr);
  }

  return {
    stdout,
    stderr,
    exitCode: result && typeof result.exitCode === 'number' ? result.exitCode : null,
    timedOut: false,
  };
}
