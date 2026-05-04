import { describe, expect, it } from 'vitest';
import {
  createProviderSignalProcessingState,
  describeRunHeartbeat,
  processProviderSignalEvent,
} from '../../src/orchestration/run-activity.js';

describe('run activity orchestration', () => {
  it('turns visible provider signals into run actions and lifecycle updates', () => {
    const state = createProviderSignalProcessingState();
    const result = processProviderSignalEvent(
      state,
      {
        kind: 'message',
        status: 'completed',
        label: 'codex assistant message ready',
        detail: '{"message":"I am applying the fix and will report back after tests."}',
      },
      { now: 3_000, runSignalUpdateThrottleMs: 2_500 },
    );

    expect(result.lifecycleUpdate).toMatchObject({
      state: 'streaming_turn',
      reason: 'codex assistant message ready',
      lastSignalAt: 3_000,
    });
    expect(result.action).toMatchObject({
      kind: 'message',
      status: 'completed',
      label: 'codex assistant message ready',
      detail: 'I am applying the fix and will report back after tests.',
    });
  });

  it('suppresses noisy duplicate stream signals while preserving lifecycle signal timing', () => {
    const state = createProviderSignalProcessingState();
    processProviderSignalEvent(
      state,
      { kind: 'tool', status: 'running', label: 'claude tool_use', detail: 'Edit' },
      { now: 3_000 },
    );
    const duplicate = processProviderSignalEvent(
      state,
      { kind: 'tool', status: 'running', label: 'claude tool_use', detail: 'Edit' },
      { now: 3_100 },
    );

    expect(duplicate.action).toBeNull();
    expect(duplicate.lifecycleUpdate).toBeNull();
  });

  it('describes heartbeat details relative to the last provider signal', () => {
    expect(
      describeRunHeartbeat({
        startedAt: 1_000,
        latestProviderSignalAt: 0,
        now: 31_000,
        stallAfterMs: 60_000,
      }),
    ).toMatchObject({
      elapsedSeconds: 30,
      detail: '30s elapsed; no provider stream output yet',
      stalled: false,
    });

    expect(
      describeRunHeartbeat({
        startedAt: 1_000,
        latestProviderSignalAt: 20_000,
        now: 80_000,
        stallAfterMs: 60_000,
      }),
    ).toMatchObject({
      idleMs: 60_000,
      detail: 'last provider signal 60s ago; process still running',
      stalled: true,
    });
  });
});
