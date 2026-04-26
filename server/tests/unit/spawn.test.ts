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
    'preserves non-ASCII characters through the shell path',
    async () => {
      // `cmd` is a bare command name -> resolved via shouldUseShell -> uses the chcp 65001 prefix.
      const result = await runSubprocess({
        command: 'cmd',
        args: ['/c', 'echo', '日本語'],
        timeoutMs: 5000,
      });
      expect(result.stdout).toContain('日本語');
    },
  );
});

describe('shouldUseShell', () => {
  it.skipIf(process.platform !== 'win32')(
    'returns true for bare command names on Windows',
    () => {
      expect(shouldUseShell('claude')).toBe(true);
      expect(shouldUseShell('codex')).toBe(true);
    },
  );
  it.skipIf(process.platform !== 'win32')(
    'returns false for absolute paths on Windows',
    () => {
      expect(shouldUseShell('C:\\Program Files\\nodejs\\node.exe')).toBe(false);
      expect(shouldUseShell('/usr/local/bin/node')).toBe(false);
    },
  );
  it.skipIf(process.platform !== 'win32')(
    'returns false for path-qualified commands',
    () => {
      expect(shouldUseShell('./bin/foo')).toBe(false);
      expect(shouldUseShell('subdir\\foo.exe')).toBe(false);
    },
  );
  it.skipIf(process.platform === 'win32')('always returns false on non-Windows', () => {
    expect(shouldUseShell('claude')).toBe(false);
    expect(shouldUseShell('/usr/bin/node')).toBe(false);
  });
});
