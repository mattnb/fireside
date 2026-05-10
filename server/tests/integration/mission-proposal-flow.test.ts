// server/tests/integration/mission-proposal-flow.test.ts
//
// Full Idea → clarify → AC → propose → approve → execute → dual-path verify
// → done loop for the proposal-gate work. Exercises the MCP tool surface
// (clarify/acceptance/propose/verify) and the HTTP human-approval route in
// a single test against an in-memory DB.

import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { Broker } from '../../src/broker.js';
import { buildHttpServer } from '../../src/http-server.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask, getTask } from '../../src/repos/tasks.js';
import { createTaskChecklistItem, updateTaskChecklistItem } from '../../src/repos/task-checklist.js';
import { listClarifyingQuestions } from '../../src/repos/clarifying-questions.js';
import { listAcceptanceCriteria } from '../../src/repos/acceptance-criteria.js';
import { executeToolCall } from '../../src/tools/execute-tool-call.js';
import { defaultToolRegistry } from '../../src/tools/registry.js';
import { ensureDefaultToolsRegistered } from '../../src/tools/default-tools.js';
import { applySingleReceipt } from '../../src/mission-state/mission-receipt-applicator.js';
import type { AgentToolCall } from '../../src/tools/types.js';

ensureDefaultToolsRegistered();

