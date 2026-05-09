import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { executeToolCall } from '../../src/tools/execute-tool-call.js';
import { createToolRegistry, defineTool } from '../../src/tools/registry.js';
import type {
  AgentToolCall,
  AgentToolDefinition,
  AgentToolResult,
} from '../../src/tools/types.js';

describe('executeToolCall', () => {
  it('rejects unknown tools, writes an audit row, and does not invoke handlers', async () => {
    const db = testDb();
    const registry = createToolRegistry();
    let handlerCalls = 0;
    registry.register(stubTool({ handler: () => {
      handlerCalls += 1;
      return appliedResult();
    } }));

    const outcome = await executeToolCall({
      db,
      registry,
      call: testCall({
        tool: 'mission.task.missing',
        idempotencyKey: 'unknown-tool',
      }),
      statePermissions: ['mission:write'],
      now: () => 100,
    });

    expect(outcome).toMatchObject({
      status: 'rejected',
      error: 'unknown tool: mission.task.missing',
    });
    expect(handlerCalls).toBe(0);

    const row = auditRow(db, outcome.callId);
    expect(row).toMatchObject({
      tool_name: 'mission.task.missing',
      status: 'rejected',
      error: 'unknown tool: mission.task.missing',
      applied_at: null,
    });
    db.close();
  });

  it('rejects schema validation failures, writes an audit row, and does not invoke the handler', async () => {
    const db = testDb();
    const registry = createToolRegistry();
    let handlerCalls = 0;
    registry.register(stubTool({
      schema: {
        parse(input) {
          const candidate = input as { ok?: unknown };
          if (candidate.ok !== true) throw new Error('ok must be true');
          return { ok: true };
        },
      },
      handler: () => {
        handlerCalls += 1;
        return appliedResult();
      },
    }));

    const outcome = await executeToolCall({
      db,
      registry,
      call: testCall({
        args: { ok: false },
        idempotencyKey: 'schema-failure',
      }),
      statePermissions: ['mission:write'],
      now: () => 101,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.summary).toContain('schema validation failed');
    expect(outcome.error).toBe('ok must be true');
    expect(handlerCalls).toBe(0);

    const row = auditRow(db, outcome.callId);
    expect(row).toMatchObject({
      status: 'rejected',
      error: 'ok must be true',
      applied_at: null,
    });
    expect(JSON.parse(row.normalized_args_json)).toEqual({ ok: false });
    db.close();
  });

  it('rejects calls with a missing actor before handler work', async () => {
    const db = testDb();
    const registry = createToolRegistry();
    let handlerCalls = 0;
    registry.register(stubTool({ handler: () => {
      handlerCalls += 1;
      return appliedResult();
    } }));

    const outcome = await executeToolCall({
      db,
      registry,
      call: testCall({
        agentId: '',
        idempotencyKey: 'missing-actor',
      }),
      statePermissions: ['mission:write'],
      now: () => 102,
    });

    expect(outcome).toMatchObject({
      status: 'rejected',
      error: 'agent id required',
    });
    expect(handlerCalls).toBe(0);
    expect(auditRow(db, outcome.callId)).toMatchObject({
      status: 'rejected',
      agent_id: '',
      error: 'agent id required',
    });
    db.close();
  });

  it('denies missing state permissions, writes an audit row, and does not invoke the handler', async () => {
    const db = testDb();
    const registry = createToolRegistry();
    let handlerCalls = 0;
    registry.register(stubTool({ handler: () => {
      handlerCalls += 1;
      return appliedResult();
    } }));

    const outcome = await executeToolCall({
      db,
      registry,
      call: testCall({ idempotencyKey: 'permission-denied' }),
      statePermissions: ['mission:read'],
      now: () => 103,
    });

    expect(outcome).toMatchObject({
      status: 'permission_denied',
      error: 'Missing state permission: mission:write',
    });
    expect(handlerCalls).toBe(0);

    const row = auditRow(db, outcome.callId);
    expect(row).toMatchObject({
      status: 'permission_denied',
      error: 'Missing state permission: mission:write',
      applied_at: null,
    });
    expect(JSON.parse(row.normalized_args_json)).toEqual({ taskId: 'task-1' });
    db.close();
  });

  it('deduplicates calls by idempotency key while auditing the duplicate attempt', async () => {
    const db = testDb();
    const registry = createToolRegistry();
    let handlerCalls = 0;
    registry.register(stubTool({ handler: () => {
      handlerCalls += 1;
      return appliedResult('updated task');
    } }));

    const call = testCall({ idempotencyKey: 'dedupe-key' });
    const first = await executeToolCall({
      db,
      registry,
      call,
      statePermissions: ['mission:write'],
      now: () => 104,
    });
    const second = await executeToolCall({
      db,
      registry,
      call: { ...call, id: 'tool-call-2' },
      statePermissions: ['mission:write'],
      now: () => 105,
    });

    expect(first.status).toBe('applied');
    expect(second).toMatchObject({
      status: 'duplicate',
      duplicateOfCallId: first.callId,
    });
    expect(second.callId).not.toBe(first.callId);
    expect(handlerCalls).toBe(1);
    expect(auditRows(db)).toMatchObject([
      { id: first.callId, status: 'applied' },
      { id: second.callId, status: 'duplicate' },
    ]);
    db.close();
  });

  it('copies the handler-rejection summary into the audit row error column', async () => {
    // Handler-returned rejections (where the handler returns
    // `{ status: 'rejected', summary: '...' }` rather than throwing) used to
    // leave `agent_tool_calls.error` NULL — operators could only discover
    // the rejection reason by JOINing through result_json. The 2026-05-09
    // smoke test surfaced this as `agent.checkin -> rejected (err=)` in
    // `wiki/log.md` triage. Now the audit row's error column carries the
    // summary text whenever a handler returns a non-applied terminal state.
    const db = testDb();
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        handler: () => ({
          status: 'rejected',
          summary: 'agent.checkin rejected: caller is not in the room',
          effects: [],
        }),
      }),
    );

    const outcome = await executeToolCall({
      db,
      registry,
      call: testCall({ idempotencyKey: 'rejection-error-fallback' }),
      statePermissions: ['mission:write'],
      now: () => 109,
    });

    expect(outcome.status).toBe('rejected');
    const row = auditRow(db, outcome.callId);
    expect(row.error).toBe('agent.checkin rejected: caller is not in the room');
    db.close();
  });

  it('leaves the error column empty on applied calls (no rejection summary leakage)', async () => {
    const db = testDb();
    const registry = createToolRegistry();
    registry.register(stubTool({ handler: () => appliedResult('all good') }));

    const outcome = await executeToolCall({
      db,
      registry,
      call: testCall({ idempotencyKey: 'applied-no-error' }),
      statePermissions: ['mission:write'],
      now: () => 110,
    });

    expect(outcome.status).toBe('applied');
    const row = auditRow(db, outcome.callId);
    // Schema default is '', not NULL. Either is fine — the invariant we care
    // about is that applied calls don't carry the rejection-summary fallback.
    expect(row.error == null || row.error === '').toBe(true);
    db.close();
  });

  it('records applied calls with normalized args, result, effects, and applied_at', async () => {
    const db = testDb();
    const registry = createToolRegistry();
    registry.register(stubTool({
      schema: {
        parse(input) {
          const raw = input as { taskId: string };
          return { taskId: raw.taskId.trim(), status: 'done' };
        },
      },
      handler: ({ args }) => appliedResult(`updated ${args.taskId}`, [
        {
          kind: 'task-updated',
          targetId: String(args.taskId),
          summary: 'task updated',
        },
      ]),
    }));

    const outcome = await executeToolCall({
      db,
      registry,
      call: testCall({
        args: { taskId: ' task-1 ' },
        idempotencyKey: 'happy-path',
      }),
      statePermissions: ['mission:write'],
      now: () => 106,
    });

    expect(outcome.status).toBe('applied');
    expect(outcome.result?.effects).toEqual([
      {
        kind: 'task-updated',
        targetId: 'task-1',
        summary: 'task updated',
      },
    ]);

    const row = auditRow(db, outcome.callId);
    expect(row).toMatchObject({
      status: 'applied',
      applied_at: 106,
    });
    expect(JSON.parse(row.args_json)).toEqual({ taskId: ' task-1 ' });
    expect(JSON.parse(row.normalized_args_json)).toEqual({ taskId: 'task-1', status: 'done' });
    expect(JSON.parse(row.result_json)).toMatchObject({
      status: 'applied',
      summary: 'updated task-1',
      effects: [{ kind: 'task-updated', targetId: 'task-1', summary: 'task updated' }],
    });
    db.close();
  });
});

