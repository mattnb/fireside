// server/tests/unit/mission-verify-applicator.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask, getTask } from '../../src/repos/tasks.js';
import {
  createAcceptanceCriterion,
  getAcceptanceCriterion,
  recordDoerCheck,
} from '../../src/repos/acceptance-criteria.js';
import { applyMissionVerify } from '../../src/mission-state/mission-verify-applicator.js';

describe('applyMissionVerify', () => {
  let db: ReturnType<typeof openDatabase>;
  let roomId: string;
  let taskId: string;
  let acId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    roomId = createRoom(db, { name: 'r', agents: ['claude', 'codex'] }).id;
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'verifying' });
    taskId = task.id;
    acId = createAcceptanceCriterion(db, { taskId, title: 'AC1' }).id;
  });

  it('records a doer-side check', () => {
    const result = applyMissionVerify({
      db,
      acId,
      side: 'doer',
      status: 'pass',
      evidence: 'ran the suite',
      byAgentId: 'claude',
    });
    expect(result.applied).toBe(true);
    const ac = getAcceptanceCriterion(db, acId);
    expect(ac?.doerCheckStatus).toBe('pass');
    expect(ac?.doerCheckByAgentId).toBe('claude');
  });

  it('records a verifier-side check when the verifier is a different agent', () => {
    recordDoerCheck(db, acId, { status: 'pass', evidence: 'd', byAgentId: 'claude' });
    const result = applyMissionVerify({
      db,
      acId,
      side: 'verifier',
      status: 'pass',
      evidence: 'reviewed independently',
      byAgentId: 'codex',
    });
    expect(result.applied).toBe(true);
    const ac = getAcceptanceCriterion(db, acId);
    expect(ac?.verifierCheckStatus).toBe('pass');
    expect(ac?.verifierCheckByAgentId).toBe('codex');
  });

  it('rejects a same-agent verifier check', () => {
    recordDoerCheck(db, acId, { status: 'pass', evidence: 'd', byAgentId: 'claude' });
    const result = applyMissionVerify({
      db,
      acId,
      side: 'verifier',
      status: 'pass',
      evidence: 'self-verify',
      byAgentId: 'claude',
    });
    expect(result.applied).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.reason).toMatch(/same agent/i);
    const ac = getAcceptanceCriterion(db, acId);
    expect(ac?.verifierCheckStatus).toBe('pending');
  });

  it('rejects when the AC does not exist', () => {
    const result = applyMissionVerify({
      db,
      acId: 'no-such-ac',
      side: 'doer',
      status: 'pass',
      evidence: 'x',
      byAgentId: 'claude',
    });
    expect(result.applied).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.reason).toMatch(/unknown ac/i);
  });

  it('auto-advances proposal_status to done when both sides pass', () => {
    expect(getTask(db, taskId)?.proposalStatus).toBe('verifying');

    applyMissionVerify({
      db,
      acId,
      side: 'doer',
      status: 'pass',
      evidence: 'd',
      byAgentId: 'claude',
    });
    applyMissionVerify({
      db,
      acId,
      side: 'verifier',
      status: 'pass',
      evidence: 'v',
      byAgentId: 'codex',
    });

    expect(getTask(db, taskId)?.proposalStatus).toBe('done');
  });

  it('does not auto-advance when only the doer side passes', () => {
    applyMissionVerify({
      db,
      acId,
      side: 'doer',
      status: 'pass',
      evidence: 'd',
      byAgentId: 'claude',
    });
    expect(getTask(db, taskId)?.proposalStatus).toBe('verifying');
  });

  it('allows a human to verify on the verifier side even when the doer is human', () => {
    recordDoerCheck(db, acId, { status: 'pass', evidence: 'd', byAgentId: 'claude' });
    const result = applyMissionVerify({
      db,
      acId,
      side: 'verifier',
      status: 'pass',
      evidence: 'eyeballed',
      byAgentId: 'human',
    });
    expect(result.applied).toBe(true);
  });
});
