import { describe, expect, it } from 'vitest';
import {
  canTransitionRunExecutionState,
  inferRunExecutionSnapshot,
  validateRunExecutionTransition,
} from '../../src/orchestration/run-state-machine.js';
import type { AgentJob } from '../../src/repos/agent-jobs.js';
import type { AgentRun } from '../../src/repos/agent-runs.js';

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 'job-1',
    roomId: 'room-1',
    taskId: null,
    checklistItemId: null,
    agentId: 'codex',
    triggerMessageId: 'message-1',
    runId: null,
    status: 'queued',
    workPacketJson: '{}',
    permissionJson: '{}',
    leaseOwner: '',
    leaseExpiresAt: 0,
    attempt: 1,
    maxAttempts: 3,
    error: '',
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    ...overrides,
  };
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    agentJobId: 'job-1',
    roomId: 'room-1',
    taskId: null,
    triggerMessageId: 'message-1',
    replyMessageId: null,
    agentId: 'codex',
    status: 'running',
    permissionMode: 'plan',
    promptChars: 10,
    estimatedPromptTokens: 3,
    liveMessages: 1,
    contextArtifacts: 0,
    startedAt: 1,
    completedAt: null,
    error: '',
    promptText: '',
    stdout: '',
    stderr: '',
    replyText: '',
    cliSessionId: null,
    permissionSource: '',
    permissionTarget: '',
    permissionReason: '',
    permissionFilesystemScope: '',
    permissionWeb: false,
    permissionCapabilities: [],
    permissionTargetExists: null,
    permissionTargetKind: 'unknown',
    permissionTargetResolvedPath: '',
    permissionTargetCheckedAt: 0,
    permissionProviderProfile: '',
    lifecycleState: 'streaming_turn',
    lifecycleReason: 'provider is streaming',
    lifecycleUpdatedAt: 1,
    lastSignalAt: 1,
    attempt: 1,
    continuationTurn: 1,
    maxTurns: 1,
    workspacePath: '',
    retryOfRunId: '',
    retryAfter: 0,
    ...overrides,
  };
}

describe('run execution state machine', () => {
  it('infers visible state from job and run state', () => {
    expect(inferRunExecutionSnapshot({ job: job({ status: 'queued' }) }).state).toBe('queued');
    expect(
      inferRunExecutionSnapshot({
        job: job({ status: 'running' }),
        run: run({ status: 'permission-requested' }),
      }).state,
    ).toBe('waiting_on_permission');
    expect(
      inferRunExecutionSnapshot({
        job: job({ status: 'failed' }),
        run: run({ status: 'failed', error: 'boom' }),
      }),
    ).toMatchObject({ state: 'failed', reason: 'boom', terminal: true });
  });

  it('treats retry_queued as retrying even though the run row is still active', () => {
    const snapshot = inferRunExecutionSnapshot({
      job: job({ status: 'failed' }),
      run: run({ status: 'failed', lifecycleState: 'retry_queued', retryAfter: 1234 }),
    });
    expect(snapshot).toMatchObject({
      state: 'retrying',
      retryAfter: 1234,
      terminal: false,
    });
  });

  it('validates legal transitions', () => {
    expect(canTransitionRunExecutionState('queued', 'running')).toBe(true);
    expect(canTransitionRunExecutionState('completed', 'running')).toBe(false);
    expect(validateRunExecutionTransition('completed', 'running')).toMatchObject({
      ok: false,
      from: 'completed',
      to: 'running',
    });
  });
});
