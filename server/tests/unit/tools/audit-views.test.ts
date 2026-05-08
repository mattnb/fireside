import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/db.js';
import {
  insertAgentToolCall,
  listAgentToolCallsForRun,
  updateAgentToolCall,
} from '../../../src/tools/audit.js';

describe('listAgentToolCallsForRun', () => {
  it('returns decoded views ordered by created_at, derives target, and parses result/effects', () => {
    const db = seededDb();

    const first = insertAgentToolCall(db, {
      roomId: 'room-1',
      missionId: 'mission-1',
      runId: 'run-1',
      messageId: null,
      agentId: 'codex',
      toolName: 'mission.task.update',
      idempotencyKey: 'run-1:mission.task.update:task-7:done',
      source: 'hidden-command',
      args: { taskId: 'task-7', title: 'wire adapter', status: 'done' },
      now: 100,
    });
    updateAgentToolCall(db, first.id, {
      status: 'applied',
      normalizedArgs: { taskId: 'task-7', title: 'wire adapter', status: 'done' },
      result: {
        status: 'applied',
        summary: 'task task-7 marked done',
        effects: [
          { kind: 'task-updated', targetId: 'task-7', summary: 'status: done' },
        ],
      },
      appliedAt: 110,
    });

    const second = insertAgentToolCall(db, {
      roomId: 'room-1',
      missionId: 'mission-1',
      runId: 'run-1',
      messageId: null,
      agentId: 'claude',
      toolName: 'mission.task.add_note',
      idempotencyKey: 'run-1:mission.task.add_note:task-7:abc',
      source: 'hidden-command',
      args: { taskId: 'task-7', body: 'evidence link' },
      now: 200,
    });
    updateAgentToolCall(db, second.id, {
      status: 'rejected',
      normalizedArgs: { taskId: 'task-7' },
      error: 'note body required',
    });

    // Different run — must not leak.
    insertAgentToolCall(db, {
      roomId: 'room-1',
      missionId: 'mission-1',
      runId: 'run-other',
      messageId: null,
      agentId: 'codex',
      toolName: 'mission.task.update',
      idempotencyKey: 'run-other:mission.task.update:task-9:done',
      source: 'hidden-command',
      args: { taskId: 'task-9' },
      now: 50,
    });

    const views = listAgentToolCallsForRun(db, 'run-1');
    expect(views).toHaveLength(2);

    expect(views[0]).toMatchObject({
      id: first.id,
      toolName: 'mission.task.update',
      status: 'applied',
      source: 'hidden-command',
      agentId: 'codex',
      target: 'task-7 (wire adapter)',
      summary: 'task task-7 marked done',
      error: '',
      appliedAt: 110,
    });
    expect(views[0]!.normalizedArgs).toEqual({
      taskId: 'task-7',
      title: 'wire adapter',
      status: 'done',
    });
    expect(views[0]!.effects).toEqual([
      { kind: 'task-updated', targetId: 'task-7', summary: 'status: done' },
    ]);
    expect(views[0]!.result?.status).toBe('applied');

    expect(views[1]).toMatchObject({
      id: second.id,
      toolName: 'mission.task.add_note',
      status: 'rejected',
      agentId: 'claude',
      target: 'task-7',
      error: 'note body required',
      summary: '',
      appliedAt: null,
    });
    expect(views[1]!.effects).toEqual([]);
    expect(views[1]!.result).toBeNull();

    db.close();
  });

  it('returns an empty list when no rows are stamped against the run', () => {
    const db = seededDb();
    expect(listAgentToolCallsForRun(db, 'run-empty')).toEqual([]);
    db.close();
  });
});

function seededDb() {
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
  for (const runId of ['run-1', 'run-other']) {
    db.prepare(
      `INSERT INTO agent_runs (
        id, room_id, task_id, trigger_message_id, agent_id, status, permission_mode,
        prompt_chars, estimated_prompt_tokens, live_messages, context_artifacts, started_at
      ) VALUES (?, 'room-1', 'mission-1', 'trigger-msg', 'codex', 'completed', 'full-auto',
        0, 0, 0, 0, 1)`,
    ).run(runId);
  }
  return db;
}
