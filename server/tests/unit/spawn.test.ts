// server/tests/unit/spawn.test.ts
import { describe, it, expect } from 'vitest';
import { runSubprocess, SubprocessTimeoutError } from '../../src/windows/spawn.js';
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
      args: ['-e', 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write("got:"+b))'],
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
});
