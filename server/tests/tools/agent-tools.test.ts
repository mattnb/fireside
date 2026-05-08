import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom, getRoom } from '../../src/repos/rooms.js';
import { listPendingDispatchQueueItemsForRoom } from '../../src/repos/dispatch-queue.js';
import { addMessage } from '../../src/repos/messages.js';
import { listMessageReadReceiptsForRoom } from '../../src/repos/message-read-receipts.js';
import { createTaskChecklistItem } from '../../src/repos/task-checklist.js';
import { executeToolCall } from '../../src/tools/execute-tool-call.js';
import {
  agentAckMessageTool,
  agentCheckinTool,
  agentListAssignmentsTool,
  agentRequestTurnsTool,
  agentSetStatusTool,
} from '../../src/tools/handlers/agent-tools.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import type { AgentToolCall } from '../../src/tools/types.js';

describe('agent tools', () => {
  it('agent.checkin returns optional assignments and can update caller status', async () => {
    const { db, roomId, registry } = testContext();
    const assigned = createTaskChecklistItem(db, {
      taskId: 'mission-1',
      title: 'Implement checkin',
      ownerAgentId: 'codex',
      status: 'open',
    });
    createTaskChecklistItem(db, {
      taskId: 'mission-1',
      title: 'Review checkin',
      ownerAgentId: 'claude',
      status: 'open',
    });

    const outcome = await executeToolCall({
      db,
      registry,
      call: testCall({
        roomId,
        tool: 'agent.checkin',
        idempotencyKey: 'checkin-1',
        args: { includeAssignments: true, status: 'active', reason: 'working the agent namespace' },
      }),
      statePermissions: ['agent:write-self'],
      now: () => 1233,
    });

    expect(outcome).toMatchObject({ status: 'applied' });
    expect(outcome.result?.data).toMatchObject({
      agentId: 'codex',
      status: 'active',
      assignments: {
        missionId: 'mission-1',
        checklistItems: [{ id: assigned.id, title: 'Implement checkin' }],
      },
    });
    const profile = getRoom(db, roomId)?.agentProfiles.find((candidate) => candidate.id === 'codex');
    expect(profile).toMatchObject({ status: 'active', statusReason: 'working the agent namespace' });
    db.close();
  });

  it('agent.set_status persists the caller runtime status on the room profile', async () => {
    const { db, roomId, registry } = testContext();

    const outcome = await executeToolCall({
      db,
      registry,
      call: testCall({
        roomId,
        tool: 'agent.set_status',
        idempotencyKey: 'set-status-1',
        args: { status: 'blocked', reason: 'waiting on review' },
      }),
      statePermissions: ['agent:write-self'],
      now: () => 1234,
    });

    expect(outcome).toMatchObject({ status: 'applied' });
    const profile = getRoom(db, roomId)?.agentProfiles.find((candidate) => candidate.id === 'codex');
    expect(profile).toMatchObject({
      status: 'blocked',
      statusReason: 'waiting on review',
      statusUpdatedAt: 1234,
    });
    db.close();
  });

  it('agent.set_status requires coordination permission for another target agent', async () => {
    const { db, roomId, registry } = testContext();

    const outcome = await executeToolCall({
      db,
      registry,
      call: testCall({
        roomId,
        tool: 'agent.set_status',
        idempotencyKey: 'set-status-denied',
        args: { agentId: 'claude', status: 'offline' },
      }),
      statePermissions: ['agent:write-self'],
      now: () => 1235,
    });

    expect(outcome).toMatchObject({
      status: 'permission_denied',
      error: 'agent.set_status for another agent requires agent:coordinate',
    });
    const profile = getRoom(db, roomId)?.agentProfiles.find((candidate) => candidate.id === 'claude');
    expect(profile?.status).toBeUndefined();
    db.close();
  });

  it('agent.request_turns creates dispatch queue work for resolved room agents', async () => {
    const { db, roomId, registry } = testContext();

    const outcome = await executeToolCall({
      db,
      registry,
      call: testCall({
        roomId,
        tool: 'agent.request_turns',
        idempotencyKey: 'request-turns-1',
        args: { agents: ['claude'], reason: 'review the status handler', priority: 10 },
      }),
      statePermissions: ['agent:coordinate'],
      now: () => 1236,
    });

    expect(outcome).toMatchObject({ status: 'applied' });
    expect(outcome.result?.effects).toMatchObject([
      {
        kind: 'agent-dispatch-requested',
        targetType: 'agent',
        targetId: 'claude',
      },
    ]);
    expect(listPendingDispatchQueueItemsForRoom(db, roomId)).toMatchObject([
      {
        authorId: 'codex',
        targetKind: 'agent',
        targetId: 'claude',
        kind: 'agent-handoff',
        priority: 10,
      },
    ]);
    db.close();
  });

  it('agent.list_assignments returns the target open checklist work without mutating state', async () => {
    const { db, roomId, registry } = testContext();
    const open = createTaskChecklistItem(db, {
      taskId: 'mission-1',
      title: 'Owned open work',
      ownerAgentId: 'claude',
      status: 'open',
    });
    createTaskChecklistItem(db, {
      taskId: 'mission-1',
      title: 'Owned completed work',
      ownerAgentId: 'claude',
      status: 'done',
    });

    const outcome = await executeToolCall({
      db,
      registry,
      call: testCall({
        roomId,
        tool: 'agent.list_assignments',
        idempotencyKey: 'list-assignments-1',
        args: { agentId: 'claude' },
      }),
      statePermissions: ['mission:read'],
      now: () => 1237,
    });

    expect(outcome).toMatchObject({ status: 'applied' });
    expect(outcome.result?.data).toMatchObject({
      agentId: 'claude',
      missionId: 'mission-1',
      checklistItems: [{ id: open.id, title: 'Owned open work' }],
    });
    expect((outcome.result?.data as { checklistItems: unknown[] }).checklistItems).toHaveLength(1);
    db.close();
  });

  it('agent.ack_message records durable read receipts for non-self messages', async () => {
    const { db, roomId, registry } = testContext();
    const humanMessage = addMessage(db, {
      roomId,
      authorId: 'human',
      authorKind: 'human',
      text: '@codex please ack',
    });
    const selfMessage = addMessage(db, {
      roomId,
      authorId: 'codex',
      authorKind: 'agent',
      text: 'self authored',
    });

    const outcome = await executeToolCall({
      db,
      registry,
      call: testCall({
        roomId,
        tool: 'agent.ack_message',
        idempotencyKey: 'ack-1',
        args: { messageIds: [humanMessage.id, selfMessage.id] },
      }),
      statePermissions: ['agent:write-self'],
      now: () => 1238,
    });

    expect(outcome).toMatchObject({ status: 'applied' });
    expect(outcome.result?.data).toMatchObject({ acknowledgedMessageIds: [humanMessage.id] });
    expect(listMessageReadReceiptsForRoom(db, roomId)).toMatchObject([
      { messageId: humanMessage.id, agentId: 'codex', runId: null, seenAt: 1238 },
    ]);
    db.close();
  });
});

