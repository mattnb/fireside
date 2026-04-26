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
  constructor(public command: string, public timeoutMs: number) {
    super(`subprocess timed out after ${timeoutMs}ms: ${command}`);
    this.name = 'SubprocessTimeoutError';
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
    // shell:true is required on Windows so cmd.exe resolves `claude.cmd`/`codex.cmd`/`gemini.cmd`
    // via PATHEXT. But path-qualified commands (e.g. process.execPath) must bypass the shell
    // because cmd.exe word-splits unquoted paths-with-spaces like `C:\Program Files\nodejs\node.exe`.
    shell: shouldUseShell(opts.command),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    reject: false,
    // execa strips trailing newlines by default. We want byte-faithful capture
    // (callers may parse line-delimited or trailing-newline-sensitive output),
    // and our own normalizeLineEndings handles CRLF→LF.
    stripFinalNewline: false,
    // execa's own timeout uses SIGTERM which is unreliable on Windows for .cmd
    // shims. We manage our own timer + tree-kill.
  });

  // Write stdin and close it (EOF).
  if (child.stdin) {
    if (opts.stdin && opts.stdin.length > 0) child.stdin.write(opts.stdin, 'utf8');
    child.stdin.end();
  }

  let timedOut = false;
  const timer = setTimeout(async () => {
    timedOut = true;
    if (child.pid) {
      try {
        await killTree(child.pid, 'SIGKILL');
      } catch {
        // best effort
      }
    }
  }, timeoutMs);

  let result;
  try {
    result = await child;
  } catch (err) {
    result = err as ExecaError;
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    throw new SubprocessTimeoutError(opts.command, timeoutMs);
  }

  return {
    stdout: normalizeLineEndings(typeof result.stdout === 'string' ? result.stdout : ''),
    stderr: normalizeLineEndings(typeof result.stderr === 'string' ? result.stderr : ''),
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    timedOut: false,
  };
}
