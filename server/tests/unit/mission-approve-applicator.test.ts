// server/tests/unit/mission-approve-applicator.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom, setRoomApproverAgentIds } from '../../src/repos/rooms.js';
import { createTask, getTask } from '../../src/repos/tasks.js';
import { applyMissionApprove } from '../../src/mission-state/mission-approve-applicator.js';

describe('applyMissionApprove', () => {
  let db: ReturnType<typeof openDatabase>;
  let roomId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    roomId = createRoom(db, { name: 'r', agents: ['claude', 'codex'] }).id;
  });

  it('approves a task in proposed status by a human', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'proposed' });
    const result = applyMissionApprove({
      db,
      taskId: task.id,
      action: 'approve',
      byAgentId: 'human',
    });
    expect(result.applied).toBe(true);
    expect(getTask(db, task.id)?.proposalStatus).toBe('approved');
  });

  it('approves when the caller is in approverAgentIds', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'proposed' });
    setRoomApproverAgentIds(db, roomId, ['codex']);
    const result = applyMissionApprove({
      db,
      taskId: task.id,
      action: 'approve',
      byAgentId: 'codex',
    });
    expect(result.applied).toBe(true);
    expect(getTask(db, task.id)?.proposalStatus).toBe('approved');
  });

  it('rejects when the caller is not pre-authorised', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'proposed' });
    const result = applyMissionApprove({
      db,
      taskId: task.id,
      action: 'approve',
      byAgentId: 'claude',
    });
    expect(result.applied).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.reason).toMatch(/not authorised/i);
    expect(getTask(db, task.id)?.proposalStatus).toBe('proposed');
  });

  it('rejects a task with a reason', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'proposed' });
    const result = applyMissionApprove({
      db,
      taskId: task.id,
      action: 'reject',
      reason: 'scope is too broad',
      byAgentId: 'human',
    });
    expect(result.applied).toBe(true);
    expect(getTask(db, task.id)?.proposalStatus).toBe('rejected');
  });

  it('request-changes returns the task to elaborating', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'proposed' });
    const result = applyMissionApprove({
      db,
      taskId: task.id,
      action: 'request-changes',
      reason: 'add an AC for the cache layer',
      byAgentId: 'human',
    });
    expect(result.applied).toBe(true);
    expect(getTask(db, task.id)?.proposalStatus).toBe('elaborating');
  });

  it('reject without a reason is rejected', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'proposed' });
    const result = applyMissionApprove({
      db,
      taskId: task.id,
      action: 'reject',
      byAgentId: 'human',
    });
    expect(result.applied).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.reason).toMatch(/reason is required/i);
  });

  it('request-changes without a reason is rejected', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'proposed' });
    const result = applyMissionApprove({
      db,
      taskId: task.id,
      action: 'request-changes',
      byAgentId: 'human',
    });
    expect(result.applied).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.reason).toMatch(/reason is required/i);
  });

  it('approve from non-proposed states is rejected', () => {
    const task = createTask(db, { roomId, title: 't', proposalStatus: 'draft' });
    const result = applyMissionApprove({
      db,
      taskId: task.id,
      action: 'approve',
      byAgentId: 'human',
    });
    expect(result.applied).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.reason).toMatch(/illegal transition/i);
  });

  it('returns rejected for unknown task id', () => {
    const result = applyMissionApprove({
      db,
      taskId: 'no-such',
      action: 'approve',
      byAgentId: 'human',
    });
    expect(result.applied).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.reason).toMatch(/unknown task/i);
  });
});
