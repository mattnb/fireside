// server/tests/unit/messages-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import {
  addMessage,
  listMessages,
  listMessagesAfter,
  listQueuedHumanMessages,
  updateMessageDeliveryStatus,
} from '../../src/repos/messages.js';

describe('messages repo', () => {
  let db: ReturnType<typeof openDatabase>;
  let roomId: string;
  beforeEach(() => {
    db = openDatabase(':memory:');
    roomId = createRoom(db, { name: 'general', agents: [] }).id;
  });

  it('adds and lists messages in created order', () => {
    addMessage(db, { roomId, authorId: 'human', authorKind: 'human', text: 'hi' });
    addMessage(db, { roomId, authorId: 'claude', authorKind: 'agent', text: 'hello' });
    const messages = listMessages(db, roomId);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.text).toBe('hi');
    expect(messages[1]!.text).toBe('hello');
    expect(messages[0]!.id).not.toBe(messages[1]!.id);
  });

  it('respects limit param on listMessages', () => {
    for (let i = 0; i < 10; i++) {
      addMessage(db, { roomId, authorId: 'x', authorKind: 'human', text: `m${i}` });
    }
    const last3 = listMessages(db, roomId, { limit: 3 });
    expect(last3.map((m) => m.text)).toEqual(['m7', 'm8', 'm9']);
  });

  it('listMessagesAfter returns only messages with id strictly after cursor', () => {
    const a = addMessage(db, { roomId, authorId: 'x', authorKind: 'human', text: 'a' });
    addMessage(db, { roomId, authorId: 'x', authorKind: 'human', text: 'b' });
    addMessage(db, { roomId, authorId: 'x', authorKind: 'human', text: 'c' });
    const after = listMessagesAfter(db, roomId, a.createdAt);
    expect(after.map((m) => m.text)).toEqual(['b', 'c']);
  });

  it('persists queued human-message delivery state', () => {
    const queued = addMessage(db, {
      roomId,
      authorId: 'human',
      authorKind: 'human',
      text: 'hold this until the agents are idle',
      deliveryStatus: 'queued',
    });
    addMessage(db, {
      roomId,
      authorId: 'claude',
      authorKind: 'agent',
      text: 'working',
      deliveryStatus: 'queued',
    });

    expect(listQueuedHumanMessages(db, roomId).map((message) => message.id)).toEqual([queued.id]);
    expect(listMessages(db, roomId)[0]).toMatchObject({ deliveryStatus: 'queued' });
    expect(updateMessageDeliveryStatus(db, queued.id, 'delivered')).toMatchObject({
      id: queued.id,
      deliveryStatus: 'delivered',
    });
    expect(listQueuedHumanMessages(db, roomId)).toEqual([]);
  });
});
