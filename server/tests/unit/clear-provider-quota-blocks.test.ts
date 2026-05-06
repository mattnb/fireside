// server/tests/unit/clear-provider-quota-blocks.test.ts
// Verifies that clearProviderQuotaBlocks identifies real blocks via the same
// logic the dispatch path uses (capacityBlockFromContextUsage), clears only
// those rows, and leaves non-block rows + non-matching providers alone.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { addMessage } from '../../src/repos/messages.js';
import { createAgentRun } from '../../src/repos/agent-runs.js';
import {
  clearProviderQuotaBlocks,
  createAgentRunAction,
  listRecentContextUsageActions,
} from '../../src/repos/run-actions.js';
import type { AgentContextUsage } from '../../src/context-usage.js';

const NOW = 1_800_000_000_000;

function setupRoomAndRun(db: ReturnType<typeof openDatabase>): { roomId: string; runId: string } {
  const room = createRoom(db, { name: 'general', agents: ['claude', 'gemini', 'codex'] });
  const trigger = addMessage(db, {
    roomId: room.id,
    authorId: 'human',
    authorKind: 'human',
    text: 'go',
  });
  const run = createAgentRun(db, {
    roomId: room.id,
    triggerMessageId: trigger.id,
    agentId: 'gemini',
    permissionMode: 'plan',
    promptChars: 0,
    estimatedPromptTokens: 0,
    liveMessages: 0,
    contextArtifacts: 0,
  });
  return { roomId: room.id, runId: run.id };
}

function geminiBlocked(resetsAtMs: number): AgentContextUsage {
  return {
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    usedTokens: 0,
    quotaOnly: true,
    quota: {
      daily: {
        percent: 100,
        resetsAt: resetsAtMs,
        status: 'limited',
      },
      source: 'gemini:terminal-quota',
    },
    source: 'gemini:terminal-quota',
  };
}

function geminiAllowed(): AgentContextUsage {
  return {
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    usedTokens: 12,
    source: 'gemini:usage_metadata',
  };
}

function claudeBlocked(resetsAtMs: number): AgentContextUsage {
  return {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    usedTokens: 0,
    quotaOnly: true,
    quota: {
      fiveHour: {
        percent: 100,
        resetsAt: resetsAtMs,
        status: 'exhausted',
      },
      source: 'claude:rate-limit',
    },
    source: 'claude:rate-limit',
  };
}

describe('clearProviderQuotaBlocks', () => {
  let db: ReturnType<typeof openDatabase>;
  let roomId: string;
  let runId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const setup = setupRoomAndRun(db);
    roomId = setup.roomId;
    runId = setup.runId;
  });

  it('returns 0 when there are no rows at all', () => {
    expect(clearProviderQuotaBlocks(db, 'gemini', NOW)).toEqual({ cleared: 0 });
  });

  it('returns 0 when the provider has no blocked rows', () => {
    createAgentRunAction(db, {
      roomId,
      runId,
      agentId: 'gemini',
      kind: 'adapter',
      status: 'completed',
      label: 'gemini result',
      contextUsage: geminiAllowed(),
    });
    const result = clearProviderQuotaBlocks(db, 'gemini', NOW);
    expect(result.cleared).toBe(0);
    // Allowed-status rows are NOT touched.
    const remaining = listRecentContextUsageActions(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.contextUsage?.usedTokens).toBe(12);
  });

  it('clears blocked rows for the targeted provider', () => {
    const resetsAt = NOW + 60_000;
    createAgentRunAction(db, {
      roomId,
      runId,
      agentId: 'gemini',
      kind: 'diagnostic',
      status: 'failed',
      label: 'gemini terminal quota',
      contextUsage: geminiBlocked(resetsAt),
    });
    expect(listRecentContextUsageActions(db)).toHaveLength(1);

    const result = clearProviderQuotaBlocks(db, 'gemini', NOW);
    expect(result.cleared).toBe(1);
    // Row stays (audit trail) but its context_usage_json is now empty, so the
    // block-walk filter `context_usage_json <> ''` skips it.
    expect(listRecentContextUsageActions(db)).toHaveLength(0);
  });

  it('leaves non-matching providers alone', () => {
    const resetsAt = NOW + 60_000;
    createAgentRunAction(db, {
      roomId,
      runId,
      agentId: 'gemini',
      kind: 'diagnostic',
      status: 'failed',
      label: 'gemini terminal quota',
      contextUsage: geminiBlocked(resetsAt),
    });
    createAgentRunAction(db, {
      roomId,
      runId,
      agentId: 'claude',
      kind: 'diagnostic',
      status: 'failed',
      label: 'claude rate limit',
      contextUsage: claudeBlocked(resetsAt),
    });

    const result = clearProviderQuotaBlocks(db, 'gemini', NOW);
    expect(result.cleared).toBe(1);
    // The claude block survives; only the gemini one was cleared.
    const remaining = listRecentContextUsageActions(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.contextUsage?.provider).toBe('claude');
  });

  it('clears multiple blocked rows in a single transaction', () => {
    const resetsAt = NOW + 60_000;
    for (let i = 0; i < 4; i++) {
      createAgentRunAction(db, {
        roomId,
        runId,
        agentId: 'gemini',
        kind: 'diagnostic',
        status: 'failed',
        label: `gemini block ${i}`,
        contextUsage: geminiBlocked(resetsAt + i),
      });
    }
    const result = clearProviderQuotaBlocks(db, 'gemini', NOW);
    expect(result.cleared).toBe(4);
    expect(listRecentContextUsageActions(db)).toHaveLength(0);
  });
});
