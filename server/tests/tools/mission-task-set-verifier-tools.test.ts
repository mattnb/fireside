// server/tests/tools/mission-task-set-verifier-tools.test.ts

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import {
  createRoom,
  setRoomApproverAgentIds,
  setRoomLeadAgent,
} from '../../src/repos/rooms.js';
import { createTask, getTask } from '../../src/repos/tasks.js';
import { executeToolCall } from '../../src/tools/execute-tool-call.js';
import { missionTaskSetVerifierTool } from '../../src/tools/handlers/mission-task-set-verifier-tools.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import type { AgentToolCall } from '../../src/tools/types.js';

function call(overrides: Partial<AgentToolCall>): AgentToolCall {
  return {
    id: `call-${overrides.idempotencyKey ?? 'k'}`,
    tool: 'mission.task.set_verifier',
    idempotencyKey: overrides.idempotencyKey ?? 'k',
    args: {},
    source: 'replay',
    roomId: 'room-1',
    missionId: null,
    runId: null,
    messageId: null,
    agentId: 'claude',
    createdAt: 1,
    ...overrides,
  };
}

function ctx() {
  const db = openDatabase(':memory:');
  const room = createRoom(db, { name: 'r', agents: ['claude', 'codex', 'gemini'] });
  setRoomLeadAgent(db, room.id, 'claude');
  const task = createTask(db, { roomId: room.id, title: 't', proposalStatus: 'approved' });
  const registry = createToolRegistry();
  registry.register(missionTaskSetVerifierTool);
  return { db, roomId: room.id, taskId: task.id, registry };
}

describe('mission.task.set_verifier', () => {
  it('lead can assign a verifier', async () => {
    const { db, roomId, taskId, registry } = ctx();
    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        idempotencyKey: 'set-1',
        agentId: 'claude',
        args: { taskId, verifierAgentId: 'codex' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });
    expect(outcome.status).toBe('applied');
    expect(getTask(db, taskId)?.verifierAgentId).toBe('codex');
    db.close();
  });

  it('null clears the verifier (humans verify)', async () => {
    const { db, roomId, taskId, registry } = ctx();
    // Set first.
    await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        idempotencyKey: 'set-pre',
        agentId: 'claude',
        args: { taskId, verifierAgentId: 'codex' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });
    expect(getTask(db, taskId)?.verifierAgentId).toBe('codex');

    // Clear.
    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        idempotencyKey: 'set-clear',
        agentId: 'claude',
        args: { taskId, verifierAgentId: null },
      }),
      statePermissions: ['mission:write'],
      now: () => 2,
    });
    expect(outcome.status).toBe('applied');
    expect(getTask(db, taskId)?.verifierAgentId).toBeNull();
    db.close();
  });

  it('rejects when caller is neither lead nor approver nor human', async () => {
    const { db, roomId, taskId, registry } = ctx();
    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        idempotencyKey: 'set-noauth',
        agentId: 'gemini',
        args: { taskId, verifierAgentId: 'codex' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });
    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toMatch(/neither the lead nor an approver/);
    db.close();
  });

  it('approver agents can assign', async () => {
    const { db, roomId, taskId, registry } = ctx();
    setRoomApproverAgentIds(db, roomId, ['gemini']);
    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        idempotencyKey: 'set-approver',
        agentId: 'gemini',
        args: { taskId, verifierAgentId: 'codex' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });
    expect(outcome.status).toBe('applied');
    expect(getTask(db, taskId)?.verifierAgentId).toBe('codex');
    db.close();
  });

  it('rejects assigning the lead', async () => {
    const { db, roomId, taskId, registry } = ctx();
    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        idempotencyKey: 'set-self',
        agentId: 'claude',
        args: { taskId, verifierAgentId: 'claude' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });
    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toMatch(/lead cannot self-verify/);
    db.close();
  });

  it('rejects assigning a non-room-member', async () => {
    const { db, roomId, taskId, registry } = ctx();
    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        idempotencyKey: 'set-stranger',
        agentId: 'claude',
        args: { taskId, verifierAgentId: 'someone-else' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });
    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toMatch(/not a member of the room/);
    db.close();
  });

  it('defaults to the active task when taskId is omitted', async () => {
    const { db, roomId, taskId, registry } = ctx();
    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        idempotencyKey: 'set-active',
        agentId: 'claude',
        args: { verifierAgentId: 'codex' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });
    expect(outcome.status).toBe('applied');
    expect(getTask(db, taskId)?.verifierAgentId).toBe('codex');
    db.close();
  });
});
