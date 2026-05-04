import { describe, expect, it } from 'vitest';
import {
  RunLifecycleTransitionError,
  advanceRunLifecycle,
  calculateRetryDelayMs,
  canTransitionRunLifecycle,
  decideRunContinuation,
  decideRunRetry,
  detectRunLifecycleStall,
  mapRunLifecycleToAgentRunStatus,
  recordRunLifecycleSignal,
  startRunLifecycle,
  transitionRunLifecycle,
  validateRunLifecycleTransition,
  type RunLifecycle,
} from '../../src/run-lifecycle.js';

function makeStreamingRun(): RunLifecycle {
  let lifecycle = startRunLifecycle({ now: 1_000 });
  lifecycle = advanceRunLifecycle(lifecycle, { now: 1_010 });
  lifecycle = advanceRunLifecycle(lifecycle, { now: 1_020 });
  lifecycle = advanceRunLifecycle(lifecycle, { now: 1_030 });
  lifecycle = advanceRunLifecycle(lifecycle, { now: 1_040 });
  return advanceRunLifecycle(lifecycle, { now: 1_050 });
}

describe('run lifecycle state machine', () => {
  it('advances through the legal phase path and preserves the terminal outcome', () => {
    let lifecycle = startRunLifecycle({ now: 10 });

    lifecycle = advanceRunLifecycle(lifecycle, { now: 20 });
    expect(lifecycle.state).toBe('preparing_workspace');

    lifecycle = advanceRunLifecycle(lifecycle, { now: 30 });
    expect(lifecycle.state).toBe('building_prompt');

    lifecycle = advanceRunLifecycle(lifecycle, { now: 40 });
    expect(lifecycle.state).toBe('launching_agent_process');

    lifecycle = advanceRunLifecycle(lifecycle, { now: 50 });
    expect(lifecycle.state).toBe('initializing_session');

    lifecycle = advanceRunLifecycle(lifecycle, { now: 60 });
    expect(lifecycle.state).toBe('streaming_turn');

    lifecycle = advanceRunLifecycle(lifecycle, { now: 70 });
    expect(lifecycle.state).toBe('finishing');

    lifecycle = advanceRunLifecycle(lifecycle, { now: 80 });
    expect(lifecycle.state).toBe('succeeded');
    expect(lifecycle.outcome).toBe('succeeded');

    const released = transitionRunLifecycle(lifecycle, 'released', { now: 90 });
    expect(released.state).toBe('released');
    expect(released.outcome).toBe('succeeded');
  });

  it('rejects illegal transitions', () => {
    const lifecycle = startRunLifecycle({ now: 1 });

    expect(canTransitionRunLifecycle('start', 'streaming_turn')).toBe(false);
    expect(validateRunLifecycleTransition('start', 'streaming_turn')).toMatchObject({
      ok: false,
      allowed: ['preparing_workspace', 'canceled_by_reconciliation', 'canceled_by_user'],
    });
    expect(() => transitionRunLifecycle(lifecycle, 'streaming_turn')).toThrow(
      RunLifecycleTransitionError,
    );
  });

  it('detects stalls from started time until provider signals arrive', () => {
    const streaming = makeStreamingRun();

    expect(detectRunLifecycleStall(streaming, { now: 1_499, stallAfterMs: 500 })).toMatchObject({
      stalled: false,
      referenceAt: 1_000,
      silenceMs: 499,
    });
    expect(detectRunLifecycleStall(streaming, { now: 1_500, stallAfterMs: 500 })).toMatchObject({
      stalled: true,
      referenceAt: 1_000,
      silenceMs: 500,
      reason: 'run_stalled',
    });

    const signaled = recordRunLifecycleSignal(streaming, 1_400);
    expect(detectRunLifecycleStall(signaled, { now: 1_899, stallAfterMs: 500 })).toMatchObject({
      stalled: false,
      referenceAt: 1_400,
      silenceMs: 499,
    });
    expect(detectRunLifecycleStall(signaled, { now: 1_900, stallAfterMs: 500 })).toMatchObject({
      stalled: true,
      referenceAt: 1_400,
      silenceMs: 500,
    });
  });

  it('caps retry backoff', () => {
    expect(calculateRetryDelayMs({ attempt: 1, baseDelayMs: 1_000, maxDelayMs: 5_000 })).toBe(
      1_000,
    );
    expect(calculateRetryDelayMs({ attempt: 3, baseDelayMs: 1_000, maxDelayMs: 5_000 })).toBe(
      4_000,
    );
    expect(calculateRetryDelayMs({ attempt: 10, baseDelayMs: 1_000, maxDelayMs: 5_000 })).toBe(
      5_000,
    );
  });

  it('queues retries for retryable outcomes until the attempt cap is reached', () => {
    const failed = transitionRunLifecycle(makeStreamingRun(), 'failed', {
      now: 2_000,
      error: 'provider exited non-zero',
    });

    const retry = decideRunRetry(failed, {
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 2_000,
    });
    expect(retry).toMatchObject({
      shouldRetry: true,
      nextState: 'retry_queued',
      reason: 'retry_scheduled',
      delayMs: 250,
      nextAttempt: 2,
      attemptsRemaining: 2,
    });

    const queued = transitionRunLifecycle(failed, retry.nextState, {
      now: 2_250,
      reason: retry.reason,
    });
    expect(queued.state).toBe('retry_queued');
    expect(queued.outcome).toBe('failed');

    expect(decideRunRetry({ ...failed, attempt: 3 }, { maxAttempts: 3 })).toMatchObject({
      shouldRetry: false,
      nextState: 'released',
      reason: 'retry_limit_reached',
      nextAttempt: null,
    });
  });

  it('uses active mission state to choose continuation retries', () => {
    const failed = transitionRunLifecycle(makeStreamingRun(), 'timed_out', { now: 2_000 });

    expect(
      decideRunContinuation({
        lifecycle: failed,
        mission: { status: 'active', hasOpenWork: true },
        retryPolicy: { maxAttempts: 3, baseDelayMs: 500 },
      }),
    ).toMatchObject({
      action: 'retry',
      shouldRetry: true,
      nextState: 'retry_queued',
      reason: 'active_mission_retry',
      delayMs: 500,
      nextAttempt: 2,
    });

    expect(
      decideRunContinuation({
        lifecycle: failed,
        mission: { status: 'paused', hasOpenWork: true },
        retryPolicy: { maxAttempts: 3 },
      }),
    ).toMatchObject({
      action: 'release',
      shouldRetry: false,
      nextState: 'released',
      reason: 'mission_not_active',
    });

    const finishing = transitionRunLifecycle(makeStreamingRun(), 'finishing', { now: 2_000 });
    const succeeded = transitionRunLifecycle(finishing, 'succeeded', { now: 2_100 });
    expect(
      decideRunContinuation({
        lifecycle: succeeded,
        mission: { status: 'verifying', hasOpenWork: true },
      }),
    ).toMatchObject({
      action: 'continue',
      shouldContinue: true,
      nextState: 'released',
      reason: 'active_mission_continues',
    });
  });

  it('maps lifecycle states to existing AgentRunStatus values', () => {
    expect(mapRunLifecycleToAgentRunStatus('building_prompt')).toBe('running');
    expect(mapRunLifecycleToAgentRunStatus('retry_queued')).toBe('running');
    expect(mapRunLifecycleToAgentRunStatus('succeeded')).toBe('completed');
    expect(mapRunLifecycleToAgentRunStatus('stalled')).toBe('failed');

    const failed = transitionRunLifecycle(makeStreamingRun(), 'failed', { now: 2_000 });
    const releasedAfterFailure = transitionRunLifecycle(failed, 'released', { now: 2_100 });
    expect(mapRunLifecycleToAgentRunStatus(releasedAfterFailure)).toBe('failed');
  });
});