function testDb() {
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
  return db;
}

function testCall(overrides: Partial<AgentToolCall> = {}): AgentToolCall {
  return {
    id: 'tool-call-1',
    tool: 'mission.task.update',
    idempotencyKey: 'tool-call-key',
    args: { taskId: 'task-1' },
    source: 'replay',
    roomId: 'room-1',
    missionId: 'mission-1',
    runId: null,
    messageId: null,
    agentId: 'codex',
    createdAt: 1,
    ...overrides,
  };
}

function stubTool(
  overrides: Partial<AgentToolDefinition<Record<string, unknown>>> = {},
): AgentToolDefinition<Record<string, unknown>> {
  return defineTool<Record<string, unknown>>({
    name: 'mission.task.update',
    summary: 'stub mission task update',
    requiredPermissions: ['mission:write'],
    schema: {
      parse(input) {
        return input as Record<string, unknown>;
      },
    },
    handler: () => appliedResult(),
    ...overrides,
  });
}

function appliedResult(summary = 'applied', effects: AgentToolResult['effects'] = []): AgentToolResult {
  return {
    status: 'applied',
    summary,
    effects,
  };
}

function auditRows(db: ReturnType<typeof testDb>): AgentToolCallAuditRow[] {
  return db
    .prepare('SELECT * FROM agent_tool_calls ORDER BY created_at ASC')
    .all() as AgentToolCallAuditRow[];
}

function auditRow(db: ReturnType<typeof testDb>, id: string): AgentToolCallAuditRow {
  const row = db.prepare('SELECT * FROM agent_tool_calls WHERE id = ?').get(id) as
    | AgentToolCallAuditRow
    | undefined;
  if (!row) throw new Error(`missing audit row ${id}`);
  return row;
}

interface AgentToolCallAuditRow {
  id: string;
  room_id: string;
  mission_id: string | null;
  run_id: string | null;
  message_id: string | null;
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
