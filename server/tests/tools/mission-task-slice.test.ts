import { describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { createAgentRunAction } from '../../src/repos/run-actions.js';
import { getTask } from '../../src/repos/tasks.js';
import {
  createTaskChecklistItem,
  getTaskChecklistItem,
  listTaskChecklistNotes,
} from '../../src/repos/task-checklist.js';
import { extractMissionTaskUpdates } from '../../src/mission-task-updates.js';
import { routeMissionTaskUpdates } from '../../src/tools/adapters/hidden-command-adapter.js';
import { executeToolCall } from '../../src/tools/execute-tool-call.js';
import { missionTaskUpdateTool } from '../../src/tools/handlers/mission-task-tools.js';
import { createToolRegistry } from '../../src/tools/registry.js';

const REPLIES = {
  done(itemId: string): string {
    return [
      'Lane complete.',
      '',
      '/mission-task',
      'action: update',
      `id: ${itemId}`,
      'status: done',
      'note: Verified mission task slice behavior.',
      '/end-mission-task',
    ].join('\n');
  },
  malformedStatus(itemId: string): string {
    return [
      'Trying to update status.',
      '',
      '/mission-task',
      'action: update',
      `id: ${itemId}`,
      'status: garbage',
      'note: This malformed status must not mutate state.',
      '/end-mission-task',
    ].join('\n');
  },
};

describe('mission task tool slice', () => {
  it('replays a happy /mission-task update through the tool engine with audit and effects', async () => {
    const db = testDb();
    const item = createTaskChecklistItem(db, {
      taskId: 'mission-1',
      title: 'Verify mission task slice',
      status: 'open',
      ownerAgentId: 'codex',
    });

    const outcome = await routeReply(db, REPLIES.done(item.id));

    expect(outcome.result).toMatchObject({ applied: 1, progressed: 1 });
    expect(outcome.toolCalls).toMatchObject([
      {
        toolName: 'mission.task.update',
        status: 'applied',
      },
    ]);
    expect(getTaskChecklistItem(db, item.id)).toMatchObject({
      status: 'done',
      statusNote: 'Verified mission task slice behavior.',
      updatedBy: 'codex',
    });
    expect(listTaskChecklistNotes(db, 'mission-1')).toMatchObject([
      {
        itemId: item.id,
        authorId: 'codex',
        kind: 'completion',
        body: 'Verified mission task slice behavior.',
      },
    ]);

    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      room_id: 'room-1',
      mission_id: 'mission-1',
      run_id: 'run-1',
      agent_id: 'codex',
      tool_name: 'mission.task.update',
      source: 'hidden-command',
      status: 'applied',
    });
    expect(JSON.parse(rows[0]!.normalized_args_json)).toMatchObject({
      taskId: item.id,
      status: 'done',
      note: 'Verified mission task slice behavior.',
    });
    expect(JSON.parse(rows[0]!.result_json)).toMatchObject({
      status: 'applied',
      effects: [
        {
          kind: 'task-updated',
          targetType: 'task-checklist-item',
          targetId: item.id,
        },
      ],
    });
    db.close();
  });

  it('rejects a malformed /mission-task block with an audit row and no state mutation', async () => {
    const db = testDb();
    const item = createTaskChecklistItem(db, {
      taskId: 'mission-1',
      title: 'Reject malformed status',
      status: 'open',
    });

    const outcome = await routeReply(db, REPLIES.malformedStatus(item.id));

    expect(outcome.result).toMatchObject({ applied: 0, progressed: 0 });
    expect(outcome.toolCalls).toMatchObject([
      {
        toolName: 'mission.task.update',
        status: 'rejected',
        error: expect.stringContaining('status must be one of'),
      },
    ]);
    expect(getTaskChecklistItem(db, item.id)).toMatchObject({
      status: 'open',
      statusNote: '',
      updatedBy: '',
    });
    expect(listTaskChecklistNotes(db, 'mission-1')).toHaveLength(0);

    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool_name: 'mission.task.update',
      source: 'hidden-command',
      status: 'rejected',
      error: expect.stringContaining('status must be one of'),
      applied_at: null,
    });
    expect(JSON.parse(rows[0]!.args_json)).toMatchObject({
      taskId: item.id,
      status: 'garbage',
    });
    db.close();
  });

  it('audits a duplicate retry without applying the checklist mutation twice', async () => {
    const db = testDb();
    const item = createTaskChecklistItem(db, {
      taskId: 'mission-1',
      title: 'Dedupe repeated completion',
      status: 'open',
    });
    const reply = REPLIES.done(item.id);

    const first = await routeReply(db, reply);
    const second = await routeReply(db, reply);

    expect(first.toolCalls[0]).toMatchObject({ status: 'applied' });
    expect(second.toolCalls[0]).toMatchObject({
      status: 'duplicate',
      duplicateOfCallId: first.toolCalls[0]!.callId,
    });
    expect(getTaskChecklistItem(db, item.id)).toMatchObject({
      status: 'done',
      statusNote: 'Verified mission task slice behavior.',
    });
    expect(listTaskChecklistNotes(db, 'mission-1')).toHaveLength(1);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM agent_run_actions
           WHERE label = 'mission task update'`,
        )
        .get(),
    ).toMatchObject({ count: 1 });

    const rows = auditRows(db);
    expect(rows).toHaveLength(2);
    expect(rowById(rows, first.toolCalls[0]!.callId)).toMatchObject({ status: 'applied' });
    expect(rowById(rows, second.toolCalls[0]!.callId)).toMatchObject({
      status: 'duplicate',
      idempotency_key: rowById(rows, first.toolCalls[0]!.callId).idempotency_key,
      applied_at: null,
    });
    db.close();
  });

  it('records permission_denied for mission.task.update and leaves state unchanged', async () => {
    const db = testDb();
    const item = createTaskChecklistItem(db, {
      taskId: 'mission-1',
      title: 'Permission protected update',
      status: 'open',
    });
    const registry = createToolRegistry();
    registry.register(missionTaskUpdateTool);

    const outcome = await executeToolCall({
      db,
      registry,
      call: {
        id: 'permission-denied-call',
        tool: 'mission.task.update',
        idempotencyKey: 'run-1:mission.task.update:permission-denied:done',
        args: {
          taskId: item.id,
          status: 'done',
          note: 'This must not be applied without write state permission.',
        },
        source: 'replay',
        roomId: 'room-1',
        missionId: 'mission-1',
        runId: 'run-1',
        messageId: null,
        agentId: 'codex',
        createdAt: 20,
      },
      statePermissions: ['mission:read'],
      now: () => 21,
    });

    expect(outcome).toMatchObject({
      status: 'permission_denied',
      error: 'Missing state permission: mission:write',
    });
    expect(getTaskChecklistItem(db, item.id)).toMatchObject({
      status: 'open',
      statusNote: '',
      updatedBy: '',
    });
    expect(listTaskChecklistNotes(db, 'mission-1')).toHaveLength(0);
    expect(auditRows(db)).toMatchObject([
      {
        tool_name: 'mission.task.update',
        source: 'replay',
        status: 'permission_denied',
        error: 'Missing state permission: mission:write',
        applied_at: null,
      },
    ]);
    db.close();
  });
});

async function routeReply(db: Database, reply: string) {
  const extracted = extractMissionTaskUpdates(reply);
  expect(extracted.updates).toHaveLength(1);
  return routeMissionTaskUpdates(
    {
      db,
      roomId: 'room-1',
      mission: getTask(db, 'mission-1'),
      runId: 'run-1',
      agentId: 'codex',
      permission: {
        source: 'yolo',
        mode: 'full-auto',
        target: 'unrestricted filesystem',
        reason: 'test grant',
      },
      defaultPlanId: null,
      forcePlanOnUpdates: false,
      recordRunAction: (action) => createAgentRunAction(db, action),
    },
    extracted.updates,
  );
}

function testDb(): Database {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO rooms (id, name, created_at, agents_json, yolo_agents_json)
     VALUES ('room-1', 'room', 1, '[]', '[]')`,
  ).run();
  db.prepare(
    `INSERT INTO messages (id, room_id, author_id, author_kind, text, created_at)
     VALUES ('message-1', 'room-1', 'human', 'human', 'start', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (
      id, room_id, title, goal, repo_path, acceptance_criteria, agents_json, status,
      capability_profile, summary, created_at, updated_at
    ) VALUES ('mission-1', 'room-1', 'mission', '', '', '', '[]', 'active', 'full-auto', '', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_runs (
      id, room_id, task_id, trigger_message_id, agent_id, status, permission_mode,
      prompt_chars, estimated_prompt_tokens, live_messages, context_artifacts, started_at
    ) VALUES ('run-1', 'room-1', 'mission-1', 'message-1', 'codex', 'completed', 'full-auto', 0, 0, 0, 0, 1)`,
  ).run();
  return db;
}

function auditRows(db: Database): AgentToolCallAuditRow[] {
  return db
    .prepare('SELECT * FROM agent_tool_calls ORDER BY created_at ASC, id ASC')
    .all() as AgentToolCallAuditRow[];
}

function rowById(rows: AgentToolCallAuditRow[], id: string): AgentToolCallAuditRow {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`missing audit row ${id}`);
  return row;
}

interface AgentToolCallAuditRow {
  id: string;
  room_id: string;
  mission_id: string | null;
  run_id: string | null;
  agent_id: string;
  tool_name: string;
  idempotency_key: string;
  source: string;
  status: string;
  args_json: string;
  normalized_args_json: string;
  result_json: string;
  error: string;
  created_at: number;
  applied_at: number | null;
}
