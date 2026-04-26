// server/tests/integration/broker-echo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { listMessages } from '../../src/repos/messages.js';
import { Broker } from '../../src/broker.js';
import type { AgentId, AgentSpec } from '../../src/agents/types.js';

function fakeSpec(id: AgentId, replyText: string): AgentSpec {
  return {
    id,
    displayName: id,
    command: 'fake',
    defaultTimeoutMs: 1000,
    buildArgs: () => [],
    parseOutput: () => ({ text: replyText, sessionId: `${id}-sess`, raw: { stdout: '', stderr: '' } }),
  };
}

describe('Broker', () => {
  let db: ReturnType<typeof openDatabase>;
  let broker: Broker;
  let runs: Array<{ agentId: AgentId; prompt: string; sessionId: string | null }>;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runs = [];
    broker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return { text: `${spec.id}-says-hello`, sessionId: `${spec.id}-sess`, raw: { stdout: '', stderr: '' } };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
  });

  it('routes a human message with @claude mention to claude only', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });
    await broker.postHumanMessage(room.id, 'matt', '@claude hey');
    const messages = listMessages(db, room.id);
    expect(messages.map((m) => `${m.authorId}:${m.text}`)).toEqual([
      'matt:@claude hey',
      'claude:claude-says-hello',
    ]);
    expect(runs.map((r) => r.agentId)).toEqual(['claude']);
  });

  it('without mentions, all agents in the room reply', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });
    await broker.postHumanMessage(room.id, 'matt', 'hi everyone');
    const messages = listMessages(db, room.id);
    expect(messages).toHaveLength(3);
    expect(runs.map((r) => r.agentId).sort()).toEqual(['claude', 'codex']);
  });

  it('agents do not reply to their own messages (no recursion)', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });
    await broker.postHumanMessage(room.id, 'matt', 'kick it off');
    const before = runs.length;
    // Even though codex's reply lands in the room, it must not trigger another round.
    expect(runs.length).toBe(before);
    expect(runs.length).toBe(2);
  });

  it('persists session id from agent reply', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude'] });
    await broker.postHumanMessage(room.id, 'matt', '@claude hi');
    // Second message should be invoked with the prior session id.
    await broker.postHumanMessage(room.id, 'matt', '@claude again');
    expect(runs[0]!.sessionId).toBeNull();
    expect(runs[1]!.sessionId).toBe('claude-sess');
  });

  it('emits "messageAppended" events for both human and agent messages', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude'] });
    const events: Array<{ author: string; text: string }> = [];
    broker.on('messageAppended', (msg) => events.push({ author: msg.authorId, text: msg.text }));
    await broker.postHumanMessage(room.id, 'matt', '@claude hi');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ author: 'matt' });
    expect(events[1]).toMatchObject({ author: 'claude' });
  });
});
