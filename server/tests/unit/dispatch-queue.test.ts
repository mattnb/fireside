import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { addMessage } from '../../src/repos/messages.js';
import {
  createDispatchQueueItems,
  cancelLeasedDispatchQueueItemsForAgentTrigger,
  firstPendingDispatchQueueItemForAgent,
  getDispatchQueueItem,
  leaseDispatchQueueItem,
  listPendingDispatchQueueItemsForRoom,
  markDispatchQueueItemDelivered,
  recoverOrphanedLeasedDispatchQueueItems,
} from '../../src/repos/dispatch-queue.js';
import { createAgentRun, updateAgentRun } from '../../src/repos/agent-runs.js';
import { attachAgentJobRun, createAgentJob, leaseAgentJob } from '../../src/repos/agent-jobs.js';

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

  it('recovers a leased dispatch when no active run or job owns it', () => {
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
    leaseDispatchQueueItem(db, { id: item!.id, leaseOwner: 'fireside:old', leaseMs: 15 * 60_000 });

    const recovered = recoverOrphanedLeasedDispatchQueueItems(db, { roomId: room.id, now: 1234 });

    expect(recovered).toBe(1);
    expect(firstPendingDispatchQueueItemForAgent(db, { roomId: room.id, agentId: 'claude', now: 1234 }))
      .toMatchObject({
        id: item!.id,
        status: 'pending',
        leaseOwner: '',
        leaseExpiresAt: 0,
      });
  });

  it('settles a leased dispatch as delivered when its provider run already ended', () => {
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
    leaseDispatchQueueItem(db, { id: item!.id, leaseOwner: 'fireside:old', leaseMs: 15 * 60_000 });
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
    updateAgentRun(db, run.id, {
      status: 'failed',
      completedAt: 1200,
      error: 'interrupted',
      lifecycleState: 'canceled_by_reconciliation',
      lifecycleReason: 'interrupted',
    });

    const recovered = recoverOrphanedLeasedDispatchQueueItems(db, { roomId: room.id, now: 1234 });
    const settled = getDispatchQueueItem(db, item!.id);

    expect(recovered).toBe(1);
    expect(settled).toMatchObject({
      status: 'delivered',
      deliveredRunId: run.id,
      leaseOwner: '',
      leaseExpiresAt: 0,
    });
    expect(listPendingDispatchQueueItemsForRoom(db, room.id, 1234)).toEqual([]);
  });

  it('does not recover a leased dispatch while a matching agent job is active', () => {
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
    leaseDispatchQueueItem(db, { id: item!.id, leaseOwner: 'fireside:live', leaseMs: 15 * 60_000 });
    const job = createAgentJob(db, {
      roomId: room.id,
      agentId: 'claude',
      triggerMessageId: message.id,
    });
    leaseAgentJob(db, job.id, { leaseOwner: 'fireside:live', leaseMs: 15 * 60_000 });

    const recovered = recoverOrphanedLeasedDispatchQueueItems(db, { roomId: room.id, now: 1234 });

    expect(recovered).toBe(0);
    expect(listPendingDispatchQueueItemsForRoom(db, room.id, 1234)).toEqual([]);
  });

  it('does not recover a leased dispatch while a matching agent run is active', () => {
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
    leaseDispatchQueueItem(db, { id: item!.id, leaseOwner: 'fireside:live', leaseMs: 15 * 60_000 });
    const job = createAgentJob(db, {
      roomId: room.id,
      agentId: 'claude',
      triggerMessageId: message.id,
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
    attachAgentJobRun(db, job.id, run.id, {
      leaseOwner: 'fireside:live',
      leaseMs: 15 * 60_000,
    });

    const recovered = recoverOrphanedLeasedDispatchQueueItems(db, { roomId: room.id, now: 1234 });

    expect(recovered).toBe(0);
    expect(listPendingDispatchQueueItemsForRoom(db, room.id, 1234)).toEqual([]);
  });

  it('cancels a leased dispatch when its run is explicitly stopped by the user', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'g', agents: ['claude'] });
    const message = addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: '@claude stop after this',
    });
    const [item] = createDispatchQueueItems(db, {
      roomId: room.id,
      sourceMessageId: message.id,
      authorId: 'human',
      targetKind: 'agent',
      targetIds: ['claude'],
      kind: 'chat-message',
    });
    leaseDispatchQueueItem(db, { id: item!.id, leaseOwner: 'fireside:live', leaseMs: 15 * 60_000 });

    const canceled = cancelLeasedDispatchQueueItemsForAgentTrigger(db, {
      roomId: room.id,
      agentId: 'claude',
      sourceMessageId: message.id,
      reason: 'human stopped this run',
      now: 1234,
    });
    const recovered = recoverOrphanedLeasedDispatchQueueItems(db, { roomId: room.id, now: 1235 });

    expect(canceled).toBe(1);
    expect(recovered).toBe(0);
    expect(listPendingDispatchQueueItemsForRoom(db, room.id, 1235)).toEqual([]);
  });
});
