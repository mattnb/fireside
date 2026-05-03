// server/tests/unit/runner.test.ts
//
// Unit tests for runAgentTurn's cwd plumbing. Mocks runSubprocess so we can
// inspect exactly what cwd was passed without spawning anything. The
// integration coverage (broker → echo agent end-to-end) lives in
// server/tests/integration/runner.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSpec } from '../../src/agents/types.js';

const runSubprocessMock = vi.fn();

vi.mock('../../src/windows/spawn.js', () => ({
  runSubprocess: (opts: unknown) => runSubprocessMock(opts),
}));

// Imported AFTER vi.mock so the runner picks up the mocked runSubprocess.
const { runAgentTurn } = await import('../../src/agents/runner.js');

function makeSpec(partial: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: 'echo',
    displayName: 'Echo',
    command: 'fake-cmd',
    defaultTimeoutMs: 5_000,
    buildArgs: () => ['--noop'],
    parseOutput: (stdout, stderr) => ({
      text: stdout,
      sessionId: null,
      raw: { stdout, stderr },
    }),
    ...partial,
  };
}

describe('runAgentTurn — cwd resolution', () => {
  beforeEach(() => {
    runSubprocessMock.mockReset();
    runSubprocessMock.mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes spec.defaultCwd to runSubprocess when caller does not provide cwd', async () => {
    const spec = makeSpec({ defaultCwd: 'C:/temp/agent-sandbox' });
    await runAgentTurn({ spec, prompt: 'hi', sessionId: null });
    expect(runSubprocessMock).toHaveBeenCalledTimes(1);
    const firstCall = runSubprocessMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const callArgs = (firstCall as unknown as [{ cwd?: string }])[0];
    expect(callArgs.cwd).toBe('C:/temp/agent-sandbox');
  });

  it('uses spec.buildCwd before spec.defaultCwd when caller does not provide cwd', async () => {
    const buildCwd = vi.fn(() => 'C:/temp/fresh-agent-sandbox');
    const spec = makeSpec({ defaultCwd: 'C:/temp/static-agent-sandbox', buildCwd });
    await runAgentTurn({ spec, prompt: 'hi', sessionId: 'session-1' });
    expect(buildCwd).toHaveBeenCalledWith('hi', 'session-1');
    const firstCall = runSubprocessMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const callArgs = (firstCall as unknown as [{ cwd?: string }])[0];
    expect(callArgs.cwd).toBe('C:/temp/fresh-agent-sandbox');
  });

  it('caller cwd overrides spec.buildCwd and spec.defaultCwd', async () => {
    const buildCwd = vi.fn(() => 'C:/temp/fresh-agent-sandbox');
    const spec = makeSpec({ defaultCwd: 'C:/temp/agent-sandbox', buildCwd });
    await runAgentTurn({
      spec,
      prompt: 'hi',
      sessionId: null,
      cwd: 'C:/explicit/override',
    });
    expect(buildCwd).not.toHaveBeenCalled();
    const firstCall = runSubprocessMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const callArgs = (firstCall as unknown as [{ cwd?: string }])[0];
    expect(callArgs.cwd).toBe('C:/explicit/override');
  });

  it('omits cwd entirely when neither caller nor spec provide one', async () => {
    const spec = makeSpec();
    await runAgentTurn({ spec, prompt: 'hi', sessionId: null });
    const firstCall = runSubprocessMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const callArgs = (firstCall as unknown as [{ cwd?: string }])[0];
    expect('cwd' in callArgs).toBe(false);
  });

  it('passes permission context to adapter argument builders', async () => {
    const buildArgs = vi.fn(() => ['--with-permission']);
    const spec = makeSpec({ buildArgs });
    await runAgentTurn({
      spec,
      prompt: 'hi',
      sessionId: null,
      permission: { mode: 'edit', target: 'foo.txt', reason: 'requested edit' },
    });

    expect(buildArgs).toHaveBeenCalledWith('hi', null, {
      permission: { mode: 'edit', target: 'foo.txt', reason: 'requested edit' },
    });
    const firstCall = runSubprocessMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const callArgs = (firstCall as unknown as [{ args: string[] }])[0];
    expect(callArgs.args).toEqual(['--with-permission']);
  });

  it('passes adapter env overrides to runSubprocess', async () => {
    const buildEnv = vi.fn(() => ({ ANTHROPIC_LOG: 'debug' }));
    const spec = makeSpec({ buildEnv });
    await runAgentTurn({ spec, prompt: 'hi', sessionId: 'session-1' });

    expect(buildEnv).toHaveBeenCalledWith('hi', 'session-1');
    const firstCall = runSubprocessMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const callArgs = (firstCall as unknown as [{ env?: Record<string, string> }])[0];
    expect(callArgs.env).toEqual({ ANTHROPIC_LOG: 'debug' });
  });

  it('forwards parsed stream events from runSubprocess callbacks', async () => {
    runSubprocessMock.mockImplementationOnce(async (opts: unknown) => {
      const callbacks = opts as { onStdoutLine?: (line: string) => void };
      callbacks.onStdoutLine?.('{"type":"turn.started"}');
      return {
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });
    const events: unknown[] = [];
    const spec = makeSpec({
      parseStreamLine: (line, stream) => [
        {
          kind: 'event',
          status: 'running',
          label: `${stream}:${line}`,
        },
      ],
    });

    await runAgentTurn({
      spec,
      prompt: 'hi',
      sessionId: null,
      onStreamEvent: (event) => events.push(event),
    });

    expect(events).toEqual([
      {
        kind: 'event',
        status: 'running',
        label: 'stdout:{"type":"turn.started"}',
      },
    ]);
  });

  it('passes null timeout through to disable subprocess timeout', async () => {
    const spec = makeSpec();
    await runAgentTurn({ spec, prompt: 'hi', sessionId: null, timeoutMs: null });
    const firstCall = runSubprocessMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const callArgs = (firstCall as unknown as [{ timeoutMs?: number | null }])[0];
    expect(callArgs.timeoutMs).toBeNull();
  });
});
