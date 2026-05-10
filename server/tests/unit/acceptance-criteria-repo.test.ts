// server/tests/unit/acceptance-criteria-repo.test.ts
//
// Coverage for the acceptance-criteria repo: per-AC CRUD, dual-path
// (doer + verifier) check helpers, status derivation across the 9
// (doer × verifier) status combinations, and ON DELETE CASCADE.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom, deleteRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import {
  createAcceptanceCriterion,
  listAcceptanceCriteria,
  getAcceptanceCriterion,
  updateAcceptanceCriterion,
  recordDoerCheck,
  recordVerifierCheck,
  recomputeAcceptanceStatus,
  allCriteriaPassed,
  type AcceptanceCheckStatus,
} from '../../src/repos/acceptance-criteria.js';

describe('acceptance-criteria repo', () => {
  let db: ReturnType<typeof openDatabase>;
  let roomId: string;
  let taskId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    roomId = createRoom(db, { name: 'r', agents: ['claude', 'codex'] }).id;
    taskId = createTask(db, { roomId, title: 't', proposalStatus: 'draft' }).id;
  });

  it('creates an AC with sensible defaults and round-trips it', () => {
    const ac = createAcceptanceCriterion(db, {
      taskId,
      title: 'Tests pass',
    });
    expect(ac.taskId).toBe(taskId);
    expect(ac.title).toBe('Tests pass');
    expect(ac.detail).toBe('');
    expect(ac.doerAgentId).toBeNull();
    expect(ac.status).toBe('pending');
    expect(ac.doerCheckStatus).toBe('pending');
    expect(ac.verifierCheckStatus).toBe('pending');
    expect(ac.sortOrder).toBe(0);

    const fetched = getAcceptanceCriterion(db, ac.id);
    expect(fetched).toEqual(ac);
  });

  it('honours explicit detail, doerAgentId, and sortOrder', () => {
    const ac = createAcceptanceCriterion(db, {
      taskId,
      title: 'Build is green',
      detail: 'tsc --noEmit must succeed',
      doerAgentId: 'claude',
      sortOrder: 5,
    });
    expect(ac.detail).toBe('tsc --noEmit must succeed');
    expect(ac.doerAgentId).toBe('claude');
    expect(ac.sortOrder).toBe(5);
  });

  it('listAcceptanceCriteria returns ACs ordered by sort_order', () => {
    createAcceptanceCriterion(db, { taskId, title: 'B', sortOrder: 2 });
    createAcceptanceCriterion(db, { taskId, title: 'A', sortOrder: 1 });
    createAcceptanceCriterion(db, { taskId, title: 'C', sortOrder: 3 });
    const list = listAcceptanceCriteria(db, taskId);
    expect(list.map((ac) => ac.title)).toEqual(['A', 'B', 'C']);
  });

  it('updateAcceptanceCriterion patches title/detail/doer/sortOrder', () => {
    const ac = createAcceptanceCriterion(db, { taskId, title: 'old' });
    const updated = updateAcceptanceCriterion(db, ac.id, {
      title: 'new',
      detail: 'fresh',
      doerAgentId: 'codex',
      sortOrder: 9,
    });
    expect(updated?.title).toBe('new');
    expect(updated?.detail).toBe('fresh');
    expect(updated?.doerAgentId).toBe('codex');
    expect(updated?.sortOrder).toBe(9);
  });

  it('recordDoerCheck stamps status, evidence, who, and when', () => {
    const ac = createAcceptanceCriterion(db, { taskId, title: 'A', doerAgentId: 'claude' });
    const before = Date.now();
    const updated = recordDoerCheck(db, ac.id, {
      status: 'pass',
      evidence: 'all 733 tests passed locally',
      byAgentId: 'claude',
    });
    expect(updated?.doerCheckStatus).toBe('pass');
    expect(updated?.doerCheckEvidence).toBe('all 733 tests passed locally');
    expect(updated?.doerCheckByAgentId).toBe('claude');
    expect(updated?.doerCheckAt).toBeGreaterThanOrEqual(before);
  });

  it('recordVerifierCheck stamps the verifier side', () => {
    const ac = createAcceptanceCriterion(db, { taskId, title: 'A', doerAgentId: 'claude' });
    recordDoerCheck(db, ac.id, { status: 'pass', evidence: 'doer says ok', byAgentId: 'claude' });
    const updated = recordVerifierCheck(db, ac.id, {
      status: 'pass',
      evidence: 'reviewer ran the suite independently',
      byAgentId: 'codex',
    });
    expect(updated?.verifierCheckStatus).toBe('pass');
    expect(updated?.verifierCheckByAgentId).toBe('codex');
    expect(updated?.verifierCheckEvidence).toBe('reviewer ran the suite independently');
  });

  it('recordVerifierCheck rejects same-agent verify (doer == verifier)', () => {
    const ac = createAcceptanceCriterion(db, { taskId, title: 'A' });
    recordDoerCheck(db, ac.id, { status: 'pass', evidence: 'doer ok', byAgentId: 'claude' });
    expect(() =>
      recordVerifierCheck(db, ac.id, {
        status: 'pass',
        evidence: 'self-verify',
        byAgentId: 'claude',
      }),
    ).toThrow(/same agent/i);
  });

  it('recordVerifierCheck allows the human to verify even when the doer is human', () => {
    // The doer is an agent; the verifier is the human user. Allowed.
    const ac = createAcceptanceCriterion(db, { taskId, title: 'A' });
    recordDoerCheck(db, ac.id, { status: 'pass', evidence: 'doer ok', byAgentId: 'claude' });
    const updated = recordVerifierCheck(db, ac.id, {
      status: 'pass',
      evidence: 'matt eyeballed it',
      byAgentId: 'human',
    });
    expect(updated?.verifierCheckByAgentId).toBe('human');
  });

  it('recomputeAcceptanceStatus derives AC.status from (doer × verifier) at all 9 combinations', () => {
    const cases: Array<{
      doer: AcceptanceCheckStatus;
      verifier: AcceptanceCheckStatus;
      expected: AcceptanceCheckStatus;
    }> = [
      { doer: 'pending', verifier: 'pending', expected: 'pending' },
      { doer: 'pending', verifier: 'pass', expected: 'pending' },
      { doer: 'pending', verifier: 'fail', expected: 'fail' },
      { doer: 'pass', verifier: 'pending', expected: 'pending' },
      { doer: 'pass', verifier: 'pass', expected: 'pass' },
      { doer: 'pass', verifier: 'fail', expected: 'fail' },
      { doer: 'fail', verifier: 'pending', expected: 'fail' },
      { doer: 'fail', verifier: 'pass', expected: 'fail' },
      { doer: 'fail', verifier: 'fail', expected: 'fail' },
    ];
    for (const { doer, verifier, expected } of cases) {
      const ac = createAcceptanceCriterion(db, { taskId, title: `${doer}+${verifier}` });
      if (doer !== 'pending') {
        recordDoerCheck(db, ac.id, { status: doer, evidence: 'd', byAgentId: 'claude' });
      }
      if (verifier !== 'pending') {
        recordVerifierCheck(db, ac.id, {
          status: verifier,
          evidence: 'v',
          byAgentId: 'codex',
        });
      }
      const recomputed = recomputeAcceptanceStatus(db, ac.id);
      expect(recomputed?.status, `doer=${doer} verifier=${verifier}`).toBe(expected);
    }
  });

  it('allCriteriaPassed is true only when every AC has both sides pass', () => {
    expect(allCriteriaPassed(db, taskId)).toBe(false); // no ACs at all → false (nothing to verify against)

    const a = createAcceptanceCriterion(db, { taskId, title: 'a' });
    const b = createAcceptanceCriterion(db, { taskId, title: 'b' });

    // Both pending → false
    expect(allCriteriaPassed(db, taskId)).toBe(false);

    // a fully passed, b pending → false
    recordDoerCheck(db, a.id, { status: 'pass', evidence: 'd', byAgentId: 'claude' });
    recordVerifierCheck(db, a.id, { status: 'pass', evidence: 'v', byAgentId: 'codex' });
    expect(allCriteriaPassed(db, taskId)).toBe(false);

    // both fully passed → true
    recordDoerCheck(db, b.id, { status: 'pass', evidence: 'd', byAgentId: 'claude' });
    recordVerifierCheck(db, b.id, { status: 'pass', evidence: 'v', byAgentId: 'codex' });
    expect(allCriteriaPassed(db, taskId)).toBe(true);

    // any fail → false
    recordVerifierCheck(db, b.id, { status: 'fail', evidence: 'oops', byAgentId: 'codex' });
    expect(allCriteriaPassed(db, taskId)).toBe(false);
  });

  it('ON DELETE CASCADE removes ACs when the task is deleted', () => {
    createAcceptanceCriterion(db, { taskId, title: 'A' });
    createAcceptanceCriterion(db, { taskId, title: 'B' });
    expect(listAcceptanceCriteria(db, taskId)).toHaveLength(2);
    // Delete task by deleting the room (cascades through tasks).
    deleteRoom(db, roomId);
    expect(listAcceptanceCriteria(db, taskId)).toHaveLength(0);
  });

  it('rejects non-existent ids gracefully', () => {
    expect(getAcceptanceCriterion(db, 'no-such-id')).toBeNull();
    expect(updateAcceptanceCriterion(db, 'no-such-id', { title: 'x' })).toBeNull();
    expect(recordDoerCheck(db, 'no-such-id', {
      status: 'pass',
      evidence: 'e',
      byAgentId: 'a',
    })).toBeNull();
    expect(recordVerifierCheck(db, 'no-such-id', {
      status: 'pass',
      evidence: 'e',
      byAgentId: 'a',
    })).toBeNull();
    expect(recomputeAcceptanceStatus(db, 'no-such-id')).toBeNull();
  });
});
