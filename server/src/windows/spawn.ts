// server/src/windows/spawn.ts
import path from 'node:path';
import { execa, type ExecaError } from 'execa';
import { killTree } from './tree-kill.js';
import { normalizeLineEndings } from './encoding.js';

function shouldUseShell(command: string): boolean {
  if (process.platform !== 'win32') return false;
  // Bare command names ('claude', 'codex') need shell:true so cmd.exe resolves
  // PATHEXT to find their .cmd shims. Absolute or path-qualified commands must
  // bypass the shell — cmd.exe word-splits unquoted paths-with-spaces.
  if (path.isAbsolute(command)) return false;
  if (command.includes('/') || command.includes('\\')) return false;
  return true;
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
  const env = {
    // Force UTF-8 across whatever shells/runtimes the child uses.
    PYTHONIOENCODING: 'utf-8',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    ...process.env,
    ...opts.env,
  };
  const child = execa(opts.command, opts.args ?? [], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env,
    encoding: 'utf8',
    windowsHide: true,
    shell: shouldUseShell(opts.command),
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

  // I1: pre-compute normalized stdout/stderr so the timeout error can carry
  // whatever we managed to capture before the child was killed.
  const stdout = normalizeLineEndings(
    result && typeof result.stdout === 'string' ? result.stdout : '',
  );
  const stderr = normalizeLineEndings(
    result && typeof result.stderr === 'string' ? result.stderr : '',
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
