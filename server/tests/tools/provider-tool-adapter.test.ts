import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createTaskChecklistItem, getTaskChecklistItem } from '../../src/repos/task-checklist.js';
import { getTask } from '../../src/repos/tasks.js';
import {
  decodeProviderToolCalls,
  routeProviderToolCalls,
} from '../../src/tools/adapters/provider-tool-adapter.js';
import { missionTaskUpdateTool } from '../../src/tools/handlers/mission-task-tools.js';
import { createToolRegistry } from '../../src/tools/registry.js';

describe('provider tool adapter', () => {
  it('decodes Anthropic tool_use blocks into provider-tool-call AgentToolCalls', () => {
    const registry = createToolRegistry();
    registry.register(missionTaskUpdateTool);
    const calls = decodeProviderToolCalls({
      providerId: 'claude',
      stdout: [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Done.' },
              {
                type: 'tool_use',
                id: 'toolu_123',
                name: 'mission.task.update',
                input: { taskId: 'item-1', status: 'done', note: 'Native Claude call.' },
              },
            ],
          },
        }),
      ].join('\n'),
      roomId: 'room-1',
      missionId: 'mission-1',
      runId: 'run-1',
      agentId: 'claude',
      registry,
      now: () => 10,
      newCallId: () => 'call-1',
    });

    expect(calls).toMatchObject([
      {
        id: 'call-1',
        tool: 'mission.task.update',
        idempotencyKey: 'run-1:provider-tool-call:toolu_123',
        source: 'provider-tool-call',
        args: { taskId: 'item-1', status: 'done', note: 'Native Claude call.' },
      },
    ]);
  });

  it('skips mcp__-prefixed tool_use blocks because MCP-routed calls are already executed via the HTTP endpoint', () => {
    // When Claude is registered with the fireside MCP server, the spawned CLI
    // executes the tool call end-to-end via JSON-RPC and emits the same
    // tool_use record on its stdout for telemetry. Re-routing that record
    // through executeToolCall would either double-execute (success path) or
    // log a misleading "args validation failed" rejection (the failure mode
    // we hit in the 2026-05-09 smoke test before this guard was added).
    const registry = createToolRegistry();
    registry.register(missionTaskUpdateTool);
    const calls = decodeProviderToolCalls({
      providerId: 'claude',
      stdout: JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_mcp_1',
              name: 'mcp__fireside__mission.task.update',
              input: { taskId: 'item-1', status: 'done' },
            },
            {
              type: 'tool_use',
              id: 'toolu_native_1',
              name: 'mission.task.update',
              input: { taskId: 'item-2', status: 'done' },
            },
          ],
        },
      }),
      roomId: 'room-1',
      missionId: 'mission-1',
      runId: 'run-1',
      agentId: 'claude',
      registry,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('mission.task.update');
    expect(calls[0]!.idempotencyKey).toContain('toolu_native_1');
  });

  it('does not decode tool_use from streaming content_block_start events (args always empty there)', () => {
    // Anthropic's streaming protocol delivers tool_use input incrementally
    // via input_json_delta after content_block_start. Extracting at start
    // produced empty-args calls that consistently failed validation and
    // produced spurious `rejected` rows for every MCP-routed turn.
    const registry = createToolRegistry();
    registry.register(missionTaskUpdateTool);
    const calls = decodeProviderToolCalls({
      providerId: 'claude',
      stdout: JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'toolu_partial',
            name: 'mission.task.update',
            input: {},
          },
        },
      }),
      roomId: 'room-1',
      missionId: 'mission-1',
      runId: 'run-1',
      agentId: 'claude',
      registry,
    });
    expect(calls).toHaveLength(0);
  });

  it('decodes Codex/OpenAI function_call items with JSON arguments', () => {
    const registry = createToolRegistry();
    registry.register(missionTaskUpdateTool);
    const calls = decodeProviderToolCalls({
      providerId: 'codex',
      stdout: [
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_abc',
            name: 'mission_task_update',
            arguments: JSON.stringify({
              taskId: 'item-1',
              status: 'done',
              note: 'Native Codex call.',
            }),
          },
        }),
      ].join('\n'),
      roomId: 'room-1',
      missionId: 'mission-1',
      runId: 'run-1',
      agentId: 'codex',
      registry,
    });

    expect(calls).toMatchObject([
      {
        tool: 'mission.task.update',
        idempotencyKey: 'run-1:provider-tool-call:call_abc',
        source: 'provider-tool-call',
        args: { taskId: 'item-1', status: 'done', note: 'Native Codex call.' },
      },
    ]);
  });

  it('routes native provider calls through idempotency, permission, handler, and audit', async () => {
    const db = testDb();
    const item = createTaskChecklistItem(db, {
      taskId: 'mission-1',
      title: 'Bridge native provider call',
      status: 'open',
    });

    const stdout = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_bridge',
            name: 'mission.task.update',
            input: {
              taskId: item.id,
              status: 'done',
              note: 'Applied through provider bridge.',
            },
          },
        ],
      },
    });

    const first = await routeProviderToolCalls({
      db,
      providerId: 'claude',
      stdout,
      roomId: 'room-1',
      mission: getTask(db, 'mission-1'),
      runId: 'run-1',
      agentId: 'claude',
      permission: {
        source: 'yolo',
        mode: 'full-auto',
        target: 'unrestricted filesystem',
        reason: 'test grant',
      },
      now: () => 20,
      newCallId: () => 'provider-call-1',
    });
    const second = await routeProviderToolCalls({
      db,
      providerId: 'claude',
      stdout,
      roomId: 'room-1',
      mission: getTask(db, 'mission-1'),
      runId: 'run-1',
      agentId: 'claude',
      permission: {
        source: 'yolo',
        mode: 'full-auto',
        target: 'unrestricted filesystem',
        reason: 'test grant',
      },
      now: () => 21,
      newCallId: () => 'provider-call-2',
    });

    expect(first.toolCalls[0]).toMatchObject({ status: 'applied' });
    expect(second.toolCalls[0]).toMatchObject({
      status: 'duplicate',
      duplicateOfCallId: first.toolCalls[0]!.callId,
    });
    expect(first.missionTaskResult).toMatchObject({ applied: 1, progressed: 1 });
    expect(getTaskChecklistItem(db, item.id)).toMatchObject({
      status: 'done',
      statusNote: 'Applied through provider bridge.',
    });
    expect(auditRows(db)).toMatchObject([
      {
        id: 'provider-call-1',
        tool_name: 'mission.task.update',
        source: 'provider-tool-call',
        status: 'applied',
        idempotency_key: 'run-1:provider-tool-call:toolu_bridge',
      },
      {
        tool_name: 'mission.task.update',
        source: 'provider-tool-call',
        status: 'duplicate',
        idempotency_key: 'run-1:provider-tool-call:toolu_bridge',
      },
    ]);
    db.close();
  });

  it('routes Codex/OpenAI function_call items through idempotency, permission, handler, and audit', async () => {
    const db = testDb();
    const item = createTaskChecklistItem(db, {
      taskId: 'mission-1',
      title: 'Bridge Codex native provider call',
      status: 'open',
    });

    const stdout = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_codex_bridge',
        name: 'mission_task_update',
        arguments: JSON.stringify({
          taskId: item.id,
          status: 'done',
          note: 'Applied through Codex provider bridge.',
        }),
      },
    });

    const first = await routeProviderToolCalls({
      db,
      providerId: 'codex',
      stdout,
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
      now: () => 30,
      newCallId: () => 'codex-provider-call-1',
    });
    const second = await routeProviderToolCalls({
      db,
      providerId: 'codex',
      stdout,
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
      now: () => 31,
      newCallId: () => 'codex-provider-call-2',
    });

    expect(first.toolCalls[0]).toMatchObject({ status: 'applied' });
    expect(second.toolCalls[0]).toMatchObject({
      status: 'duplicate',
      duplicateOfCallId: first.toolCalls[0]!.callId,
    });
    expect(first.missionTaskResult).toMatchObject({ applied: 1, progressed: 1 });
    expect(getTaskChecklistItem(db, item.id)).toMatchObject({
      status: 'done',
      statusNote: 'Applied through Codex provider bridge.',
    });
    expect(auditRows(db)).toMatchObject([
      {
        id: 'codex-provider-call-1',
        tool_name: 'mission.task.update',
        source: 'provider-tool-call',
        status: 'applied',
        idempotency_key: 'run-1:provider-tool-call:call_codex_bridge',
      },
      {
        tool_name: 'mission.task.update',
        source: 'provider-tool-call',
        status: 'duplicate',
        idempotency_key: 'run-1:provider-tool-call:call_codex_bridge',
      },
    ]);
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
    ) VALUES ('run-1', 'room-1', 'mission-1', 'message-1', 'claude', 'completed', 'full-auto', 0, 0, 0, 0, 1)`,
  ).run();
  return db;
}

function auditRows(db: ReturnType<typeof openDatabase>): AgentToolCallAuditRow[] {
  return db
    .prepare('SELECT * FROM agent_tool_calls ORDER BY created_at ASC, id ASC')
    .all() as AgentToolCallAuditRow[];
}

interface AgentToolCallAuditRow {
  id: string;
  tool_name: string;
  source: string;
  status: string;
  idempotency_key: string;
}
