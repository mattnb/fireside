import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { Broker } from '../../src/broker.js';
import { addMessage } from '../../src/repos/messages.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createAgentRun, getAgentRun, updateAgentRun } from '../../src/repos/agent-runs.js';
import { listAgentRunActions } from '../../src/repos/run-actions.js';
import { getCliSessionId, upsertCliSessionId } from '../../src/repos/sessions.js';
import type { AgentId, AgentSpec } from '../../src/agents/types.js';

function fakeSpec(id: AgentId): AgentSpec {
  return {
    id,
    displayName: id,
    command: 'fake-agent',
    defaultTimeoutMs: 1000,
    buildArgs: () => [],
    parseOutput: () => ({ text: '', sessionId: null, raw: { stdout: '', stderr: '' } }),
  };
}

describe('manual agent compaction', () => {
  it('starts a provider compact turn against the stored CLI session', async () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'camp', agents: ['codex'] });
    addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: '@codex keep this session healthy',
    });
    upsertCliSessionId(db, room.id, 'codex', 'session-1');

    const calls: Array<{ prompt: string; sessionId: string | null }> = [];
    const broker = new Broker({
      db,
      resumeCliSessions: true,
      getSpec: (id) => (id === 'codex' ? fakeSpec('codex') : undefined),
      runAgent: async (_spec, prompt, sessionId, _permission, _cancelSignal, onStreamEvent) => {
        calls.push({ prompt, sessionId });
        onStreamEvent?.({
          kind: 'event',
          status: 'completed',
          label: 'provider compact event',
          detail: 'compact accepted',
        });
        return {
          text: 'Compacted.',
          sessionId: 'session-2',
          raw: { stdout: '{"ok":true}', stderr: '' },
        };
      },
    });

    const result = broker.startAgentCompaction(room.id, 'codex', 'human');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(calls).toEqual([{ prompt: '/compact', sessionId: 'session-1' }]);

    await new Promise<void>((resolve) => setImmediate(resolve));

    const run = getAgentRun(db, result.run.id);
    expect(run).toMatchObject({
      status: 'completed',
      replyText: 'Compacted.',
      cliSessionId: 'session-2',
    });
    expect(getCliSessionId(db, room.id, 'codex')).toBe('session-2');
    const actions = listAgentRunActions(db, result.run.id);
    expect(actions.map((action) => action.label)).toEqual(
      expect.arrayContaining([
        'manual compaction requested',
        'agent process started',
        'provider compact event',
        'context compacted',
      ]),
    );
  });

  it('surfaces Codex rollout persistence stderr as a compaction warning', async () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'camp', agents: ['codex'] });
    addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: '@codex keep this session healthy',
    });
    upsertCliSessionId(db, room.id, 'codex', 'session-1');

    const broker = new Broker({
      db,
      resumeCliSessions: true,
      getSpec: (id) => (id === 'codex' ? fakeSpec('codex') : undefined),
      runAgent: async () => ({
        text: 'Compacted.',
        sessionId: 'session-1',
        raw: {
          stdout: '{"ok":true}',
          stderr:
            '2026-04-30T23:21:27Z ERROR codex_core::session: failed to record rollout items: thread session-1 not found\n',
        },
      }),
    });

    const result = broker.startAgentCompaction(room.id, 'codex', 'human');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    await new Promise<void>((resolve) => setImmediate(resolve));

    const actions = listAgentRunActions(db, result.run.id);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'run',
          status: 'completed',
          label: 'context compacted with provider warning',
        }),
      ]),
    );
  });

  it('does not recover a resumable session from historical agent runs', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'camp', agents: ['claude'] });
    const trigger = addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: '@claude keep this session healthy',
    });
    const previous = createAgentRun(db, {
      roomId: room.id,
      triggerMessageId: trigger.id,
      agentId: 'claude',
      permissionMode: 'plan',
      promptChars: 20,
      estimatedPromptTokens: 5,
      liveMessages: 1,
      contextArtifacts: 0,
    });
    updateAgentRun(db, previous.id, {
      status: 'completed',
      completedAt: Date.now(),
      cliSessionId: 'run-session-1',
    });

    const broker = new Broker({
      db,
      resumeCliSessions: true,
      getSpec: (id) => (id === 'claude' ? fakeSpec('claude') : undefined),
      runAgent: async () => {
        throw new Error('runAgent should not be called');
      },
    });

    const result = broker.startAgentCompaction(room.id, 'claude', 'human');
    expect(result).toMatchObject({
      ok: false,
      statusCode: 409,
      error: 'claude has no stored CLI session yet',
    });
    expect(getCliSessionId(db, room.id, 'claude')).toBeNull();
  });

  it('rejects compaction without a stored resumable session', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'camp', agents: ['claude'] });
    addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: '@claude hi',
    });
    const broker = new Broker({
      db,
      resumeCliSessions: true,
      getSpec: (id) => (id === 'claude' ? fakeSpec('claude') : undefined),
      runAgent: async () => {
        throw new Error('runAgent should not be called');
      },
    });

    const result = broker.startAgentCompaction(room.id, 'claude', 'human');
    expect(result).toMatchObject({
      ok: false,
      statusCode: 409,
      error: 'claude has no stored CLI session yet',
    });
  });
});
