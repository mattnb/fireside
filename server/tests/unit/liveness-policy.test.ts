import { describe, expect, it } from 'vitest';
import { evaluateMissionLiveness } from '../../src/orchestration/liveness-policy.js';
import type { AgentJob } from '../../src/repos/agent-jobs.js';
import type { TaskChecklistItem } from '../../src/repos/task-checklist.js';
import type { Task } from '../../src/repos/tasks.js';

const task: Task = {
  id: 'task-1',
  roomId: 'room-1',
  title: 'Mission',
  goal: '',
  repoPath: '',
  acceptanceCriteria: '',
  agents: ['claude', 'codex'],
  status: 'active',
  capabilityProfile: 'edit',
  summary: '',
  createdAt: 1,
  updatedAt: 1,
};

function item(overrides: Partial<TaskChecklistItem> = {}): TaskChecklistItem {
  return {
    id: 'item-1',
    taskId: 'task-1',
    planId: null,
    phaseId: null,
    title: 'Implement slice',
    detail: '',
    status: 'open',
    dependencyIds: [],
    expectedTouches: [],
    parallelism: 'parallel-safe',
    conflictGroup: '',
    workRole: '',
    ownerAgentId: 'codex',
    statusNote: '',
    blockedReason: '',
    councilRequired: false,
    updatedBy: '',
    completedAt: null,
    sortOrder: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 'job-1',
    roomId: 'room-1',
    taskId: 'task-1',
    checklistItemId: 'item-1',
    agentId: 'codex',
    triggerMessageId: 'message-1',
    runId: 'run-1',
    status: 'running',
    workPacketJson: '{}',
    permissionJson: '{}',
    leaseOwner: 'test',
    leaseExpiresAt: 999,
    attempt: 1,
    maxAttempts: 3,
    error: '',
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    ...overrides,
  };
}

describe('mission liveness policy', () => {
  it('dispatches ready owned work when no agent is active', () => {
    const decision = evaluateMissionLiveness({
      task,
      items: [item()],
      roomAgents: ['claude', 'codex'],
      activeJobs: [],
    });
    expect(decision).toMatchObject({
      action: 'dispatch-ready-work',
      reason: '1 ready owned agent(s) can be nudged',
    });
    expect(decision.dispatches.map((dispatch) => dispatch.agentId)).toEqual(['codex']);
  });

  it('deduplicates ready liveness dispatches by agent', () => {
    const decision = evaluateMissionLiveness({
      task,
      items: [
        item({ id: 'item-1', title: 'Dashboard', ownerAgentId: 'codex' }),
        item({ id: 'item-2', title: 'Viewer', ownerAgentId: 'codex' }),
        item({ id: 'item-3', title: 'QA', ownerAgentId: 'claude' }),
      ],
      roomAgents: ['claude', 'codex'],
      activeJobs: [],
    });

    expect(decision).toMatchObject({
      action: 'dispatch-ready-work',
      reason: '2 ready owned agent(s) can be nudged',
    });
    expect(decision.dispatches.map((dispatch) => dispatch.agentId)).toEqual([
      'codex',
      'claude',
    ]);
    expect(decision.trace.map((entry) => entry.id)).toContain('liveness-dedupe-agent');
  });

  it('does not immediately re-dispatch the agent that just completed a turn', () => {
    const decision = evaluateMissionLiveness({
      task,
      items: [item({ ownerAgentId: 'codex' })],
      roomAgents: ['claude', 'codex'],
      activeJobs: [],
      suppressAgents: new Set(['codex']),
    });

    expect(decision.action).toBe('wait-for-agent');
    expect(decision.dispatches).toEqual([]);
    expect(decision.trace.map((entry) => entry.id)).toContain(
      'liveness-suppress-current-agent',
    );
  });

  it('waits when owned work is already attached to active jobs', () => {
    const decision = evaluateMissionLiveness({
      task,
      items: [item()],
      roomAgents: ['claude', 'codex'],
      activeJobs: [job()],
    });
    expect(decision.action).toBe('wait-for-agent');
  });

  it('waits for human when only council blockers remain', () => {
    const decision = evaluateMissionLiveness({
      task,
      items: [item({ status: 'blocked', councilRequired: true })],
      roomAgents: ['claude', 'codex'],
      activeJobs: [],
    });
    expect(decision.action).toBe('wait-for-human');
  });

  it('asks for assignment when open work has no owner', () => {
    const decision = evaluateMissionLiveness({
      task,
      items: [item({ ownerAgentId: '' })],
      roomAgents: ['claude', 'codex'],
      activeJobs: [],
    });
    expect(decision.action).toBe('needs-assignment');
  });
});
