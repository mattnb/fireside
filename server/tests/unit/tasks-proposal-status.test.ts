// server/tests/unit/tasks-proposal-status.test.ts
//
// TDD coverage for the `proposal_status` state machine on tasks. The default
// for legacy tasks is 'approved' so existing flows dispatch unchanged; new
// tasks opt in by passing `proposalStatus: 'draft'` at creation.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import {
  createTask,
  getTask,
  maybeAdvanceProposalStatus,
  setProposalStatus,
  type ProposalStatus,
} from '../../src/repos/tasks.js';
import { createTaskChecklistItem } from '../../src/repos/task-checklist.js';
import {
  createAcceptanceCriterion,
  recordDoerCheck,
  recordVerifierCheck,
} from '../../src/repos/acceptance-criteria.js';

describe('tasks proposal_status state machine', () => {
  let db: ReturnType<typeof openDatabase>;
  let roomId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    roomId = createRoom(db, { name: 'r', agents: ['claude'] }).id;
  });

  it('defaults proposalStatus to "approved" for tasks created without the flag', () => {
    const task = createTask(db, { roomId, title: 'legacy' });
    expect(task.proposalStatus).toBe('approved');
    expect(task.verifierAgentId).toBeNull();
    expect(task.proposedByAgentId).toBeNull();
  });

  it('honours an explicit proposalStatus on createTask', () => {
    const task = createTask(db, { roomId, title: 'new', proposalStatus: 'draft' });
    expect(task.proposalStatus).toBe('draft');
  });

  it('round-trips verifierAgentId and proposedByAgentId on createTask', () => {
    const task = createTask(db, {
      roomId,
      title: 't',
      proposalStatus: 'proposed',
      verifierAgentId: 'codex',
      proposedByAgentId: 'claude',
    });
    expect(task.verifierAgentId).toBe('codex');
    expect(task.proposedByAgentId).toBe('claude');
    const fresh = getTask(db, task.id);
    expect(fresh?.verifierAgentId).toBe('codex');
    expect(fresh?.proposedByAgentId).toBe('claude');
  });

  it('setProposalStatus advances along legal transitions', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'draft' });
    expect(setProposalStatus(db, task.id, 'elaborating', 'claude')?.proposalStatus).toBe(
      'elaborating',
    );
    expect(setProposalStatus(db, task.id, 'proposed', 'claude')?.proposalStatus).toBe('proposed');
    expect(setProposalStatus(db, task.id, 'approved', 'human')?.proposalStatus).toBe('approved');
    expect(setProposalStatus(db, task.id, 'executing', 'claude')?.proposalStatus).toBe('executing');
    expect(setProposalStatus(db, task.id, 'verifying', 'claude')?.proposalStatus).toBe('verifying');
    expect(setProposalStatus(db, task.id, 'done', 'codex')?.proposalStatus).toBe('done');
  });

  it('setProposalStatus allows back-edges that match the spec (proposed → elaborating on request-changes)', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'proposed' });
    expect(setProposalStatus(db, task.id, 'elaborating', 'human')?.proposalStatus).toBe(
      'elaborating',
    );
  });

  it('setProposalStatus allows the approver to reject from proposed or elaborating', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'proposed' });
    expect(setProposalStatus(db, task.id, 'rejected', 'human')?.proposalStatus).toBe('rejected');

    const t2 = createTask(db, { roomId: roomId, title: 't2', proposalStatus: 'elaborating' });
    expect(setProposalStatus(db, t2.id, 'rejected', 'human')?.proposalStatus).toBe('rejected');
  });

  it('setProposalStatus rejects illegal transitions', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'draft' });

    // Cannot skip from draft straight to approved.
    expect(() => setProposalStatus(db, task.id, 'approved', 'human')).toThrow(/illegal transition/i);

    // Cannot resurrect from terminal states.
    setProposalStatus(db, task.id, 'elaborating', 'claude');
    setProposalStatus(db, task.id, 'proposed', 'claude');
    setProposalStatus(db, task.id, 'rejected', 'human');
    expect(() => setProposalStatus(db, task.id, 'approved', 'human')).toThrow(/illegal transition/i);
    expect(() => setProposalStatus(db, task.id, 'elaborating', 'claude')).toThrow(
      /illegal transition/i,
    );

    const done = createTask(db, { roomId, title: 't3', proposalStatus: 'done' });
    expect(() => setProposalStatus(db, done.id, 'draft', 'claude')).toThrow(/illegal transition/i);
    expect(() => setProposalStatus(db, done.id, 'verifying', 'claude')).toThrow(
      /illegal transition/i,
    );
  });

  it('setProposalStatus is a no-op when status is already the requested value', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'approved' });
    const result = setProposalStatus(db, task.id, 'approved', 'human');
    expect(result?.proposalStatus).toBe('approved');
    // Should not throw — same-state writes are tolerated for idempotency.
  });

  it('setProposalStatus stamps proposedByAgentId on the elaborating → proposed edge', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'elaborating' });
    const result = setProposalStatus(db, task.id, 'proposed', 'claude');
    expect(result?.proposedByAgentId).toBe('claude');
  });

  it('setProposalStatus returns null for an unknown task id', () => {
    expect(setProposalStatus(db, 'nope', 'approved', 'human')).toBeNull();
  });

  const allStatuses: ProposalStatus[] = [
    'draft',
    'elaborating',
    'proposed',
    'approved',
    'executing',
    'verifying',
    'done',
    'rejected',
  ];

  it('every status is round-trippable through createTask + getTask', () => {
    for (const s of allStatuses) {
      const t = createTask(db, { roomId, title: `t-${s}`, proposalStatus: s });
      expect(getTask(db, t.id)?.proposalStatus).toBe(s);
    }
  });
});

