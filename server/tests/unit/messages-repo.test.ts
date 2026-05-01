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
import { createAgentRun } from '../../src/repos/agent-runs.js';
import {
  listMessageReadReceiptsForRoom,
  recordMessageReadReceipts,
} from '../../src/repos/message-read-receipts.js';

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

  it('attaches durable seen-by receipts to listed messages', () => {
    const human = addMessage(db, { roomId, authorId: 'human', authorKind: 'human', text: 'hi' });
    const ownAgentMessage = addMessage(db, {
      roomId,
      authorId: 'claude',
      authorKind: 'agent',
      text: 'working',
    });
    const run = createAgentRun(db, {
      roomId,
      triggerMessageId: human.id,
      agentId: 'claude',
      permissionMode: 'plan',
      promptChars: 10,
      estimatedPromptTokens: 3,
      liveMessages: 1,
      contextArtifacts: 0,
    });

    const receipts = recordMessageReadReceipts(db, {
      roomId,
      agentId: 'claude',
      runId: run.id,
      messageIds: [human.id, human.id, ownAgentMessage.id],
      seenAt: 123,
    });

    expect(receipts).toHaveLength(1);
    expect(listMessageReadReceiptsForRoom(db, roomId)).toEqual([
      expect.objectContaining({
        messageId: human.id,
        agentId: 'claude',
        runId: run.id,
        seenAt: 123,
      }),
    ]);
    expect(listMessages(db, roomId).map((message) => [message.text, message.seenBy])).toEqual([
      ['hi', ['claude']],
      ['working', []],
    ]);
  });
});
