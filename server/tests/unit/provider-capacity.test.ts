import { describe, expect, it } from 'vitest';
import {
  capacityBlockFromContextUsage,
  latestProviderCapacityBlock,
} from '../../src/provider-capacity.js';
import type { AgentRunAction } from '../../src/repos/run-actions.js';

describe('provider capacity blocks', () => {
  it('detects an active quota block from usage metadata', () => {
    const now = 1_800_000_000_000;
    const block = capacityBlockFromContextUsage(
      {
        provider: 'gemini',
        model: 'gemini-2.5-pro',
        usedTokens: 0,
        quotaOnly: true,
        quota: {
          daily: {
            percent: 100,
            resetsAt: now + 60_000,
            status: 'limited',
          },
          source: 'gemini:terminal-quota',
        },
        source: 'gemini:terminal-quota',
      },
      now,
    );

    expect(block).toMatchObject({
      providerId: 'gemini',
      status: 'limited',
      resetsAt: now + 60_000,
      source: 'gemini:terminal-quota',
    });
  });

  it('clears the block when a newer successful usage event exists', () => {
    const now = 1_800_000_000_000;
    const actions: AgentRunAction[] = [
      {
        id: 'newer',
        roomId: 'room',
        taskId: null,
        runId: 'run-2',
        agentId: 'gemini',
        kind: 'adapter',
        status: 'completed',
        label: 'gemini result received',
        detail: '',
        contextUsage: {
          provider: 'gemini',
          model: 'gemini-2.5-pro',
          usedTokens: 20,
          source: 'gemini:usage_metadata',
        },
        createdAt: now,
      },
      {
        id: 'older',
        roomId: 'room',
        taskId: null,
        runId: 'run-1',
        agentId: 'gemini',
        kind: 'adapter',
        status: 'failed',
        label: 'gemini quota exhausted',
        detail: '',
        contextUsage: {
          provider: 'gemini',
          model: 'gemini-2.5-pro',
          usedTokens: 0,
          quotaOnly: true,
          quota: {
            daily: {
              percent: 100,
              resetsAt: now + 60_000,
              status: 'limited',
            },
            source: 'gemini:terminal-quota',
          },
          source: 'gemini:terminal-quota',
        },
        createdAt: now - 1_000,
      },
    ];

    expect(latestProviderCapacityBlock(actions, 'gemini', now)).toBeNull();
  });
});
