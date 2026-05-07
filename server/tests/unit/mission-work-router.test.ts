import { describe, expect, it } from 'vitest';
import type { TaskChecklistItem, TaskChecklistStatus } from '../../src/repos/task-checklist.js';
import { routeMissionWorkUpdates } from '../../src/routing/mission-work-router.js';

function item(
  id: string,
  overrides: Partial<TaskChecklistItem> = {},
): TaskChecklistItem {
  return {
    id,
    taskId: 'task',
    planId: null,
    phaseId: null,
    title: id,
    detail: '',
    status: 'open' as TaskChecklistStatus,
    dependencyIds: [],
    expectedTouches: [],
    parallelism: 'parallel-safe',
    conflictGroup: '',
    workRole: '',
    ownerAgentId: 'claude-technical-lead',
    statusNote: '',
    blockedReason: '',
    councilRequired: false,
    updatedBy: 'codex-project-manager',
    completedAt: null,
    sortOrder: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function route(input: {
  changedItems: TaskChecklistItem[];
  allItems?: TaskChecklistItem[];
  authorId?: string;
  roomAgents?: string[];
  busyAgents?: string[];
  activeItemIds?: string[];
}) {
  return routeMissionWorkUpdates({
    changedItems: input.changedItems,
    allItems: input.allItems ?? input.changedItems,
    roomAgents: input.roomAgents ?? ['codex-project-manager', 'claude-technical-lead'],
    authorId: input.authorId ?? 'codex-project-manager',
    busyAgents: new Set(input.busyAgents ?? []),
    activeItemIds: new Set(input.activeItemIds ?? []),
  });
}

describe('routeMissionWorkUpdates', () => {
  it('dispatches newly open assigned checklist work to the owner', () => {
    const decision = route({ changedItems: [item('sequence-ui')] });

    expect(decision.dispatches).toMatchObject([
      {
        agentId: 'claude-technical-lead',
        reason: 'assigned open checklist item sequence-ui',
      },
    ]);
    expect(decision.trace.map((entry) => entry.id)).toContain('mission-work-dispatch');
  });

  it('does not dispatch work back to the author that created or updated it', () => {
    const decision = route({
      authorId: 'claude-technical-lead',
      changedItems: [item('self-owned')],
    });

    expect(decision.dispatches).toEqual([]);
    expect(decision.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'mission-work-self', result: 'skipped' }),
      ]),
    );
  });

  it('blocks owners that are already busy', () => {
    const decision = route({
      changedItems: [item('busy-owned')],
      busyAgents: ['claude-technical-lead'],
    });

    expect(decision.dispatches).toEqual([]);
    expect(decision.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'mission-work-busy', result: 'blocked' }),
      ]),
    );
  });

  it('dispatches at most one changed work item per owner in a routing pass', () => {
    const decision = route({
      changedItems: [item('first-owned'), item('second-owned')],
    });

    expect(decision.dispatches).toHaveLength(1);
    expect(decision.dispatches[0]).toMatchObject({
      agentId: 'claude-technical-lead',
      item: { id: 'first-owned' },
    });
    expect(decision.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'mission-work-agent-dedupe', result: 'skipped' }),
      ]),
    );
  });

  it('blocks items whose dependencies are not complete', () => {
    const dependency = item('dependency', { status: 'open', ownerAgentId: 'codex-project-manager' });
    const dependent = item('dependent', { dependencyIds: ['dependency'] });
    const decision = route({
      changedItems: [dependent],
      allItems: [dependency, dependent],
    });

    expect(decision.dispatches).toEqual([]);
    expect(decision.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'mission-work-dependencies', result: 'blocked' }),
      ]),
    );
  });

  it('does not dispatch closed checklist work', () => {
    const decision = route({
      changedItems: [item('closed', { status: 'done' })],
    });

    expect(decision.dispatches).toEqual([]);
    expect(decision.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'mission-work-status', result: 'skipped' }),
      ]),
    );
  });
});
