// server/tests/tools/mission-clarify-acceptance-tools.test.ts
//
// Integration coverage for the PR 1 surface of the proposal-gate work:
// mission.clarify.{ask,answer} and mission.acceptance.{create,update,reorder}.
// State-machine effects (gate enforcement, draft → elaborating bumps) are
// PR 2 territory and not exercised here.

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { listClarifyingQuestions } from '../../src/repos/clarifying-questions.js';
import { listAcceptanceCriteria } from '../../src/repos/acceptance-criteria.js';
import { executeToolCall } from '../../src/tools/execute-tool-call.js';
import {
  missionClarifyAnswerTool,
  missionClarifyAskTool,
} from '../../src/tools/handlers/mission-clarify-tools.js';
import {
  missionAcceptanceCreateTool,
  missionAcceptanceReorderTool,
  missionAcceptanceUpdateTool,
} from '../../src/tools/handlers/mission-acceptance-tools.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import type { AgentToolCall } from '../../src/tools/types.js';

function testContext() {
  const db = openDatabase(':memory:');
  const room = createRoom(db, {
    name: 'room',
    agents: ['claude', 'codex'],
  });
  const task = createTask(db, {
    roomId: room.id,
    title: 'mission',
    proposalStatus: 'draft',
  });
  const registry = createToolRegistry();
  registry.register(missionClarifyAskTool);
  registry.register(missionClarifyAnswerTool);
  registry.register(missionAcceptanceCreateTool);
  registry.register(missionAcceptanceUpdateTool);
  registry.register(missionAcceptanceReorderTool);
  return { db, roomId: room.id, taskId: task.id, registry };
}

function call(overrides: Partial<AgentToolCall>): AgentToolCall {
  return {
    id: `call-${overrides.idempotencyKey ?? 'k'}`,
    tool: overrides.tool ?? 'mission.clarify.ask',
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

describe('mission.clarify.* tools', () => {
  it('mission.clarify.ask inserts a question against the active mission', async () => {
    const { db, roomId, taskId, registry } = testContext();

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.clarify.ask',
        idempotencyKey: 'ask-1',
        args: { question: 'one PR or two?', category: 'scope' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    expect(outcome).toMatchObject({ status: 'applied' });
    const data = outcome.result?.data as { questionId: string; category: string };
    expect(data.category).toBe('scope');

    const all = listClarifyingQuestions(db, taskId);
    expect(all).toHaveLength(1);
    expect(all[0]!.question).toBe('one PR or two?');
    expect(all[0]!.askedByAgentId).toBe('claude');
    expect(all[0]!.category).toBe('scope');
    expect(all[0]!.answer).toBe('');
    db.close();
  });

  it('mission.clarify.ask defaults the category to "general"', async () => {
    const { db, roomId, taskId, registry } = testContext();

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.clarify.ask',
        idempotencyKey: 'ask-2',
        args: { question: 'why now?' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    expect(outcome.status).toBe('applied');
    expect(listClarifyingQuestions(db, taskId)[0]!.category).toBe('general');
    db.close();
  });

  it('mission.clarify.answer fills in the answer and stamps answeredBy', async () => {
    const { db, roomId, taskId, registry } = testContext();

    const askOutcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.clarify.ask',
        idempotencyKey: 'ask-3',
        args: { question: 'do we need migrations?' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });
    const questionId = (askOutcome.result?.data as { questionId: string }).questionId;

    const answerOutcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.clarify.answer',
        idempotencyKey: 'answer-3',
        agentId: 'codex',
        args: { questionId, answer: 'yes — additive only' },
      }),
      statePermissions: ['mission:write'],
      now: () => 2,
    });

    expect(answerOutcome.status).toBe('applied');
    const list = listClarifyingQuestions(db, taskId);
    expect(list[0]!.answer).toBe('yes — additive only');
    expect(list[0]!.answeredBy).toBe('codex');
    expect(list[0]!.answeredAt).not.toBeNull();
    db.close();
  });

  it('mission.clarify.ask rejects when no active mission exists', async () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    const registry = createToolRegistry();
    registry.register(missionClarifyAskTool);

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId: room.id,
        tool: 'mission.clarify.ask',
        idempotencyKey: 'no-mission',
        args: { question: 'foo' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toMatch(/no active mission/);
    db.close();
  });

  it('mission.clarify.answer rejects unknown question ids', async () => {
    const { db, roomId, registry } = testContext();

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.clarify.answer',
        idempotencyKey: 'answer-bad',
        args: { questionId: 'nope', answer: 'whatever' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toMatch(/unknown question/);
    db.close();
  });
});

