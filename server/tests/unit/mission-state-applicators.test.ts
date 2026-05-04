import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { addMessage } from '../../src/repos/messages.js';
import { createAgentRun } from '../../src/repos/agent-runs.js';
import { createTask } from '../../src/repos/tasks.js';
import {
  createTaskChecklistItem,
  listTaskChecklistItems,
  listTaskChecklistNotes,
} from '../../src/repos/task-checklist.js';
import { listCollaborationItems } from '../../src/repos/collaboration.js';
import { listTaskPhases } from '../../src/repos/task-phases.js';
import { listTaskPlans } from '../../src/repos/task-plans.js';
import type { CreateAgentRunActionInput } from '../../src/repos/run-actions.js';
import { applyMissionPlanUpdates } from '../../src/mission-state/mission-plan-applicator.js';
import { applyMissionPhaseUpdates } from '../../src/mission-state/mission-phase-applicator.js';
import {
  reconcileMissionState,
  recordMissionReceipts,
} from '../../src/mission-state/mission-receipt-applicator.js';
import { storeCollaborationNotes } from '../../src/mission-state/collaboration-note-applicator.js';

describe('mission state applicators', () => {
  let db: ReturnType<typeof openDatabase>;
  let actions: CreateAgentRunActionInput[];

  beforeEach(() => {
    db = openDatabase(':memory:');
    actions = [];
  });

  it('applies mission plan updates and emits task-updated callbacks', () => {
    const room = createRoom(db, { name: 'room' });
    const task = createTask(db, { roomId: room.id, title: 'Mission' });
    let updatedTaskId = '';

    const plan = applyMissionPlanUpdates({
      db,
      roomId: room.id,
      task,
      runId: 'run',
      agentId: 'codex',
      updates: [
        {
          action: 'create',
          id: '',
          title: 'Execution Plan',
          status: 'active',
          body: 'Ship the slice.',
        },
      ],
      recordRunAction: (action) => actions.push(action),
      onTaskUpdated: (updated) => {
        updatedTaskId = updated.id;
      },
    });

    expect(plan).toMatchObject({ title: 'Execution Plan', status: 'active' });
    expect(listTaskPlans(db, task.id)).toHaveLength(1);
    expect(updatedTaskId).toBe(task.id);
    expect(actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'mission plan create' })]),
    );
  });

  it('applies phase updates and auto-activates the first created phase', () => {
    const room = createRoom(db, { name: 'room' });
    const task = createTask(db, { roomId: room.id, title: 'Mission' });

    applyMissionPhaseUpdates({
      db,
      roomId: room.id,
      task,
      runId: 'run',
      agentId: 'claude',
      updates: [
        {
          action: 'create',
          id: '',
          planRef: '',
          title: 'Discovery',
          description: '',
          status: null,
          gate: 'Decision recorded',
          sortOrder: null,
        },
      ],
      defaultPlanId: null,
      forcePlanOnUpdates: false,
      recordRunAction: (action) => actions.push(action),
    });

    expect(listTaskPhases(db, task.id)).toMatchObject([
      { title: 'Discovery', status: 'active' },
    ]);
  });

  it('records receipts and reconciles assigned work lane completion', () => {
    const room = createRoom(db, { name: 'room' });
    const task = createTask(db, { roomId: room.id, title: 'Mission' });
    const item = createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Implement module',
      ownerAgentId: 'codex',
    });
    const receipts = [
      {
        status: 'completed' as const,
        itemRef: item.id,
        phaseRef: '',
        planRef: '',
        summary: 'Implementation complete.',
        evidence: 'Focused tests passed.',
        next: '',
      },
    ];

    recordMissionReceipts({
      roomId: room.id,
      task,
      runId: 'run',
      agentId: 'codex',
      receipts,
      recordRunAction: (action) => actions.push(action),
    });
    const result = reconcileMissionState({
      db,
      roomId: room.id,
      task,
      runId: 'run',
      agentId: 'codex',
      receipts,
      visibleText: '',
      workLane: { item },
      explicitMissionUpdates: 0,
      recordRunAction: (action) => actions.push(action),
    });

    expect(result).toMatchObject({ applied: 1, receiptUpdates: 1 });
    expect(listTaskChecklistItems(db, task.id)).toMatchObject([{ status: 'done' }]);
    expect(listTaskChecklistNotes(db, task.id)).toMatchObject([
      { kind: 'completion', body: expect.stringContaining('Implementation complete.') },
    ]);
  });

  it('stores collaboration notes with run actions', () => {
    const room = createRoom(db, { name: 'room' });
    const task = createTask(db, { roomId: room.id, title: 'Mission' });
    const message = addMessage(db, {
      roomId: room.id,
      authorId: 'matt',
      authorKind: 'human',
      text: 'trigger',
    });
    const run = createAgentRun(db, {
      roomId: room.id,
      taskId: task.id,
      triggerMessageId: message.id,
      agentId: 'claude',
      permissionMode: 'plan',
      promptChars: 0,
      estimatedPromptTokens: 0,
      liveMessages: 1,
      contextArtifacts: 0,
    });

    storeCollaborationNotes({
      db,
      roomId: room.id,
      taskId: task.id,
      runId: run.id,
      messageId: null,
      agentId: 'claude',
      notes: [
        {
          kind: 'proposal',
          title: 'Use focused modules',
          target: 'broker',
          status: 'open',
          confidence: 'high',
          evidence: ['tests'],
          body: 'Keep broker as side-effect shell.',
        },
      ],
      recordRunAction: (action) => actions.push(action),
    });

    expect(listCollaborationItems(db, room.id)).toMatchObject([
      { title: 'Use focused modules', kind: 'proposal', taskId: task.id },
    ]);
    expect(actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'recorded proposal' })]),
    );
  });
});
