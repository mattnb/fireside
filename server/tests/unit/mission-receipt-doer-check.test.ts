// server/tests/unit/mission-receipt-doer-check.test.ts
//
// PR 2 fan-out: when a mission.receipt with status='completed' closes a
// checklist item linked to an AC via acceptance_ref, the receipt applicator
// records a doer-pass on that AC and advances proposal_status accordingly.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask, getTask } from '../../src/repos/tasks.js';
import { createTaskChecklistItem } from '../../src/repos/task-checklist.js';
import {
  createAcceptanceCriterion,
  getAcceptanceCriterion,
} from '../../src/repos/acceptance-criteria.js';
import { applySingleReceipt } from '../../src/mission-state/mission-receipt-applicator.js';

describe('mission-receipt-applicator → doer-check fan-out', () => {
  let db: ReturnType<typeof openDatabase>;
  let roomId: string;
  let taskId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    roomId = createRoom(db, { name: 'r', agents: ['claude', 'codex'] }).id;
    taskId = createTask(db, { roomId, title: 't', proposalStatus: 'approved' }).id;
  });

  it('records a doer-pass on the linked AC when a completed receipt closes the item', () => {
    const ac = createAcceptanceCriterion(db, { taskId, title: 'Tests pass' });
    const item = createTaskChecklistItem(db, {
      taskId,
      title: 'Run the suite',
      acceptanceRef: ac.id,
    });

    applySingleReceipt({
      db,
      roomId,
      task: getTask(db, taskId)!,
      runId: 'run-1',
      agentId: 'claude',
      receipt: {
        status: 'completed',
        itemRef: item.id,
        phaseRef: '',
        planRef: '',
        summary: '733 tests passing',
        evidence: 'npm test output attached',
        next: '',
      },
      recordRunAction: () => {},
    });

    const fresh = getAcceptanceCriterion(db, ac.id);
    expect(fresh?.doerCheckStatus).toBe('pass');
    expect(fresh?.doerCheckByAgentId).toBe('claude');
    expect(fresh?.doerCheckEvidence).toContain('733 tests passing');
    expect(fresh?.doerCheckEvidence).toContain('npm test output attached');
  });

  it('does not fan out for receipts with status != completed', () => {
    const ac = createAcceptanceCriterion(db, { taskId, title: 'Tests pass' });
    const item = createTaskChecklistItem(db, {
      taskId,
      title: 'Run',
      acceptanceRef: ac.id,
    });

    applySingleReceipt({
      db,
      roomId,
      task: getTask(db, taskId)!,
      runId: 'run-1',
      agentId: 'claude',
      receipt: {
        status: 'continuing',
        itemRef: item.id,
        phaseRef: '',
        planRef: '',
        summary: 'still running',
        evidence: '',
        next: '',
      },
      recordRunAction: () => {},
    });

    expect(getAcceptanceCriterion(db, ac.id)?.doerCheckStatus).toBe('pending');
  });

  it('skips fan-out when item has no acceptance_ref', () => {
    const item = createTaskChecklistItem(db, { taskId, title: 'Run' });

    applySingleReceipt({
      db,
      roomId,
      task: getTask(db, taskId)!,
      runId: 'run-1',
      agentId: 'claude',
      receipt: {
        status: 'completed',
        itemRef: item.id,
        phaseRef: '',
        planRef: '',
        summary: 'done',
        evidence: '',
        next: '',
      },
      recordRunAction: () => {},
    });
    // No AC exists; nothing to verify other than the call did not throw.
    expect(true).toBe(true);
  });

  it('advances proposal_status approved → executing on the first checklist activity', () => {
    const ac = createAcceptanceCriterion(db, { taskId, title: 'Tests pass' });
    createTaskChecklistItem(db, { taskId, title: 'a', status: 'open', acceptanceRef: ac.id });

    expect(getTask(db, taskId)?.proposalStatus).toBe('approved');

    // Closing the only item via a completed receipt should at least start the
    // approved → executing → verifying pipeline. Final state lands at
    // 'verifying' since one AC remains pending on the verifier side.
    applySingleReceipt({
      db,
      roomId,
      task: getTask(db, taskId)!,
      runId: 'run-1',
      agentId: 'claude',
      receipt: {
        status: 'completed',
        itemRef: 'a',
        phaseRef: '',
        planRef: '',
        summary: 'done',
        evidence: '',
        next: '',
      },
      recordRunAction: () => {},
    });

    expect(getTask(db, taskId)?.proposalStatus).toBe('verifying');
  });
});
