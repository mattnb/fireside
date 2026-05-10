import { describe, expect, it } from 'vitest';
import type { ParsedMissionTaskUpdate } from '../../src/mission-task-updates.js';
import type { TaskChecklistItem } from '../../src/repos/task-checklist.js';
import type { TaskPhase } from '../../src/repos/task-phases.js';
import type { TaskPlan } from '../../src/repos/task-plans.js';
import {
  inferChecklistCompletion,
  resolveDependencyIds,
  resolvePhaseId,
  resolvePlan,
} from '../../src/mission-state/mission-state-helpers.js';

const now = 1;

function phase(overrides: Partial<TaskPhase>): TaskPhase {
  return {
    id: 'phase',
    taskId: 'task',
    planId: null,
    title: 'Phase',
    description: '',
    status: 'planned',
    gate: '',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function plan(overrides: Partial<TaskPlan>): TaskPlan {
  return {
    id: 'plan',
    taskId: 'task',
    title: 'Plan',
    body: '',
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function item(overrides: Partial<TaskChecklistItem>): TaskChecklistItem {
  return {
    id: 'item',
    taskId: 'task',
    planId: null,
    phaseId: null,
    title: 'Item',
    detail: '',
    status: 'open',
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
    sortOrder: 0,
    acceptanceRef: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function taskUpdate(overrides: Partial<ParsedMissionTaskUpdate>): ParsedMissionTaskUpdate {
  return {
    action: 'update',
    id: '',
    title: 'Task',
    detail: '',
    status: null,
    dependencyRefs: [],
    expectedTouches: [],
    parallelism: null,
    conflictGroup: '',
    workRole: '',
    ownerAgentId: '',
    statusNote: '',
    blockedReason: '',
    councilRequired: null,
    noteKind: 'status',
    note: '',
    planRef: '',
    phaseRef: '',
    ...overrides,
  };
}

describe('mission state helpers', () => {
  it('resolves phase references with normalized names and prefers active matches', () => {
    const phases = [
      phase({ id: 'planned', title: 'Phase 1: Audit Scope', status: 'planned' }),
      phase({ id: 'active', title: 'Phase 1 - Audit Scope', status: 'active' }),
    ];

    expect(resolvePhaseId(phases, 'phase 1 audit scope')).toBe('active');
  });

  it('resolves active plans from current aliases and clear refs to no plan', () => {
    const plans = [
      plan({ id: 'draft', title: 'Draft plan', status: 'draft' }),
      plan({ id: 'active', title: 'Execution plan', status: 'active' }),
    ];

    expect(resolvePlan(plans, 'current')?.id).toBe('active');
    expect(resolvePlan(plans, 'no plan')).toBeNull();
  });

  it('deduplicates dependencies and omits self references', () => {
    const items = [
      item({ id: 'a', title: 'Audit' }),
      item({ id: 'b', title: 'Build' }),
    ];

    expect(resolveDependencyIds(items, ['Audit', 'a', 'Build'], 'a')).toEqual(['b']);
  });

  it('infers completion only from completion-oriented evidence', () => {
    expect(
      inferChecklistCompletion(
        taskUpdate({ note: 'Implementation landed and tests completed.' }),
      ),
    ).toBe(true);
    expect(
      inferChecklistCompletion(
        taskUpdate({ note: 'Implementation landed but review remains required.' }),
      ),
    ).toBe(false);
  });
});
