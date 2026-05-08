import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { addMessage } from '../../src/repos/messages.js';
import { createAgentRun } from '../../src/repos/agent-runs.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { createTaskChecklistItem } from '../../src/repos/task-checklist.js';
import { createTaskPhase, listTaskPhases } from '../../src/repos/task-phases.js';
import { listTaskPlans } from '../../src/repos/task-plans.js';
import { extractMissionPhaseUpdates } from '../../src/mission-phase-updates.js';
import { extractMissionPlanUpdates } from '../../src/mission-plan-updates.js';
import {
  routeMissionPhaseUpdates,
  routeMissionPlanUpdates,
} from '../../src/tools/adapters/hidden-command-adapter.js';
import { executeToolCall } from '../../src/tools/execute-tool-call.js';
import { missionPhaseCompleteTool } from '../../src/tools/handlers/mission-phase-tools.js';
import { createToolRegistry } from '../../src/tools/registry.js';

describe('mission plan and phase tools', () => {
  it('routes /mission-plan creation through the tool engine with audit', async () => {
    const { db, roomId, runId, task } = testContext();
    const extracted = extractMissionPlanUpdates(
      [
        '/mission-plan',
        'action: create',
        'title: Tool Layer Plan',
        'body:',
        'Ship phase and plan tools.',
        '/end-mission-plan',
      ].join('\n'),
    );

    const outcome = await routeMissionPlanUpdates(
      {
        db,
        roomId,
        mission: task,
        runId,
        agentId: 'codex',
        permission: yoloGrant(),
      },
      extracted.updates,
    );

    expect(outcome.toolCalls).toMatchObject([
      { toolName: 'mission.plan.create', status: 'applied' },
    ]);
    expect(listTaskPlans(db, task.id)).toMatchObject([
      { title: 'Tool Layer Plan', body: 'Ship phase and plan tools.', status: 'active' },
    ]);
    expect(auditRows(db)).toMatchObject([
      { tool_name: 'mission.plan.create', source: 'hidden-command', status: 'applied' },
    ]);
    db.close();
  });

  it('decodes /mission-phase status done to mission.phase.complete and preserves blocker validation', async () => {
    const { db, roomId, runId, task } = testContext();
    const phase = createTaskPhase(db, {
      taskId: task.id,
      title: 'Build',
      status: 'active',
      sortOrder: 1,
    });
    createTaskChecklistItem(db, {
      taskId: task.id,
      phaseId: phase.id,
      title: 'Finish the handler',
      status: 'open',
    });
    const extracted = extractMissionPhaseUpdates(
      [
        '/mission-phase',
        'action: update',
        `id: ${phase.id}`,
        'status: done',
        '/end-mission-phase',
      ].join('\n'),
    );

    const outcome = await routeMissionPhaseUpdates(
      {
        db,
        roomId,
        mission: task,
        runId,
        agentId: 'codex',
        permission: yoloGrant(),
        defaultPlanId: null,
        forcePlanOnUpdates: false,
      },
      extracted.updates,
    );

    expect(outcome.toolCalls).toMatchObject([
      {
        toolName: 'mission.phase.complete',
        status: 'rejected',
        summary: expect.stringContaining('Finish the handler'),
      },
    ]);
    expect(listTaskPhases(db, task.id)).toMatchObject([{ id: phase.id, status: 'active' }]);
    expect(auditRows(db)).toMatchObject([
      { tool_name: 'mission.phase.complete', source: 'hidden-command', status: 'rejected' },
    ]);
    db.close();
  });

  it('audits legacy /mission-phase completion with the hidden-command fallback permission source', async () => {
    const { db, roomId, runId, task } = testContext();
    const phase = createTaskPhase(db, {
      taskId: task.id,
      title: 'Verify',
      status: 'active',
      sortOrder: 1,
    });
    const extracted = extractMissionPhaseUpdates(
      [
        '/mission-phase',
        'action: update',
        `id: ${phase.id}`,
        'status: done',
        '/end-mission-phase',
      ].join('\n'),
    );

    const outcome = await routeMissionPhaseUpdates(
      {
        db,
        roomId,
        mission: task,
        runId,
        agentId: 'codex',
        permission: null,
        defaultPlanId: null,
        forcePlanOnUpdates: false,
      },
      extracted.updates,
    );

    expect(outcome.toolCalls).toMatchObject([
      { toolName: 'mission.phase.complete', status: 'applied' },
    ]);
    expect(listTaskPhases(db, task.id)).toMatchObject([{ id: phase.id, status: 'done' }]);

    const rows = auditRows(db) as Array<{ tool_name: string; source: string; status: string; result_json: string }>;
    expect(rows).toMatchObject([
      { tool_name: 'mission.phase.complete', source: 'hidden-command', status: 'applied' },
    ]);
    expect(JSON.parse(rows[0]!.result_json).authorization).toMatchObject({
      resolutionSource: 'hidden-command-fallback',
      required: ['mission:admin'],
      granted: expect.arrayContaining(['mission:write', 'mission:admin']),
    });
    db.close();
  });

  it('requires mission:admin for native mission.phase.complete calls', async () => {
    const { db, roomId, runId, task } = testContext();
    const phase = createTaskPhase(db, {
      taskId: task.id,
      title: 'Verify',
      status: 'active',
      sortOrder: 1,
    });
    const registry = createToolRegistry();
    registry.register(missionPhaseCompleteTool);

    const outcome = await executeToolCall({
      db,
      registry,
      call: {
        id: 'phase-complete-denied',
        tool: 'mission.phase.complete',
        idempotencyKey: `${runId}:mission.phase.complete:denied`,
        args: { phaseId: phase.id },
        source: 'replay',
        roomId,
        missionId: task.id,
        runId,
        messageId: null,
        agentId: 'codex',
        createdAt: 1,
      },
      statePermissions: ['mission:write'],
      now: () => 2,
    });

    expect(outcome).toMatchObject({
      status: 'permission_denied',
      error: 'Missing state permission: mission:admin',
    });
    expect(listTaskPhases(db, task.id)).toMatchObject([{ id: phase.id, status: 'active' }]);
    db.close();
  });
});

function testContext() {
  const db = openDatabase(':memory:');
  const room = createRoom(db, { name: 'room', agents: ['codex'] });
  const message = addMessage(db, {
    roomId: room.id,
    authorId: 'human',
    authorKind: 'human',
    text: 'start',
  });
  const task = createTask(db, { roomId: room.id, title: 'Mission' });
  const run = createAgentRun(db, {
    roomId: room.id,
    taskId: task.id,
    triggerMessageId: message.id,
    agentId: 'codex',
    permissionMode: 'full-auto',
    promptChars: 0,
    estimatedPromptTokens: 0,
    liveMessages: 0,
    contextArtifacts: 0,
  });
  return { db, roomId: room.id, task, runId: run.id };
}

function yoloGrant() {
  return {
    source: 'yolo' as const,
    mode: 'full-auto' as const,
    target: 'unrestricted filesystem',
    reason: 'test grant',
  };
}

function auditRows(db: ReturnType<typeof openDatabase>) {
  return db.prepare('SELECT * FROM agent_tool_calls ORDER BY created_at ASC, id ASC').all();
}
