import { describe, expect, it } from 'vitest';
import type { TaskChecklistItem, TaskChecklistStatus } from '../../src/repos/task-checklist.js';
import {
  buildTaskParallelismSummary,
  planWorkLanes,
  workLaneConflictReason,
  workLaneScopeContract,
} from '../../src/orchestration/work-lane-planner.js';

function item(id: string, overrides: Partial<TaskChecklistItem> = {}): TaskChecklistItem {
  return {
    id,
    taskId: 'task',
    planId: null,
    phaseId: 'phase',
    title: id,
    detail: '',
    status: 'open' as TaskChecklistStatus,
    dependencyIds: [],
    expectedTouches: [],
    parallelism: 'parallel-safe',
    conflictGroup: '',
    workRole: '',
    ownerAgentId: '',
    statusNote: '',
    blockedReason: '',
    councilRequired: false,
    updatedBy: '',
    completedAt: null,
    sortOrder: 1,
    acceptanceRef: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('work-lane planner', () => {
  it('assigns owned ready work to its owner before unowned work', () => {
    const owned = item('owned', { ownerAgentId: 'claude', sortOrder: 1 });
    const unowned = item('unowned', { sortOrder: 2 });
    const plan = planWorkLanes({
      agents: ['claude', 'codex'],
      items: [owned, unowned],
      activeItemIds: new Set(),
      activeContracts: [],
      busyAgents: new Set(),
    });

    expect(plan.assignments.get('claude')?.item.id).toBe('owned');
    expect(plan.assignments.get('codex')?.item.id).toBe('unowned');
    expect(plan.ownerUpdates).toMatchObject([{ agentId: 'codex', item: { id: 'unowned' } }]);
  });

  it('skips busy agents and active checklist items', () => {
    const plan = planWorkLanes({
      agents: ['claude', 'codex'],
      items: [
        item('busy-owned', { ownerAgentId: 'claude' }),
        item('active-owned', { ownerAgentId: 'codex' }),
      ],
      activeItemIds: new Set(['active-owned']),
      activeContracts: [],
      busyAgents: new Set(['claude']),
    });

    expect([...plan.assignments.keys()]).toEqual([]);
  });

  it('suppresses agent-specific lane cooldowns without blocking other owners', () => {
    const cooledDown = item('cooldown-owned', { ownerAgentId: 'claude' });
    const other = item('other-owned', { ownerAgentId: 'codex' });
    const plan = planWorkLanes({
      agents: ['claude', 'codex'],
      items: [cooledDown, other],
      activeItemIds: new Set(),
      activeContracts: [],
      busyAgents: new Set(),
      suppressedItemIdsByAgent: new Map([['claude', new Set(['cooldown-owned'])]]),
    });

    expect(plan.assignments.has('claude')).toBe(false);
    expect(plan.assignments.get('codex')?.item.id).toBe('other-owned');
  });

  it('blocks work with unfinished dependencies', () => {
    const dependency = item('dependency', { status: 'open', ownerAgentId: 'codex' });
    const dependent = item('dependent', {
      ownerAgentId: 'claude',
      dependencyIds: ['dependency'],
    });
    const plan = planWorkLanes({
      agents: ['claude'],
      items: [dependency, dependent],
      activeItemIds: new Set(),
      activeContracts: [],
      busyAgents: new Set(),
    });

    expect(plan.assignments.has('claude')).toBe(false);
  });

  it('reports conflicts for overlapping expected touch scopes', () => {
    const active = item('active', {
      expectedTouches: ['src/api/**'],
    });
    const candidate = item('candidate', {
      expectedTouches: ['src/api/routes/users.ts'],
    });

    expect(workLaneConflictReason(candidate, [workLaneScopeContract(active, 'claude')])).toContain(
      'expected touch scope overlaps',
    );
  });

  it('does not assign two lanes in the same conflict group', () => {
    const plan = planWorkLanes({
      agents: ['claude', 'codex'],
      items: [
        item('left', { conflictGroup: 'api-data', sortOrder: 1 }),
        item('right', { conflictGroup: 'api-data', sortOrder: 2 }),
      ],
      activeItemIds: new Set(),
      activeContracts: [],
      busyAgents: new Set(),
    });

    expect([...plan.assignments.values()].map((assignment) => assignment.item.id)).toHaveLength(1);
  });

  it('builds a phase-scoped parallelism summary and next safe batch', () => {
    const readyA = item('ready-a', { phaseId: 'phase', ownerAgentId: 'claude', sortOrder: 1 });
    const readyB = item('ready-b', { phaseId: 'phase', ownerAgentId: 'codex', sortOrder: 2 });
    const otherPhase = item('other', { phaseId: 'other', ownerAgentId: 'gemini' });
    const summary = buildTaskParallelismSummary({
      phaseId: 'phase',
      phaseTitle: 'Implementation',
      agentCount: 2,
      checklistItems: [readyA, readyB, otherPhase],
    });

    expect(summary).toMatchObject({
      phaseId: 'phase',
      phaseTitle: 'Implementation',
      candidateCount: 2,
      readyCount: 2,
    });
    expect(summary.nextBatch.map((entry) => entry.itemId)).toEqual(['ready-a', 'ready-b']);
    expect(summary.cells).toMatchObject([
      {
        leftId: 'ready-a',
        rightId: 'ready-b',
        status: 'can-run-together',
      },
    ]);
  });
});
