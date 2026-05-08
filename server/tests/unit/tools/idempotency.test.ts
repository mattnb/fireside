import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/db.js';
import { lookupPriorCall, recordCall } from '../../../src/tools/idempotency.js';

describe('tool idempotency', () => {
  it('records and resolves prior calls by room, mission, and idempotency key', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO rooms (id, name, created_at, agents_json, yolo_agents_json)
       VALUES ('room-1', 'room', 1, '[]', '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (
        id, room_id, title, goal, repo_path, acceptance_criteria, agents_json, status,
        capability_profile, summary, created_at, updated_at
      ) VALUES ('mission-1', 'room-1', 'mission', '', '', '', '[]', 'active', 'full-auto', '', 1, 1)`,
    ).run();

    const recorded = recordCall(db, {
      roomId: 'room-1',
      missionId: 'mission-1',
      agentId: 'codex',
      toolName: 'mission.task.update',
      idempotencyKey: 'run-1:task-1:done',
      source: 'hidden-command',
      status: 'applied',
      args: { taskId: 'task-1', status: 'done' },
      result: { summary: 'done' },
      now: 10,
    });

    const prior = lookupPriorCall(db, 'run-1:task-1:done', 'mission-1', 'room-1');
    expect(prior).toMatchObject({
      id: recorded.id,
      room_id: 'room-1',
      mission_id: 'mission-1',
      tool_name: 'mission.task.update',
      status: 'applied',
      applied_at: 10,
    });
    expect(JSON.parse(prior!.args_json)).toEqual({ taskId: 'task-1', status: 'done' });
    db.close();
  });

  it('enforces uniqueness for non-duplicate terminal calls within the same room and mission', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO rooms (id, name, created_at, agents_json, yolo_agents_json)
       VALUES ('room-1', 'room', 1, '[]', '[]')`,
    ).run();

    const base = {
      roomId: 'room-1',
      missionId: null,
      agentId: 'codex',
      toolName: 'collab.note.add',
      idempotencyKey: 'same-key',
      source: 'hidden-command',
      status: 'applied' as const,
      now: 10,
    };
    recordCall(db, base);

    expect(() => recordCall(db, { ...base, now: 11 })).toThrow();
    expect(() => recordCall(db, { ...base, status: 'duplicate', now: 12 })).not.toThrow();
    db.close();
  });
});
