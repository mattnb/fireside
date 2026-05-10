// server/tests/unit/verifier-selection.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom, setRoomLeadAgent } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { createAcceptanceCriterion } from '../../src/repos/acceptance-criteria.js';
import { defaultVerifierForTask } from '../../src/mission-state/verifier-selection.js';

describe('defaultVerifierForTask', () => {
  let db: ReturnType<typeof openDatabase>;
  let roomId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    roomId = createRoom(db, { name: 'r', agents: ['claude', 'codex', 'gemini'] }).id;
  });

  it('returns the first non-lead, non-doer agent', () => {
    setRoomLeadAgent(db, roomId, 'claude');
    const task = createTask(db, { roomId, title: 't' });
    createAcceptanceCriterion(db, { taskId: task.id, title: 'AC1', doerAgentId: 'codex' });
    expect(defaultVerifierForTask(db, task.id)).toBe('gemini');
  });

  it('returns null when only the lead and a doer exist', () => {
    const id = createRoom(db, { name: 'r2', agents: ['claude', 'codex'] }).id;
    setRoomLeadAgent(db, id, 'claude');
    const task = createTask(db, { roomId: id, title: 't' });
    createAcceptanceCriterion(db, { taskId: task.id, title: 'AC1', doerAgentId: 'codex' });
    expect(defaultVerifierForTask(db, task.id)).toBeNull();
  });

  it('returns null when only one agent exists', () => {
    const id = createRoom(db, { name: 'r3', agents: ['claude'] }).id;
    const task = createTask(db, { roomId: id, title: 't' });
    expect(defaultVerifierForTask(db, task.id)).toBeNull();
  });

  it('skips multiple distinct doers', () => {
    setRoomLeadAgent(db, roomId, 'claude');
    const task = createTask(db, { roomId, title: 't' });
    createAcceptanceCriterion(db, { taskId: task.id, title: 'AC1', doerAgentId: 'codex' });
    createAcceptanceCriterion(db, { taskId: task.id, title: 'AC2', doerAgentId: 'gemini' });
    // Only lead is available — and lead is excluded — so null.
    expect(defaultVerifierForTask(db, task.id)).toBeNull();
  });

  it('returns the only non-lead candidate when no AC has a doer', () => {
    const id = createRoom(db, { name: 'r4', agents: ['claude', 'codex'] }).id;
    setRoomLeadAgent(db, id, 'claude');
    const task = createTask(db, { roomId: id, title: 't' });
    createAcceptanceCriterion(db, { taskId: task.id, title: 'AC1' });
    expect(defaultVerifierForTask(db, task.id)).toBe('codex');
  });

  it('returns null when task does not exist', () => {
    expect(defaultVerifierForTask(db, 'no-such')).toBeNull();
  });
});
