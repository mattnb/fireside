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

  it('caller cwd overrides spec.defaultCwd', async () => {
    const spec = makeSpec({ defaultCwd: 'C:/temp/agent-sandbox' });
    await runAgentTurn({
      spec,
      prompt: 'hi',
      sessionId: null,
      cwd: 'C:/explicit/override',
    });
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
});
