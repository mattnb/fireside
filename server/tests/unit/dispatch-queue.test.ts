import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { addMessage } from '../../src/repos/messages.js';
import {
  createDispatchQueueItems,
  firstPendingDispatchQueueItemForAgent,
  listPendingDispatchQueueItemsForRoom,
  markDispatchQueueItemDelivered,
} from '../../src/repos/dispatch-queue.js';
import { createAgentRun } from '../../src/repos/agent-runs.js';

describe('dispatch queue repo', () => {
  it('stores one durable pending item per unique target', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });
    const message = addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: '@claude @codex hello',
    });

    const queued = createDispatchQueueItems(db, {
      roomId: room.id,
      sourceMessageId: message.id,
      authorId: 'human',
      targetKind: 'agent',
      targetIds: ['claude', 'claude', 'codex'],
      kind: 'chat-message',
      routingTrace: [
        {
          id: 'explicit-target',
          result: 'matched',
          reason: 'test trace',
          agents: ['claude', 'codex'],
        },
      ],
    });

    expect(queued.map((item) => item.targetId)).toEqual(['claude', 'codex']);
    expect(listPendingDispatchQueueItemsForRoom(db, room.id)).toHaveLength(2);
    expect(firstPendingDispatchQueueItemForAgent(db, { roomId: room.id, agentId: 'codex' }))
      .toMatchObject({
        sourceMessageId: message.id,
        targetId: 'codex',
        kind: 'chat-message',
        routingTrace: [expect.objectContaining({ id: 'explicit-target' })],
      });
  });

  it('marks a pending dispatch as delivered with the receiving run id', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'g', agents: ['claude'] });
    const message = addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: '@claude hello',
    });
    const [item] = createDispatchQueueItems(db, {
      roomId: room.id,
      sourceMessageId: message.id,
      authorId: 'human',
      targetKind: 'agent',
      targetIds: ['claude'],
      kind: 'chat-message',
    });
    const run = createAgentRun(db, {
      roomId: room.id,
      triggerMessageId: message.id,
      agentId: 'claude',
      permissionMode: 'plan',
      promptChars: 10,
      estimatedPromptTokens: 3,
      liveMessages: 1,
      contextArtifacts: 0,
    });

    const delivered = markDispatchQueueItemDelivered(db, {
      id: item!.id,
      deliveredRunId: run.id,
    });

    expect(delivered).toMatchObject({
      id: item!.id,
      status: 'delivered',
      deliveredRunId: run.id,
    });
    expect(listPendingDispatchQueueItemsForRoom(db, room.id)).toEqual([]);
  });
});
