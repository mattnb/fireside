import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { createTaskPhase } from '../../src/repos/task-phases.js';
import { createTaskPlan } from '../../src/repos/task-plans.js';
import {
  listTaskChecklistItems,
  listTaskChecklistNotes,
} from '../../src/repos/task-checklist.js';
import type { CreateAgentRunActionInput } from '../../src/repos/run-actions.js';
import { applyMissionTaskUpdates } from '../../src/mission-state/mission-task-applicator.js';
import type { ParsedMissionTaskUpdate } from '../../src/mission-task-updates.js';

function update(overrides: Partial<ParsedMissionTaskUpdate> = {}): ParsedMissionTaskUpdate {
  return {
    action: 'create',
    id: '',
    title: 'Build feature',
    detail: '',
    status: null,
    phaseRef: '',
    planRef: '',
    dependencyRefs: [],
    expectedTouches: [],
    parallelism: null,
    conflictGroup: '',
    workRole: '',
    ownerAgentId: '',
    note: '',
    noteKind: 'status',
    statusNote: '',
    blockedReason: '',
    councilRequired: null,
    ...overrides,
  };
}

describe('mission task applicator', () => {
  let db: ReturnType<typeof openDatabase>;
  let actions: CreateAgentRunActionInput[];

  beforeEach(() => {
    db = openDatabase(':memory:');
    actions = [];
  });

  it('creates checklist items, notes, and dispatch candidates from parsed mission task updates', () => {
    const room = createRoom(db, { name: 'mission' });
    const task = createTask(db, { roomId: room.id, title: 'Mission' });
    const plan = createTaskPlan(db, { taskId: task.id, title: 'Plan', status: 'active' });
    const phase = createTaskPhase(db, {
      taskId: task.id,
      planId: plan.id,
      title: 'Implementation',
      status: 'active',
    });

    const result = applyMissionTaskUpdates({
      db,
      roomId: room.id,
      task,
      runId: 'run',
      agentId: 'codex',
      defaultPlanId: plan.id,
      forcePlanOnUpdates: false,
      updates: [
        update({
          title: 'Wire routing',
          phaseRef: 'Implementation',
          ownerAgentId: 'claude',
          note: 'Ready for owner.',
        }),
      ],
      recordRunAction: (action) => actions.push(action),
    });

    const [item] = listTaskChecklistItems(db, task.id);
    expect(result).toMatchObject({
      applied: 1,
      progressed: 1,
      dispatchCandidates: [{ id: item!.id, ownerAgentId: 'claude' }],
    });
    expect(item).toMatchObject({
      title: 'Wire routing',
      status: 'open',
      ownerAgentId: 'claude',
      phaseId: phase.id,
      planId: plan.id,
    });
    expect(listTaskChecklistNotes(db, task.id)).toMatchObject([
      { itemId: item!.id, authorId: 'codex', kind: 'status', body: 'Ready for owner.' },
    ]);
    expect(actions.map((action) => action.label)).toContain('mission task create');
  });

  it('marks a mission blocked when a council-required checklist blocker lands', () => {
    const room = createRoom(db, { name: 'blocked mission' });
    const task = createTask(db, { roomId: room.id, title: 'Mission' });

    const result = applyMissionTaskUpdates({
      db,
      roomId: room.id,
      task,
      runId: 'run',
      agentId: 'claude',
      defaultPlanId: null,
      forcePlanOnUpdates: false,
      updates: [
        update({
          title: 'Choose scope',
          status: 'blocked',
          blockedReason: 'Need Matt to choose.',
          councilRequired: true,
        }),
      ],
      recordRunAction: (action) => actions.push(action),
    });

    expect(result.applied).toBe(1);
    expect(result.progressed).toBe(1);
    expect(db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(task.id)).toMatchObject({
      status: 'blocked',
    });
    expect(listTaskChecklistNotes(db, task.id)).toMatchObject([
      { kind: 'council', body: 'Need Matt to choose.' },
    ]);
  });

  it('records diagnostics when a task references a plan that conflicts with its phase', () => {
    const room = createRoom(db, { name: 'mission' });
    const task = createTask(db, { roomId: room.id, title: 'Mission' });
    const planA = createTaskPlan(db, { taskId: task.id, title: 'Plan A', status: 'active' });
    createTaskPlan(db, { taskId: task.id, title: 'Plan B', status: 'draft' });
    createTaskPhase(db, {
      taskId: task.id,
      planId: planA.id,
      title: 'Phase A',
      status: 'active',
    });

    const result = applyMissionTaskUpdates({
      db,
      roomId: room.id,
      task,
      runId: 'run',
      agentId: 'codex',
      defaultPlanId: planA.id,
      forcePlanOnUpdates: false,
      updates: [
        update({
          title: 'Bad association',
          phaseRef: 'Phase A',
          planRef: 'Plan B',
        }),
      ],
      recordRunAction: (action) => actions.push(action),
    });

    expect(result.applied).toBe(0);
    expect(result.progressed).toBe(0);
    expect(listTaskChecklistItems(db, task.id)).toEqual([]);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'mission task plan mismatch',
          status: 'failed',
        }),
      ]),
    );
  });

  it('records an open status receipt without counting it as execution progress', () => {
    const room = createRoom(db, { name: 'mission' });
    const task = createTask(db, { roomId: room.id, title: 'Mission' });
    const [existing] = [
      applyMissionTaskUpdates({
        db,
        roomId: room.id,
        task,
        runId: 'setup',
        agentId: 'codex',
        defaultPlanId: null,
        forcePlanOnUpdates: false,
        updates: [
          update({
            title: 'Rebuild dashboard',
            ownerAgentId: 'codex',
          }),
        ],
        recordRunAction: (action) => actions.push(action),
      }),
    ];
    expect(existing.progressed).toBe(1);
    actions = [];

    const item = listTaskChecklistItems(db, task.id)[0]!;
    const result = applyMissionTaskUpdates({
      db,
      roomId: room.id,
      task,
      runId: 'receipt',
      agentId: 'codex',
      defaultPlanId: null,
      forcePlanOnUpdates: false,
      updates: [
        update({
          action: 'update',
          id: item.id,
          title: '',
          status: 'open',
          ownerAgentId: 'codex',
          note: 'Still open; no completion evidence yet.',
        }),
      ],
      recordRunAction: (action) => actions.push(action),
    });

    expect(result.applied).toBe(1);
    expect(result.progressed).toBe(0);
    expect(result.dispatchCandidates).toHaveLength(1);
    expect(listTaskChecklistNotes(db, task.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: item.id,
          kind: 'status',
          body: 'Still open; no completion evidence yet.',
        }),
      ]),
    );
  });
});