describe('maybeAdvanceProposalStatus', () => {
  let db: ReturnType<typeof openDatabase>;
  let roomId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    roomId = createRoom(db, { name: 'r', agents: ['claude', 'codex'] }).id;
  });

  it('does nothing when there are no checklist items or ACs', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'approved' });
    const result = maybeAdvanceProposalStatus(db, task.id);
    expect(result?.proposalStatus).toBe('approved');
  });

  it('advances approved → executing when at least one checklist item is open', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'approved' });
    createTaskChecklistItem(db, { taskId: task.id, title: 'work', status: 'open' });
    const result = maybeAdvanceProposalStatus(db, task.id);
    expect(result?.proposalStatus).toBe('executing');
  });

  it('does not move executing back to approved when items reopen', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'executing' });
    createTaskChecklistItem(db, { taskId: task.id, title: 'work', status: 'open' });
    const result = maybeAdvanceProposalStatus(db, task.id);
    expect(result?.proposalStatus).toBe('executing');
  });

  it('advances executing → verifying when all items closed but ACs remain pending', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'executing' });
    createTaskChecklistItem(db, { taskId: task.id, title: 'work', status: 'done' });
    createAcceptanceCriterion(db, { taskId: task.id, title: 'AC1' });
    const result = maybeAdvanceProposalStatus(db, task.id);
    expect(result?.proposalStatus).toBe('verifying');
  });

  it('advances verifying → done when all ACs pass', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'verifying' });
    createTaskChecklistItem(db, { taskId: task.id, title: 'work', status: 'done' });
    const ac = createAcceptanceCriterion(db, { taskId: task.id, title: 'AC1' });
    recordDoerCheck(db, ac.id, { status: 'pass', evidence: 'd', byAgentId: 'claude' });
    recordVerifierCheck(db, ac.id, { status: 'pass', evidence: 'v', byAgentId: 'codex' });
    const result = maybeAdvanceProposalStatus(db, task.id);
    expect(result?.proposalStatus).toBe('done');
  });

  it('skips approved → done when there are zero ACs (no verification work)', () => {
    // If a task has no ACs at all, completing the checklist is enough — but
    // by spec, allCriteriaPassed returns false when there are no ACs, so the
    // task stays at executing/verifying. The lead can either add ACs or
    // close the task manually. Document this rather than auto-shortcut it.
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'executing' });
    createTaskChecklistItem(db, { taskId: task.id, title: 'work', status: 'done' });
    const result = maybeAdvanceProposalStatus(db, task.id);
    expect(result?.proposalStatus).toBe('executing');
  });

  it('returns null for an unknown task id', () => {
    expect(maybeAdvanceProposalStatus(db, 'nope')).toBeNull();
  });

  it('does not move terminal states', () => {
    const done = createTask(db, { roomId, title: 'd', proposalStatus: 'done' });
    const rejected = createTask(db, { roomId, title: 'r', proposalStatus: 'rejected' });
    expect(maybeAdvanceProposalStatus(db, done.id)?.proposalStatus).toBe('done');
    expect(maybeAdvanceProposalStatus(db, rejected.id)?.proposalStatus).toBe('rejected');
  });
});