function call(overrides: Partial<AgentToolCall> & { tool: string; idempotencyKey: string }): AgentToolCall {
  return {
    id: `call-${overrides.idempotencyKey}`,
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

describe('mission proposal flow (end-to-end)', () => {
  const db = openDatabase(':memory:');
  const broker = new Broker({
    db,
    getSpec: () => undefined,
    runAgent: async () => ({ text: '', sessionId: '', raw: { stdout: '', stderr: '' } }),
  });
  const app = buildHttpServer({
    db,
    broker,
    uiDir: 'C:/tmp/ui-not-real',
    mcpApiKey: null,
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('drives a task from draft → done through every gate', async () => {
    // 1. Lead seeds a draft task with two ACs.
    const room = createRoom(db, { name: 'mission', agents: ['claude', 'codex'] });
    const task = createTask(db, {
      roomId: room.id,
      title: 'Add proposal gate',
      proposalStatus: 'draft',
    });

    expect(getTask(db, task.id)?.proposalStatus).toBe('draft');

    // 2. Lead asks a clarifying question — task should remain in draft (PR 1
    //    didn't auto-bump). Open question count is 1.
    const ask1 = await executeToolCall({
      db,
      registry: defaultToolRegistry,
      call: call({
        roomId: room.id,
        tool: 'mission.clarify.ask',
        idempotencyKey: 'ask-1',
        args: { question: 'one PR or two?', category: 'scope' },
      }),
      statePermissions: ['mission:write'],
      now: () => 1,
    });
    expect(ask1.status).toBe('applied');
    const questions = listClarifyingQuestions(db, task.id);
    expect(questions).toHaveLength(1);

    // 3. mission.propose.submit must reject because the question is open.
    const proposeBlocked = await executeToolCall({
      db,
      registry: defaultToolRegistry,
      call: call({
        roomId: room.id,
        tool: 'mission.propose.submit',
        idempotencyKey: 'propose-blocked',
        args: {},
      }),
      statePermissions: ['mission:write'],
      now: () => 2,
    });
    expect(proposeBlocked.status).toBe('rejected');
    expect(proposeBlocked.summary).toMatch(/unanswered/);

    // 4. Human answers via HTTP.
    const answerRes = await app.inject({
      method: 'POST',
      url: `/api/clarifying-questions/${questions[0]!.id}/answer`,
      remoteAddress: '127.0.0.1',
      payload: { answer: 'one PR — it is logically atomic' },
    });
    expect(answerRes.statusCode).toBe(200);

    // 5. Lead creates the ACs.
    const ac1 = await executeToolCall({
      db,
      registry: defaultToolRegistry,
      call: call({
        roomId: room.id,
        tool: 'mission.acceptance.create',
        idempotencyKey: 'ac-1',
        args: { title: 'gate blocks workers' },
      }),
      statePermissions: ['mission:write'],
      now: () => 3,
    });
    const ac2 = await executeToolCall({
      db,
      registry: defaultToolRegistry,
      call: call({
        roomId: room.id,
        tool: 'mission.acceptance.create',
        idempotencyKey: 'ac-2',
        args: { title: 'lead bypasses gate' },
      }),
      statePermissions: ['mission:write'],
      now: () => 4,
    });
    expect(ac1.status).toBe('applied');
    expect(ac2.status).toBe('applied');
    const ac1Id = (ac1.result?.data as { acId: string }).acId;
    const ac2Id = (ac2.result?.data as { acId: string }).acId;

    // 6. mission.propose.submit now succeeds: draft → proposed.
    const proposed = await executeToolCall({
      db,
      registry: defaultToolRegistry,
      call: call({
        roomId: room.id,
        tool: 'mission.propose.submit',
        idempotencyKey: 'propose-1',
        args: {},
      }),
      statePermissions: ['mission:write'],
      now: () => 5,
    });
    expect(proposed.status).toBe('applied');
    expect(getTask(db, task.id)?.proposalStatus).toBe('proposed');
    expect(getTask(db, task.id)?.proposedByAgentId).toBe('claude');

    // 7. Human approves via HTTP.
    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/approve`,
      remoteAddress: '127.0.0.1',
      payload: {},
    });
    expect(approveRes.statusCode).toBe(200);
    expect(getTask(db, task.id)?.proposalStatus).toBe('approved');

    // 8. Worker creates checklist items linked to the ACs and closes them
    //    via mission.receipt.submit. The receipt fan-out records doer-passes.
    const item1 = createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'wire gate',
      acceptanceRef: ac1Id,
    });
    const item2 = createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'lead bypass',
      acceptanceRef: ac2Id,
    });

    applySingleReceipt({
      db,
      roomId: room.id,
      task: getTask(db, task.id)!,
      runId: 'run-1',
      agentId: 'claude',
      receipt: {
        status: 'completed',
        itemRef: item1.id,
        phaseRef: '',
        planRef: '',
        summary: 'gate works',
        evidence: 'unit tests green',
        next: '',
      },
      recordRunAction: () => {},
    });
    // Closing the second item → all items closed → verifying.
    applySingleReceipt({
      db,
      roomId: room.id,
      task: getTask(db, task.id)!,
      runId: 'run-1',
      agentId: 'claude',
      receipt: {
        status: 'completed',
        itemRef: item2.id,
        phaseRef: '',
        planRef: '',
        summary: 'lead bypass works',
        evidence: 'tests green',
        next: '',
      },
      recordRunAction: () => {},
    });

    // After both items are closed via 'completed' receipts, doer-pass on both
    // ACs is recorded. Since not all ACs have verifier-pass, status is
    // verifying.
    expect(getTask(db, task.id)?.proposalStatus).toBe('verifying');
    const acs = listAcceptanceCriteria(db, task.id);
    expect(acs.every((ac) => ac.doerCheckStatus === 'pass')).toBe(true);
    expect(acs.every((ac) => ac.verifierCheckStatus === 'pending')).toBe(true);

    // 9. Verifier (different agent) records pass on both ACs via mission.verify.
    for (const acId of [ac1Id, ac2Id]) {
      const v = await executeToolCall({
        db,
        registry: defaultToolRegistry,
        call: call({
          roomId: room.id,
          tool: 'mission.verify',
          idempotencyKey: `verify-${acId}`,
          agentId: 'codex',
          args: {
            side: 'verifier',
            acId,
            status: 'pass',
            evidence: 'reviewed independently',
          },
        }),
        statePermissions: ['mission:write'],
        now: () => 9,
      });
      expect(v.status).toBe('applied');
    }

    // 10. Status auto-advances to done once both ACs have both sides pass.
    expect(getTask(db, task.id)?.proposalStatus).toBe('done');
  });
});
