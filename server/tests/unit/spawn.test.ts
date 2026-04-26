// server/tests/unit/spawn.test.ts
import { describe, it, expect } from 'vitest';
import {
  runSubprocess,
  shouldUseShell,
  SubprocessSpawnError,
  SubprocessTimeoutError,
} from '../../src/windows/spawn.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const ECHO = path.resolve(path.dirname(__filename), '../../../scripts/echo-agent.cjs');

describe('runSubprocess', () => {
  it('runs node script with stdin and returns stdout', async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: [ECHO],
      stdin: JSON.stringify({ prompt: 'hello', sessionId: 's1' }),
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('echo: hello');
    expect(result.timedOut).toBe(false);
  });

  it('normalizes CRLF in stdout to LF', async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("a\\r\\nb\\r\\n")'],
      stdin: '',
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe('a\nb\n');
  });

  it('closes stdin so the child sees EOF', async () => {
    // `cat` would hang forever without stdin.end(); this proves we close it.
    const result = await runSubprocess({
      command: process.execPath,
      args: [
        '-e',
        'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write("got:"+b))',
      ],
      stdin: 'payload',
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe('got:payload');
  });

  it('does not open a stdin pipe when no stdin content is provided', async () => {
    // The observable difference between `stdio: 'ignore'` and `stdio: 'pipe'`
    // (with an immediate .end()) on the child side is the constructor of
    // process.stdin: 'ignore' wires fd 0 to the OS null device, which Node
    // exposes as a ReadStream; 'pipe' exposes a Socket. Codex's "Reading
    // additional input from stdin..." path triggers when the child sees a
    // pipe; with 'ignore' it never triggers because the null device returns
    // EOF synchronously and the CLI skips the stdin-append branch.
    const result = await runSubprocess({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(process.stdin.constructor.name)',
      ],
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    // 'ReadStream' on Windows + POSIX when stdin is the null device.
    expect(result.stdout).toBe('ReadStream');
  });

  it('opens a stdin pipe when stdin content is provided', async () => {
    // Counterpart to the test above — with non-empty stdin we wire a real
    // pipe. Constructor flips to Socket, and the child reads our payload back
    // out, proving the pipe is functional (not just present).
    const result = await runSubprocess({
      command: process.execPath,
      args: [
        '-e',
        'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(process.stdin.constructor.name+":"+b))',
      ],
      stdin: 'hello',
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Socket:hello');
  });

  it('throws SubprocessTimeoutError when command exceeds timeout', async () => {
    await expect(
      runSubprocess({
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{}, 1000)'],
        stdin: '',
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(SubprocessTimeoutError);
  });

  it('captures stderr separately', async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("warn"); process.stdout.write("ok")'],
      stdin: '',
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('warn');
  });

  it('throws SubprocessSpawnError when the spawn syscall fails (bad cwd)', async () => {
    // We want a true ENOENT/spawn failure — the child never starts, so
    // exitCode is undefined and stderr is empty. Pointing at a non-existent
    // cwd reliably triggers this on every platform: Node.js fails the spawn
    // before the program is even attempted. (On Windows, a bogus *binary*
    // path is wrapped by cmd.exe and surfaces as a normal exit-1 with stderr
    // — that's NOT what SubprocessSpawnError represents.)
    await expect(
      runSubprocess({
        command: process.execPath,
        args: ['-v'],
        cwd: process.platform === 'win32'
          ? 'Z:\\nonexistent-fireside-test-dir\\never-here'
          : '/nonexistent-fireside-test-dir/never-here',
        timeoutMs: 5000,
      }),
    ).rejects.toBeInstanceOf(SubprocessSpawnError);
  });

  it.skipIf(process.platform !== 'win32')(
    'preserves non-ASCII characters in argv',
    async () => {
      // With shell: false, argv passes byte-for-byte to node.exe and execa
      // decodes the child's stdout as UTF-8 — no chcp dance required.
      const result = await runSubprocess({
        command: 'node',
        args: ['-e', 'process.stdout.write("日本語")'],
        timeoutMs: 5000,
      });
      expect(result.stdout).toBe('日本語');
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'passes multi-line argv through to a bare-name command on Windows',
    async () => {
      // Use 'node' (a bare name on Windows that resolves via PATHEXT to node.exe).
      // Pass a multi-line string as a single arg; child echoes it verbatim.
      const multiLine = 'line1\nline2\nline3';
      const result = await runSubprocess({
        command: 'node',
        args: ['-e', `process.stdout.write(${JSON.stringify(multiLine)})`],
        timeoutMs: 10_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(multiLine);
    },
  );
});

describe('shouldUseShell', () => {
  it('always returns false — execa/cross-spawn handles PATHEXT and .cmd escaping', () => {
    expect(shouldUseShell('claude')).toBe(false);
    expect(shouldUseShell('codex')).toBe(false);
    expect(shouldUseShell('C:\\Program Files\\nodejs\\node.exe')).toBe(false);
    expect(shouldUseShell('/usr/local/bin/node')).toBe(false);
    expect(shouldUseShell('./bin/foo')).toBe(false);
  });
});
