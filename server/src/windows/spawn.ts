// server/src/windows/spawn.ts
import path from 'node:path';
import { execa, type ExecaError } from 'execa';
import { killTree } from './tree-kill.js';
import { normalizeLineEndings, stripBom } from './encoding.js';

/**
 * Determines whether `execa` must be invoked with `shell: true` to resolve the
 * given command. On Windows, bare command names (`claude`, `codex`, `gemini`)
 * have to go through cmd.exe so PATHEXT picks up their `.cmd` shims; absolute
 * or path-qualified commands must bypass the shell because cmd.exe word-splits
 * unquoted paths-with-spaces like `C:\Program Files\nodejs\node.exe`.
 */
export function shouldUseShell(command: string): boolean {
  if (process.platform !== 'win32') return false;
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
  // PYTHONIOENCODING is harmless on cmd.exe and helps any Python tool that
  // ends up in the chain. We deliberately do NOT set LANG/LC_ALL — those are
  // POSIX locale knobs that cmd.exe ignores; setting them here creates the
  // false impression that UTF-8 is being enforced when it isn't. Real UTF-8
  // enforcement on Windows happens via the `chcp 65001` prefix injected below
  // for shell-resolved commands.
  const env = {
    PYTHONIOENCODING: 'utf-8',
    ...process.env,
    ...opts.env,
  };

  const useShell = shouldUseShell(opts.command);
  let actualCommand = opts.command;
  let actualArgs: string[] = opts.args ?? [];
  if (useShell) {
    // When cmd.exe runs the command we prepend `chcp 65001 >NUL && ` so the
    // console code page is set to UTF-8 for the rest of the line. execa with
    // `shell: true` accepts the entire command line as a single argv[0] and
    // hands it to cmd.exe verbatim, so we collapse args into the string here
    // and pass an empty args array.
    const argString = actualArgs
      .map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
      .join(' ');
    actualCommand = `chcp 65001 >NUL && ${opts.command}${argString.length > 0 ? ' ' + argString : ''}`;
    actualArgs = [];
  }

  const child = execa(actualCommand, actualArgs, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env,
    encoding: 'utf8',
    windowsHide: true,
    shell: useShell,
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
