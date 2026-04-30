import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { createTaskPhase, listTaskPhases } from '../../src/repos/task-phases.js';
import {
  createTaskChecklistItem,
  listTaskChecklistItems,
  updateTaskChecklistItem,
} from '../../src/repos/task-checklist.js';
import { createTaskPlan, listTaskPlans } from '../../src/repos/task-plans.js';

describe('mission control repositories', () => {
  it('stores phases, checklist items, and a single active plan for a task', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'mission', agents: ['codex'] });
    const task = createTask(db, { roomId: room.id, title: 'Ship mission control' });
    const phase = createTaskPhase(db, {
      taskId: task.id,
      title: 'Implementation',
      status: 'active',
      gate: 'Backend endpoints compile and pass tests',
      sortOrder: 1,
    });
    const openItem = createTaskChecklistItem(db, {
      taskId: task.id,
      phaseId: phase.id,
      title: 'Wire prompt context',
      sortOrder: 1,
    });
    const blockedItem = createTaskChecklistItem(db, {
      taskId: task.id,
      phaseId: phase.id,
      title: 'Review UI contract',
      status: 'blocked',
      sortOrder: 2,
    });
    const firstPlan = createTaskPlan(db, {
      taskId: task.id,
      title: 'Original plan',
      body: 'Start here',
      status: 'active',
    });
    const secondPlan = createTaskPlan(db, {
      taskId: task.id,
      title: 'Updated plan',
      body: 'Use the backend mission-control model',
      status: 'active',
    });

    expect(listTaskPhases(db, task.id)).toMatchObject([
      { id: phase.id, title: 'Implementation', status: 'active' },
    ]);
    expect(updateTaskChecklistItem(db, openItem.id, { status: 'done' })).toMatchObject({
      status: 'done',
    });
    expect(listTaskChecklistItems(db, task.id).map((item) => item.id)).toEqual([
      openItem.id,
      blockedItem.id,
    ]);
    expect(listTaskPlans(db, task.id)).toMatchObject([
      { id: secondPlan.id, status: 'active' },
      { id: firstPlan.id, status: 'superseded' },
    ]);
    db.close();
  });
});
