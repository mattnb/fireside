// server/tests/unit/universal-search.test.ts
//
// Coverage for the cross-room universal search engine: snippet/match offset
// generation, scope filtering, scoring (title > body, recency tiebreak),
// safe handling of LIKE-special characters, and per-source matching.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { createTaskPhase } from '../../src/repos/task-phases.js';
import { createTaskPlan } from '../../src/repos/task-plans.js';
import { createTaskChecklistItem } from '../../src/repos/task-checklist.js';
import { createAcceptanceCriterion } from '../../src/repos/acceptance-criteria.js';
import {
  createClarifyingQuestion,
  answerQuestion,
} from '../../src/repos/clarifying-questions.js';
import { addMessage } from '../../src/repos/messages.js';
import { runUniversalSearch } from '../../src/search/universal-search.js';

describe('runUniversalSearch', () => {
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('returns no hits for an empty or whitespace query', () => {
    createRoom(db, { name: 'general', agents: ['claude'] });
    expect(runUniversalSearch(db, '')).toEqual([]);
    expect(runUniversalSearch(db, '   ')).toEqual([]);
  });

  it('finds rooms by name with a snippet and match offsets', () => {
    const room = createRoom(db, { name: 'gate-rollout', agents: ['claude'] });
    const hits = runUniversalSearch(db, 'rollout');
    const roomHit = hits.find((hit) => hit.kind === 'room' && hit.id === room.id);
    expect(roomHit).toBeDefined();
    expect(roomHit!.title).toBe('gate-rollout');
    expect(roomHit!.snippet).toBe('gate-rollout');
    expect(roomHit!.matches).toEqual([{ start: 5, end: 12 }]);
  });

  it('finds tasks across multiple text columns', () => {
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    const task = createTask(db, {
      roomId: room.id,
      title: 'wire MCP gates',
      goal: 'unblock dispatch only when proposal is approved',
      acceptanceCriteria: 'workers blocked while draft',
      summary: 'Phase 2 work',
    });

    const goalHits = runUniversalSearch(db, 'unblock dispatch');
    const goalHit = goalHits.find((hit) => hit.kind === 'task');
    expect(goalHit).toBeDefined();
    expect(goalHit!.id).toBe(task.id);
    expect(goalHit!.snippet).toContain('unblock dispatch');

    const acHits = runUniversalSearch(db, 'while draft');
    expect(acHits.find((hit) => hit.kind === 'task')?.id).toBe(task.id);
  });

  it('ranks title hits above body hits', () => {
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    createTask(db, { roomId: room.id, title: 'plain text body match', goal: 'rollout details here' });
    createTask(db, { roomId: room.id, title: 'rollout', goal: 'whatever' });

    const hits = runUniversalSearch(db, 'rollout', { scope: ['task'] });
    expect(hits[0]!.title).toBe('rollout');
    expect(hits[1]!.title).toBe('plain text body match');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('uses recency to break ties between identically scored title hits', () => {
    // Use separate rooms so createTask's pauseOtherActiveTasks side-effect on
    // pre-existing active tasks doesn't bump the older task's updated_at.
    const a = createRoom(db, { name: 'a', agents: ['claude'] });
    const b = createRoom(db, { name: 'b', agents: ['claude'] });
    const older = createTask(db, { roomId: a.id, title: 'rollout' });
    const start = Date.now();
    while (Date.now() - start < 5) {
      // tight loop to advance Date.now()
    }
    const newer = createTask(db, { roomId: b.id, title: 'rollout' });
    const hits = runUniversalSearch(db, 'rollout', { scope: ['task'] });
    const ids = hits.map((hit) => hit.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
  });

  it('respects the scope filter', () => {
    const room = createRoom(db, { name: 'gateway', agents: ['claude'] });
    createTask(db, { roomId: room.id, title: 'gateway' });

    const allHits = runUniversalSearch(db, 'gateway');
    const kinds = new Set(allHits.map((hit) => hit.kind));
    expect(kinds.has('room')).toBe(true);
    expect(kinds.has('task')).toBe(true);

    const taskOnly = runUniversalSearch(db, 'gateway', { scope: ['task'] });
    expect(taskOnly.every((hit) => hit.kind === 'task')).toBe(true);
  });

  it('limits the result set', () => {
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    for (let i = 0; i < 10; i += 1) {
      createTask(db, { roomId: room.id, title: `marker ${i}` });
    }
    const hits = runUniversalSearch(db, 'marker', { scope: ['task'], limit: 3 });
    expect(hits).toHaveLength(3);
  });

  it('finds messages and reports the author context', () => {
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: 'Have we considered the snapshot path for blue/green?',
    });
    const hits = runUniversalSearch(db, 'blue/green', { scope: ['message'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.context).toContain('human');
    expect(hits[0]!.snippet).toContain('blue/green');
    expect(hits[0]!.matches.length).toBeGreaterThan(0);
  });

  it('escapes LIKE wildcards in the query so % is matched literally', () => {
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    createTask(db, { roomId: room.id, title: 'progress 75%' });
    createTask(db, { roomId: room.id, title: 'no percentage here' });

    const hits = runUniversalSearch(db, '75%', { scope: ['task'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe('progress 75%');
  });

  it('builds a snippet with leading ellipsis when match is mid-document', () => {
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    const longText = 'a '.repeat(200) + 'NEEDLE here';
    createTask(db, { roomId: room.id, title: 'long', goal: longText });
    const hits = runUniversalSearch(db, 'NEEDLE', { scope: ['task'] });
    expect(hits[0]!.snippet.startsWith('…')).toBe(true);
    expect(hits[0]!.snippet).toContain('NEEDLE');
    // Snippet length capped at default ~140 + 2 ellipsis chars.
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(160);
    // Match offsets must point at the actual NEEDLE occurrence in the
    // snippet, not the original text.
    const slice = hits[0]!.snippet.slice(hits[0]!.matches[0]!.start, hits[0]!.matches[0]!.end);
    expect(slice).toBe('NEEDLE');
  });

  it('finds plans, phases, checklist items, ACs, and clarifying questions', () => {
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    const task = createTask(db, { roomId: room.id, title: 't' });
    createTaskPhase(db, { taskId: task.id, title: 'PIVOT phase' });
    createTaskPlan(db, { taskId: task.id, title: 'PIVOT plan', body: 'reorganize the lanes' });
    createTaskChecklistItem(db, { taskId: task.id, title: 'PIVOT checklist item' });
    createAcceptanceCriterion(db, { taskId: task.id, title: 'PIVOT criterion' });
    const q = createClarifyingQuestion(db, {
      taskId: task.id,
      askedByAgentId: 'claude',
      question: 'should we PIVOT before phase 3?',
    });
    answerQuestion(db, q.id, { answer: 'yes', answeredBy: 'human' });

    const hits = runUniversalSearch(db, 'PIVOT');
    const kinds = new Set(hits.map((hit) => hit.kind));
    expect(kinds.has('phase')).toBe(true);
    expect(kinds.has('plan')).toBe(true);
    expect(kinds.has('checklist')).toBe(true);
    expect(kinds.has('acceptance')).toBe(true);
    expect(kinds.has('clarifying')).toBe(true);
  });

  it('filters to a single room when roomId is provided', () => {
    const a = createRoom(db, { name: 'alpha', agents: ['claude'] });
    const b = createRoom(db, { name: 'beta', agents: ['claude'] });
    createTask(db, { roomId: a.id, title: 'shared marker A' });
    createTask(db, { roomId: b.id, title: 'shared marker B' });

    const hits = runUniversalSearch(db, 'shared marker', { roomId: a.id, scope: ['task'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.roomId).toBe(a.id);
  });

  it('filters to a single task when taskId is provided', () => {
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    const t1 = createTask(db, { roomId: room.id, title: 'task one' });
    const t2 = createTask(db, { roomId: room.id, title: 'task two' });
    createTaskChecklistItem(db, { taskId: t1.id, title: 'shared marker T1' });
    createTaskChecklistItem(db, { taskId: t2.id, title: 'shared marker T2' });

    const hits = runUniversalSearch(db, 'shared marker', { taskId: t2.id, scope: ['checklist'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.taskId).toBe(t2.id);
  });
});