describe('mission.acceptance.* tools', () => {
  it('mission.acceptance.create appends an AC with auto-assigned sortOrder', async () => {
    const { db, roomId, taskId, registry } = testContext();

    await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.acceptance.create',
        idempotencyKey: 'ac-1',
        args: { title: 'Tests pass' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });
    await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.acceptance.create',
        idempotencyKey: 'ac-2',
        args: { title: 'Build is green' },
      }),
      statePermissions: ['mission:write'],
      now: () => 2,
    });

    const list = listAcceptanceCriteria(db, taskId);
    expect(list.map((ac) => ac.title)).toEqual(['Tests pass', 'Build is green']);
    expect(list.map((ac) => ac.sortOrder)).toEqual([0, 1]);
    db.close();
  });

  it('mission.acceptance.create honours an explicit sortOrder', async () => {
    const { db, roomId, taskId, registry } = testContext();

    await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.acceptance.create',
        idempotencyKey: 'ac-x',
        args: { title: 'Ordered', sortOrder: 7 },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    expect(listAcceptanceCriteria(db, taskId)[0]!.sortOrder).toBe(7);
    db.close();
  });

  it('mission.acceptance.update patches the AC fields', async () => {
    const { db, roomId, taskId, registry } = testContext();

    const created = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.acceptance.create',
        idempotencyKey: 'ac-create',
        args: { title: 'Old title' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });
    const acId = (created.result?.data as { acId: string }).acId;

    const updated = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.acceptance.update',
        idempotencyKey: 'ac-update',
        args: { id: acId, title: 'New title', detail: 'fresh', doer: 'codex' },
      }),
      statePermissions: ['mission:write'],
      now: () => 2,
    });

    expect(updated.status).toBe('applied');
    const list = listAcceptanceCriteria(db, taskId);
    expect(list[0]!.title).toBe('New title');
    expect(list[0]!.detail).toBe('fresh');
    expect(list[0]!.doerAgentId).toBe('codex');
    db.close();
  });

  it('mission.acceptance.update rejects unknown ids', async () => {
    const { db, roomId, registry } = testContext();
    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.acceptance.update',
        idempotencyKey: 'ac-bad',
        args: { id: 'nope', title: 'x' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toMatch(/unknown ac/);
    db.close();
  });

  it('mission.acceptance.reorder updates sortOrder', async () => {
    const { db, roomId, taskId, registry } = testContext();

    const created = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.acceptance.create',
        idempotencyKey: 'ac-r',
        args: { title: 'thing' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });
    const acId = (created.result?.data as { acId: string }).acId;

    const reorder = await executeToolCall({
      db,
      registry,
      call: call({
        roomId,
        tool: 'mission.acceptance.reorder',
        idempotencyKey: 'ac-reorder',
        args: { id: acId, sortOrder: 42 },
      }),
      statePermissions: ['mission:write'],
      now: () => 2,
    });

    expect(reorder.status).toBe('applied');
    expect(listAcceptanceCriteria(db, taskId)[0]!.sortOrder).toBe(42);
    db.close();
  });

  it('mission.acceptance.create rejects when no active mission exists', async () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    const registry = createToolRegistry();
    registry.register(missionAcceptanceCreateTool);

    const outcome = await executeToolCall({
      db,
      registry,
      call: call({
        roomId: room.id,
        tool: 'mission.acceptance.create',
        idempotencyKey: 'ac-no-mission',
        args: { title: 'thing' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toMatch(/no active mission/);
    db.close();
  });
});
