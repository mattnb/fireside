// server/tests/tools/mission-propose-verify-approve-tools.test.ts
//
// PR 2 surface: end-to-end coverage of mission.propose.submit, mission.verify,
// mission.approve invoked through the executeToolCall pipeline. State-machine
// effects (gate, auto-advance) are covered by the applicator + repo tests;
// here we focus on the MCP envelope: schema parse, permission flow, and
// effect emission.

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom, setRoomApproverAgentIds } from '../../src/repos/rooms.js';
import { createTask, getTask } from '../../src/repos/tasks.js';
import { createAcceptanceCriterion } from '../../src/repos/acceptance-criteria.js';
import { createClarifyingQuestion } from '../../src/repos/clarifying-questions.js';
import { executeToolCall } from '../../src/tools/execute-tool-call.js';
import { missionApproveTool } from '../../src/tools/handlers/mission-approve-tools.js';
import { missionProposeSubmitTool } from '../../src/tools/handlers/mission-propose-tools.js';
import { missionVerifyTool } from '../../src/tools/handlers/mission-verify-tools.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import type { AgentToolCall } from '../../src/tools/types.js';

function call(overrides: Partial<AgentToolCall>): AgentToolCall {
  return {
    id: `call-${overrides.idempotencyKey ?? 'k'}`,
    tool: overrides.tool ?? 'mission.propose.submit',
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
  const room = createRoom(db, { name: 'r', agents: ['claude', 'codex'] });
  const registry = createToolRegistry();
  registry.register(missionProposeSubmitTool);
  registry.register(missionVerifyTool);
  registry.register(missionApproveTool);
  return { db, roomId: room.id, registry };
}

describe('mission.propose.submit', () => {
  it('promotes elaborating → proposed when questions are answered and ACs exist', async () => {
    const { db, roomId, registry } = ctx();
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'elaborating' });
    createAcceptanceCriterion(db, { taskId: task.id, title: 'AC' });

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.propose.submit',
        idempotencyKey: 'p1',
        args: {},
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    expect(outcome.status).toBe('applied');
    expect(getTask(db, task.id)?.proposalStatus).toBe('proposed');
    expect(getTask(db, task.id)?.proposedByAgentId).toBe('claude');
    db.close();
  });

  it('rejects when there are no acceptance criteria', async () => {
    const { db, roomId, registry } = ctx();
    createTask(db, { roomId, title: 't', proposalStatus: 'elaborating' });

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.propose.submit',
        idempotencyKey: 'p2',
        args: {},
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toMatch(/at least one acceptance criterion/);
    db.close();
  });

  it('rejects when clarifying questions are unanswered', async () => {
    const { db, roomId, registry } = ctx();
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'elaborating' });
    createAcceptanceCriterion(db, { taskId: task.id, title: 'AC' });
    createClarifyingQuestion(db, {
      taskId: task.id,
      askedByAgentId: 'claude',
      question: 'one PR or two?',
    });

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.propose.submit',
        idempotencyKey: 'p3',
        args: {},
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toMatch(/unanswered/);
    db.close();
  });

  it('rejects when task is in approved/executing/etc', async () => {
    const { db, roomId, registry } = ctx();
    createTask(db, { roomId, title: 't', proposalStatus: 'approved' });

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.propose.submit',
        idempotencyKey: 'p4',
        args: {},
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toMatch(/not elaborating\/draft/);
    db.close();
  });
});

describe('mission.verify', () => {
  it('records a verifier-side check by a different agent', async () => {
    const { db, roomId, registry } = ctx();
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'verifying' });
    const ac = createAcceptanceCriterion(db, { taskId: task.id, title: 'AC' });

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.verify',
        idempotencyKey: 'v1',
        agentId: 'codex',
        args: {
          side: 'verifier',
          acId: ac.id,
          status: 'pass',
          evidence: 'ran the harness independently',
        },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    expect(outcome.status).toBe('applied');
    db.close();
  });

  it('rejects same-agent verifier check', async () => {
    const { db, roomId, registry } = ctx();
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'verifying' });
    const ac = createAcceptanceCriterion(db, { taskId: task.id, title: 'AC' });

    // doer pass first
    await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.verify',
        idempotencyKey: 'd1',
        agentId: 'claude',
        args: { side: 'doer', acId: ac.id, status: 'pass', evidence: 'd' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    // same agent tries verifier pass
    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.verify',
        idempotencyKey: 'v-same',
        agentId: 'claude',
        args: { side: 'verifier', acId: ac.id, status: 'pass', evidence: 'self-verify' },
      }),
      statePermissions: ['mission:write'],
      now: () => 2,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toMatch(/same agent/);
    db.close();
  });

  it('rejects when AC does not exist', async () => {
    const { db, roomId, registry } = ctx();
    createTask(db, { roomId, title: 't', proposalStatus: 'verifying' });

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.verify',
        idempotencyKey: 'v-bad',
        args: { side: 'doer', acId: 'no-such', status: 'pass', evidence: 'x' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toMatch(/unknown ac/);
    db.close();
  });
});

describe('mission.approve', () => {
  it('approves when caller is in approverAgentIds', async () => {
    const { db, roomId, registry } = ctx();
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'proposed' });
    setRoomApproverAgentIds(db, roomId, ['codex']);

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.approve',
        idempotencyKey: 'a1',
        agentId: 'codex',
        args: { taskId: task.id, action: 'approve' },
      }),
      statePermissions: ['mission:admin'],
      now: () => 1,
    });

    expect(outcome.status).toBe('applied');
    expect(getTask(db, task.id)?.proposalStatus).toBe('approved');
    db.close();
  });

  it('rejects when caller is not pre-authorised', async () => {
    const { db, roomId, registry } = ctx();
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'proposed' });

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.approve',
        idempotencyKey: 'a-noauth',
        agentId: 'claude',
        args: { taskId: task.id, action: 'approve' },
      }),
      statePermissions: ['mission:admin'],
      now: () => 1,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toMatch(/not authorised/);
    db.close();
  });

  it('rejects with reason for action=reject', async () => {
    const { db, roomId, registry } = ctx();
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'proposed' });
    setRoomApproverAgentIds(db, roomId, ['codex']);

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.approve',
        idempotencyKey: 'a-reject',
        agentId: 'codex',
        args: { taskId: task.id, action: 'reject', reason: 'scope too broad' },
      }),
      statePermissions: ['mission:admin'],
      now: () => 1,
    });

    expect(outcome.status).toBe('applied');
    expect(getTask(db, task.id)?.proposalStatus).toBe('rejected');
    db.close();
  });
});
