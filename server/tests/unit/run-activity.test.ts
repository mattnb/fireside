import { describe, expect, it } from 'vitest';
import {
  annotateContextUsageWithTurnKind,
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

  it('annotates contextUsage with the broker-known turnKind so the UI can filter mechanical turns', () => {
    // Without this annotation, workflow-repair / maintenance-compaction
    // turns (which run on Haiku regardless of agent profile) overwrote
    // the agent's primary "current context" display with their own
    // bookkeeping-model usage. Confirmed in the 2026-05-09 compact-modal
    // bug where a Sonnet 4.6 agent showed claude-haiku-4-5 · 113K/200K.
    const annotated = annotateContextUsageWithTurnKind(
      { provider: 'claude', model: 'claude-haiku-4-5', usedTokens: 113000, source: 'stream' },
      'workflow-repair',
    );
    expect(annotated).toMatchObject({
      provider: 'claude',
      model: 'claude-haiku-4-5',
      turnKind: 'workflow-repair',
    });
  });

  it('preserves a pre-existing turnKind on the contextUsage payload (adapter override wins)', () => {
    const annotated = annotateContextUsageWithTurnKind(
      {
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        usedTokens: 1000,
        source: 'stream',
        turnKind: 'chat',
      },
      'workflow-repair',
    );
    expect(annotated?.turnKind).toBe('chat');
  });

  it('returns the original payload unchanged when no turnKind is supplied', () => {
    const usage = {
      provider: 'codex',
      model: 'gpt-5-codex',
      usedTokens: 5000,
      source: 'stream',
    } as const;
    expect(annotateContextUsageWithTurnKind(usage, undefined)).toBe(usage);
  });

  it('returns undefined when the contextUsage itself is undefined', () => {
    expect(annotateContextUsageWithTurnKind(undefined, 'workflow-repair')).toBeUndefined();
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
