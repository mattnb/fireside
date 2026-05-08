import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/db.js';
import { createTask, getTask } from '../../../src/repos/tasks.js';
import { createTaskChecklistItem } from '../../../src/repos/task-checklist.js';
import {
  routeMissionTaskUpdates,
  ensureMissionTaskToolsRegistered,
} from '../../../src/tools/adapters/slash-block-adapter.js';
import { buildPermissionGrant, type PermissionGrant } from '../../../src/permissions.js';
import type { ParsedMissionTaskUpdate } from '../../../src/mission-task-updates.js';

describe('routeMissionTaskUpdates permission plumbing', () => {
  it('applies a /mission-task update when the run carries no permission grant (baseline fallback)', async () => {
    ensureMissionTaskToolsRegistered();
    const { db, mission, item } = seedMissionWithItem();

    const outcome = await routeMissionTaskUpdates(
      {
        db,
        roomId: 'room-1',
        mission,
        runId: 'run-baseline',
        agentId: 'codex',
        permission: null,
        defaultPlanId: null,
        forcePlanOnUpdates: false,
        recordRunAction: () => undefined,
      },
      [updateBlock(item.id, 'done')],
    );

    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]).toMatchObject({
      toolName: 'mission.task.update',
      status: 'applied',
    });
    expect(outcome.result.applied).toBeGreaterThan(0);

    const auditRows = db
      .prepare('SELECT status FROM agent_tool_calls WHERE run_id = ?')
      .all('run-baseline') as { status: string }[];
    expect(auditRows.map((row) => row.status)).toEqual(['applied']);
    db.close();
  });

  it('denies a /mission-task update under a plan-mode permission grant', async () => {
    ensureMissionTaskToolsRegistered();
    const { db, mission, item } = seedMissionWithItem();
    const planGrant = buildPermissionGrant({
      agentId: 'codex',
      source: 'task',
      mode: 'plan',
      target: 'C:/work/project',
      reason: 'plan-mode test grant',
    });

    const outcome = await routeMissionTaskUpdates(
      {
        db,
        roomId: 'room-1',
        mission,
        runId: 'run-plan',
        agentId: 'codex',
        permission: planGrant,
        defaultPlanId: null,
        forcePlanOnUpdates: false,
        recordRunAction: () => undefined,
      },
      [updateBlock(item.id, 'done')],
    );

    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]).toMatchObject({
      toolName: 'mission.task.update',
      status: 'permission_denied',
    });
    expect(outcome.result.applied).toBe(0);

    // Item must not have been mutated.
    const auditRows = db
      .prepare('SELECT status FROM agent_tool_calls WHERE run_id = ?')
      .all('run-plan') as { status: string }[];
    expect(auditRows.map((row) => row.status)).toEqual(['permission_denied']);
    db.close();
  });

  it('applies under an edit-mode permission grant', async () => {
    ensureMissionTaskToolsRegistered();
    const { db, mission, item } = seedMissionWithItem();
    const editGrant: PermissionGrant = buildPermissionGrant({
      agentId: 'codex',
      source: 'task',
      mode: 'edit',
      target: 'C:/work/project',
      reason: 'edit-mode test grant',
    });

    const outcome = await routeMissionTaskUpdates(
      {
        db,
        roomId: 'room-1',
        mission,
        runId: 'run-edit',
        agentId: 'codex',
        permission: editGrant,
        defaultPlanId: null,
        forcePlanOnUpdates: false,
        recordRunAction: () => undefined,
      },
      [updateBlock(item.id, 'done')],
    );

    expect(outcome.toolCalls[0]).toMatchObject({
      toolName: 'mission.task.update',
      status: 'applied',
    });
    db.close();
  });
});

function seedMissionWithItem() {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO rooms (id, name, created_at, agents_json, yolo_agents_json)
     VALUES ('room-1', 'room', 1, '[]', '[]')`,
  ).run();
  const mission = createTask(db, {
    roomId: 'room-1',
    title: 'plan-mode mission',
    capabilityProfile: 'plan',
  });
  const item = createTaskChecklistItem(db, {
    taskId: mission.id,
    title: 'something to do',
    status: 'open',
    sortOrder: 1,
  });
  for (const runId of ['run-baseline', 'run-plan', 'run-edit']) {
    db.prepare(
      `INSERT INTO agent_runs (
        id, room_id, task_id, trigger_message_id, agent_id, status, permission_mode,
        prompt_chars, estimated_prompt_tokens, live_messages, context_artifacts, started_at
      ) VALUES (?, 'room-1', ?, 'trigger-msg', 'codex', 'completed', 'full-auto',
        0, 0, 0, 0, 1)`,
    ).run(runId, mission.id);
  }
  const refreshed = getTask(db, mission.id);
  if (!refreshed) throw new Error('mission seed failed');
  return { db, mission: refreshed, item };
}

function updateBlock(itemId: string, status: 'done' | 'open' | 'blocked'): ParsedMissionTaskUpdate {
  return {
    action: 'update',
    id: itemId,
    title: '',
    detail: '',
    status,
    dependencyRefs: [],
    expectedTouches: [],
    parallelism: null,
    conflictGroup: '',
    workRole: '',
    ownerAgentId: '',
    statusNote: 'test update',
    blockedReason: '',
    councilRequired: null,
    noteKind: 'status',
    note: 'test update',
    planRef: '',
    phaseRef: '',
  };
}
