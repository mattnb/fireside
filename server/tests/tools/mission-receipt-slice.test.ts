import { describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { createAgentRunAction } from '../../src/repos/run-actions.js';
import { getTask } from '../../src/repos/tasks.js';
import {
  createTaskChecklistItem,
  getTaskChecklistItem,
  listTaskChecklistItems,
  listTaskChecklistNotes,
} from '../../src/repos/task-checklist.js';
import {
  createTaskPhase,
  getTaskPhase,
  listTaskPhases,
} from '../../src/repos/task-phases.js';
import { extractMissionReceipts } from '../../src/mission-receipts.js';
import { routeMissionReceipts } from '../../src/tools/adapters/hidden-command-adapter.js';
import { dispatchMcpRequest, MCP_TOOL_ALLOWLIST } from '../../src/tools/adapters/mcp-adapter.js';
import { defaultToolRegistry } from '../../src/tools/registry.js';
import { ensureDefaultToolsRegistered } from '../../src/tools/default-tools.js';

ensureDefaultToolsRegistered();

const replyWith = (lines: string[]): string =>
  ['/mission-receipt', ...lines, '/end-mission-receipt'].join('\n');

describe('mission.receipt.submit slice', () => {
  it('routes a completed receipt through the tool engine and reconciles checklist + phase state', async () => {
    const db = testDb();
    const phase = createTaskPhase(db, {
      taskId: 'mission-1',
      title: 'verify gates',
      status: 'active',
      sortOrder: 0,
    });
    const item = createTaskChecklistItem(db, {
      taskId: 'mission-1',
      title: 'land receipt slice',
      status: 'open',
      ownerAgentId: 'codex',
      phaseId: phase.id,
    });

    const reply = replyWith([
      'status: completed',
      `item: ${item.id}`,
      `phase: ${phase.id}`,
      'summary: receipt slice landed',
    ]);
    const outcome = await routeReply(db, reply);

    expect(outcome.applied).toBe(2);
    expect(outcome.progressed).toBe(2);
    expect(outcome.toolCalls).toMatchObject([
      { toolName: 'mission.receipt.submit', status: 'applied' },
    ]);
    expect(outcome.touchedItemIds.has(item.id)).toBe(true);

    expect(getTaskChecklistItem(db, item.id)).toMatchObject({
      status: 'done',
      statusNote: 'receipt slice landed',
    });
    expect(getTaskPhase(db, phase.id)).toMatchObject({ status: 'done' });
    expect(listTaskChecklistNotes(db, 'mission-1')).toHaveLength(1);

    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool_name: 'mission.receipt.submit',
      source: 'hidden-command',
      status: 'applied',
    });
    db.close();
  });

  it('rejects with a no-mission diagnostic when the room has no active mission', async () => {
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
      `INSERT INTO agent_runs (
        id, room_id, task_id, trigger_message_id, agent_id, status, permission_mode,
        prompt_chars, estimated_prompt_tokens, live_messages, context_artifacts, started_at
      ) VALUES ('run-1', 'room-1', NULL, 'message-1', 'codex', 'completed', 'full-auto', 0, 0, 0, 0, 1)`,
    ).run();
    const reply = replyWith(['status: completed', 'summary: no mission yet']);
    const outcome = await routeReply(db, reply, { mission: null });

    expect(outcome.toolCalls).toMatchObject([
      { toolName: 'mission.receipt.submit', status: 'rejected' },
    ]);
    expect(outcome.applied).toBe(0);
    const diag = db
      .prepare(`SELECT label, status FROM agent_run_actions WHERE run_id = 'run-1'`)
      .all() as { label: string; status: string }[];
    expect(diag).toContainEqual({ label: 'mission receipt ignored', status: 'failed' });
    db.close();
  });

  it('collapses a duplicate retry to a single applied audit row and one mutation', async () => {
    const db = testDb();
    const item = createTaskChecklistItem(db, {
      taskId: 'mission-1',
      title: 'idempotent receipt',
      status: 'open',
    });
    const reply = replyWith([
      'status: completed',
      `item: ${item.id}`,
      'summary: idempotent slice',
    ]);

    const first = await routeReply(db, reply);
    const second = await routeReply(db, reply);

    expect(first.toolCalls[0]).toMatchObject({ status: 'applied' });
    expect(second.toolCalls[0]).toMatchObject({
      status: 'duplicate',
      duplicateOfCallId: first.toolCalls[0]!.callId,
    });
    expect(getTaskChecklistItem(db, item.id)).toMatchObject({ status: 'done' });
    expect(listTaskChecklistNotes(db, 'mission-1')).toHaveLength(1);

    const rows = auditRows(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual(['applied', 'duplicate']);
    db.close();
  });

  it('records the per-receipt ledger row even when no checklist or phase mutation applies', async () => {
    const db = testDb();
    const reply = replyWith(['status: no_update', 'summary: just acknowledging']);
    const outcome = await routeReply(db, reply);

    expect(outcome.toolCalls).toMatchObject([
      { toolName: 'mission.receipt.submit', status: 'applied' },
    ]);
    expect(outcome.applied).toBe(0);
    expect(listTaskChecklistItems(db, 'mission-1')).toHaveLength(0);
    expect(listTaskPhases(db, 'mission-1')).toHaveLength(0);

    const ledger = db
      .prepare(
        `SELECT label FROM agent_run_actions
         WHERE label = 'mission receipt: no_update'`,
      )
      .all();
    expect(ledger).toHaveLength(1);
    db.close();
  });

  it('exposes mission.receipt.submit via tools/list when the caller holds mission:write', async () => {
    const db = testDb();
    expect(MCP_TOOL_ALLOWLIST.has('mission.receipt.submit')).toBe(true);

    const allowed = await dispatchMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        db,
        registry: defaultToolRegistry,
        agentId: 'mcp-client',
        roomId: 'room-1',
        missionId: 'mission-1',
        statePermissions: ['mission:write'],
      },
    );
    expect('result' in allowed).toBe(true);
    if ('result' in allowed) {
      const tools = (allowed.result as { tools: { name: string }[] }).tools;
      expect(tools.map((t) => t.name)).toContain('mission.receipt.submit');
    }

    const denied = await dispatchMcpRequest(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        db,
        registry: defaultToolRegistry,
        agentId: 'mcp-client',
        roomId: 'room-1',
        missionId: 'mission-1',
        statePermissions: ['mission:read'],
      },
    );
    if ('result' in denied) {
      const tools = (denied.result as { tools: { name: string }[] }).tools;
      expect(tools.map((t) => t.name)).not.toContain('mission.receipt.submit');
    }
    db.close();
  });
});

interface RouteOptions {
  mission?: ReturnType<typeof getTask> | null;
}

async function routeReply(db: Database, reply: string, options: RouteOptions = {}) {
  const extracted = extractMissionReceipts(reply);
  expect(extracted.receipts.length).toBeGreaterThan(0);
  const mission =
    options.mission === undefined ? getTask(db, 'mission-1') ?? null : options.mission;
  return routeMissionReceipts(
    {
      db,
      roomId: 'room-1',
      mission,
      runId: 'run-1',
      agentId: 'codex',
      permission: {
        source: 'yolo',
        mode: 'full-auto',
        target: 'unrestricted filesystem',
        reason: 'test grant',
      },
    },
    extracted.receipts,
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

function auditRows(db: Database): { tool_name: string; source: string; status: string }[] {
  return db
    .prepare(
      'SELECT tool_name, source, status FROM agent_tool_calls ORDER BY created_at ASC, id ASC',
    )
    .all() as { tool_name: string; source: string; status: string }[];
}
