// server/src/windows/spawn.ts
import { execa, type ExecaError } from 'execa';
import { killTree } from './tree-kill.js';
import { normalizeLineEndings, stripBom } from './encoding.js';

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

export interface RunOptions {
  command: string;
  args?: string[];
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT = 120_000;

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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
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
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    reject: false,
    stripFinalNewline: false,
  });

  // Write stdin and close it (EOF).
  if (child.stdin) {
    if (opts.stdin && opts.stdin.length > 0) child.stdin.write(opts.stdin, 'utf8');
    child.stdin.end();
  }

  let completed = false;
  let timedOut = false;
  const timer = setTimeout(async () => {
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

  let result: ExecaError | Awaited<typeof child> | undefined;
  try {
    result = await child;
  } catch (err) {
    result = err as ExecaError;
  }
  completed = true;
  clearTimeout(timer);

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
    throw new SubprocessTimeoutError(opts.command, timeoutMs, stdout, stderr);
  }

  return {
    stdout,
    stderr,
    exitCode: result && typeof result.exitCode === 'number' ? result.exitCode : null,
    timedOut: false,
  };
}
