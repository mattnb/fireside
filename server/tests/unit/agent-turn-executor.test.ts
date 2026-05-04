import { describe, expect, it } from 'vitest';
import type { AgentSpec } from '../../src/agents/types.js';
import type { PermissionGrant } from '../../src/permissions.js';
import {
  executeProviderTurn,
  rawOutputFromError,
} from '../../src/orchestration/agent-turn-executor.js';

const spec: AgentSpec = {
  id: 'codex',
  displayName: 'Codex',
  command: 'codex',
  buildArgs: () => [],
  parseOutput: (stdout, stderr) => ({ text: stdout, sessionId: null, raw: { stdout, stderr } }),
  defaultTimeoutMs: 1_000,
};

const yoloPermission: PermissionGrant = {
  source: 'yolo',
  mode: 'full-auto',
  target: 'unrestricted filesystem',
  reason: 'YOLO',
};

describe('agent turn executor', () => {
  it('runs the provider with abort wiring and stops the heartbeat on success', async () => {
    let registered = false;
    let unregistered = false;
    let stopped = false;

    const result = await executeProviderTurn({
      runAgent: async (_spec, prompt, _sessionId, _permission, signal) => {
        expect(prompt).toBe('prompt');
        expect(signal).toBeInstanceOf(AbortSignal);
        return { text: 'pong', sessionId: 'session', raw: { stdout: 'out', stderr: '' } };
      },
      spec,
      prompt: 'prompt',
      sessionId: null,
      registerAbortController: () => {
        registered = true;
      },
      unregisterAbortController: () => {
        unregistered = true;
      },
      startHeartbeat: () => () => {
        stopped = true;
      },
      yoloMode: false,
      attempt: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      reply: { text: 'pong', sessionId: 'session' },
    });
    expect({ registered, unregistered, stopped }).toEqual({
      registered: true,
      unregistered: true,
      stopped: true,
    });
  });

  it('uncaps provider timeout when a YOLO permission is active', async () => {
    let timeout: number | null | undefined;

    await executeProviderTurn({
      runAgent: async (_spec, _prompt, _sessionId, _permission, _signal, _onStream, timeoutMs) => {
        timeout = timeoutMs;
        return { text: '', sessionId: null, raw: { stdout: '', stderr: '' } };
      },
      spec,
      prompt: '',
      sessionId: null,
      permission: yoloPermission,
      registerAbortController: () => {},
      unregisterAbortController: () => {},
      startHeartbeat: () => () => {},
      yoloMode: true,
      attempt: 1,
    });

    expect(timeout).toBeNull();
  });

  it('forwards turn kind to the provider runner', async () => {
    let seenTurnKind: unknown;

    await executeProviderTurn({
      runAgent: async (
        _spec,
        _prompt,
        _sessionId,
        _permission,
        _signal,
        _onStream,
        _timeoutMs,
        turnKind,
      ) => {
        seenTurnKind = turnKind;
        return { text: '', sessionId: null, raw: { stdout: '', stderr: '' } };
      },
      spec,
      prompt: '',
      sessionId: null,
      registerAbortController: () => {},
      unregisterAbortController: () => {},
      startHeartbeat: () => () => {},
      yoloMode: true,
      attempt: 1,
      turnKind: 'work-lane',
    });

    expect(seenTurnKind).toBe('work-lane');
  });

  it('classifies YOLO provider failures and computes retry decisions', async () => {
    const error = new Error('provider exited');
    Object.assign(error, { stdout: 'raw out', stderr: 'raw err' });

    const result = await executeProviderTurn({
      runAgent: async () => {
        throw error;
      },
      spec,
      prompt: '',
      sessionId: null,
      registerAbortController: () => {},
      unregisterAbortController: () => {},
      startHeartbeat: () => () => {},
      yoloMode: true,
      attempt: 1,
      maxRetryAttempts: 3,
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'provider exited',
      stdout: 'raw out',
      stderr: 'raw err',
      canceled: false,
      retryDecision: {
        shouldRetry: true,
        nextAttempt: 2,
      },
    });
  });

  it('extracts raw stdout and stderr from thrown provider errors', () => {
    expect(rawOutputFromError({ stdout: 'out', stderr: 'err' })).toEqual({
      stdout: 'out',
      stderr: 'err',
    });
    expect(rawOutputFromError(new Error('plain'))).toEqual({ stdout: '', stderr: '' });
  });
});
