// server/tests/integration/timeout.test.ts
import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { listMessages } from '../../src/repos/messages.js';
import { Broker } from '../../src/broker.js';
import { SubprocessTimeoutError } from '../../src/windows/spawn.js';
import type { AgentId, AgentSpec } from '../../src/agents/types.js';

function spec(id: AgentId): AgentSpec {
  return {
    id,
    displayName: id,
    command: 'fake',
    defaultTimeoutMs: 100,
    buildArgs: () => [],
    parseOutput: () => ({ text: '', sessionId: null, raw: { stdout: '', stderr: '' } }),
  };
}

describe('Broker timeout handling', () => {
  it('posts a system message when an agent times out, does not crash', async () => {
    const db = openDatabase(':memory:');
    const broker = new Broker({
      db,
      runAgent: async () => {
        throw new SubprocessTimeoutError('claude', 100);
      },
      getSpec: (id) => spec(id),
    });
    const room = createRoom(db, { name: 'g', agents: ['claude'] });
    await broker.postHumanMessage(room.id, 'human', '@claude');
    const messages = listMessages(db, room.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.authorKind).toBe('system');
    expect(messages[1]!.text).toContain('timed out');
  });
});