function testContext() {
  const db = openDatabase(':memory:');
  const room = createRoom(db, {
    name: 'room',
    agents: ['codex', 'claude'],
    yoloAgents: [],
  });
  db.prepare(
    `INSERT INTO tasks (
      id, room_id, title, goal, repo_path, acceptance_criteria, agents_json, status,
      capability_profile, summary, created_at, updated_at
    ) VALUES ('mission-1', ?, 'mission', '', '', '', '[]', 'active', 'full-auto', '', 1, 1)`,
  ).run(room.id);
  const registry = createToolRegistry();
  registry.register(agentCheckinTool);
  registry.register(agentSetStatusTool);
  registry.register(agentListAssignmentsTool);
  registry.register(agentAckMessageTool);
  registry.register(agentRequestTurnsTool);
  return { db, roomId: room.id, registry };
}

function testCall(overrides: Partial<AgentToolCall>): AgentToolCall {
  return {
    id: `call-${overrides.idempotencyKey ?? 'test'}`,
    tool: 'agent.set_status',
    idempotencyKey: 'test-key',
    args: {},
    source: 'replay',
    roomId: 'room-1',
    missionId: 'mission-1',
    runId: null,
    messageId: null,
    agentId: 'codex',
    createdAt: 1,
    ...overrides,
  };
}
