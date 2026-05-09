// Verifies the trust-model cases for POST /api/mcp: route always registered,
// loopback OK without auth, non-loopback without key (403), non-loopback with
// matching/wrong bearer (200/401). Uses Fastify's `inject` so we don't bind a
// real socket; remoteAddress is forced via the `remoteAddress` option to
// simulate non-loopback callers.

import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { Broker } from '../../src/broker.js';
import { buildHttpServer } from '../../src/http-server.js';
import type { Database } from 'better-sqlite3';

interface Harness {
  app: ReturnType<typeof buildHttpServer>;
  db: Database;
  broker: Broker;
}

function makeHarness(input: { mcpApiKey?: string | null } = {}): Harness {
  const db = openDatabase(':memory:');
  const broker = new Broker({
    db,
    getSpec: () => undefined,
    runAgent: async () => ({ text: '', sessionId: '', raw: { stdout: '', stderr: '' } }),
  });
  const app = buildHttpServer({
    db,
    broker,
    uiDir: 'C:/tmp/ui-not-real',
    mcpApiKey: input.mcpApiKey ?? null,
  });
  return { app, db, broker };
}

describe('POST /api/mcp gating', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.app.close();
      harness.db.close();
      harness = null;
    }
  });

  it('accepts loopback requests with no auth header and dispatches tools/list', async () => {
    harness = makeHarness();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/mcp',
      remoteAddress: '127.0.0.1',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { jsonrpc: string; result: { tools: unknown[] } };
    expect(body.jsonrpc).toBe('2.0');
    expect(Array.isArray(body.result.tools)).toBe(true);
    expect(body.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'mission.task.update',
          inputSchema: expect.objectContaining({ type: 'object' }),
        }),
      ]),
    );
  });

  it('refuses non-loopback requests with 403 when no API key is configured', async () => {
    harness = makeHarness({ mcpApiKey: null });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/mcp',
      remoteAddress: '10.0.0.5',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining('FIRESIDE_MCP_API_KEY'),
    });
  });

  it('refuses non-loopback requests with 401 when the bearer token is wrong', async () => {
    harness = makeHarness({ mcpApiKey: 'secret-token' });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/mcp',
      remoteAddress: '10.0.0.5',
      headers: { authorization: 'Bearer wrong' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts non-loopback requests with a matching bearer token', async () => {
    harness = makeHarness({ mcpApiKey: 'secret-token' });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/mcp',
      remoteAddress: '10.0.0.5',
      headers: { authorization: 'Bearer secret-token' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { jsonrpc: string; result: unknown };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result).toBeDefined();
  });

  it('returns 400 with a JSON-RPC envelope when the payload is malformed', async () => {
    harness = makeHarness();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/mcp',
      remoteAddress: '127.0.0.1',
      payload: { id: 1, method: 'tools/list' }, // missing jsonrpc: '2.0'
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: number } };
    expect(body.error?.code).toBeDefined();
  });

  it('responds to initialize so MCP clients can complete the handshake', async () => {
    harness = makeHarness();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/mcp',
      remoteAddress: '127.0.0.1',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'gemini', version: '1.0.0' },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      jsonrpc: string;
      id: number;
      result: { protocolVersion: string; serverInfo: { name: string }; capabilities: Record<string, unknown> };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe('2024-11-05');
    expect(body.result.serverInfo.name).toBe('fireside');
    expect(body.result.capabilities).toHaveProperty('tools');
  });

  it('returns 202 with no body for notifications/initialized (per MCP HTTP transport spec)', async () => {
    harness = makeHarness();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/mcp',
      remoteAddress: '127.0.0.1',
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.body).toBe('');
  });

  it('answers ping with an empty result', async () => {
    harness = makeHarness();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/mcp',
      remoteAddress: '127.0.0.1',
      payload: { jsonrpc: '2.0', id: 'ping-1', method: 'ping' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { jsonrpc: string; id: string; result: Record<string, unknown> };
    expect(body.id).toBe('ping-1');
    expect(body.result).toEqual({});
  });

  it('infers the caller agent / run / mission from the unique running run when headers are missing', async () => {
    harness = makeHarness();
    seedRoomWithAgent(harness.db, 'room-1', 'claude');
    seedMission(harness.db, { id: 'mission-1', roomId: 'room-1' });
    seedRunningRun(harness.db, {
      id: 'run-1',
      roomId: 'room-1',
      agentId: 'claude',
      taskId: 'mission-1',
    });

    // Call agent.list_assignments WITHOUT any of the fireside headers. The
    // route should infer agent_id, run_id, and mission_id from the unique
    // running run in the room, write the audit row with those filled in,
    // and let the handler accept the call. Before the fallback all three
    // columns landed as NULL on every agent_tool_calls row.
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/mcp',
      remoteAddress: '127.0.0.1',
      headers: { 'x-fireside-room-id': 'room-1' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'agent.list_assignments', arguments: {} },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      result: {
        isError: boolean;
        structuredContent: {
          status: string;
          result?: { data?: { agentId?: string } };
        };
      };
    };
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.status).toBe('applied');
    expect(body.result.structuredContent.result?.data?.agentId).toBe('claude');

    // Audit row should carry the inferred run_id and mission_id, not NULL.
    const row = harness.db
      .prepare(
        `SELECT agent_id, run_id, mission_id FROM agent_tool_calls
         WHERE tool_name = 'agent.list_assignments' ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { agent_id: string; run_id: string | null; mission_id: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row?.agent_id).toBe('claude');
    expect(row?.run_id).toBe('run-1');
    expect(row?.mission_id).toBe('mission-1');
  });

  it('infers run_id and mission_id even when the agent header IS present (per-room MCP config sets agent but not run/mission)', async () => {
    // Realistic case post-2026-05-09: the spawned Claude's per-room MCP
    // config writes x-fireside-room-id and x-fireside-agent-id headers
    // reliably, but x-fireside-run-id and x-fireside-mission-id vary per
    // turn and aren't injected. We still need run_id and mission_id on
    // the audit row so post-hoc queries associate tool calls with their
    // producing turn.
    harness = makeHarness();
    seedRoomWithAgent(harness.db, 'room-1', 'claude');
    seedMission(harness.db, { id: 'mission-1', roomId: 'room-1' });
    seedRunningRun(harness.db, {
      id: 'run-2',
      roomId: 'room-1',
      agentId: 'claude',
      taskId: 'mission-1',
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/mcp',
      remoteAddress: '127.0.0.1',
      headers: { 'x-fireside-room-id': 'room-1', 'x-fireside-agent-id': 'claude' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'agent.list_assignments', arguments: {} },
      },
    });
    expect(response.statusCode).toBe(200);

    const row = harness.db
      .prepare(
        `SELECT agent_id, run_id, mission_id FROM agent_tool_calls
         WHERE tool_name = 'agent.list_assignments' ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { agent_id: string; run_id: string | null; mission_id: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row?.agent_id).toBe('claude');
    expect(row?.run_id).toBe('run-2');
    expect(row?.mission_id).toBe('mission-1');
  });

  it('keeps the explicit agent header when one is supplied (header wins over inference)', async () => {
    harness = makeHarness();
    seedRoomWithAgent(harness.db, 'room-1', 'claude');
    seedRunningRun(harness.db, { id: 'run-1', roomId: 'room-1', agentId: 'claude' });

    // Send a header for a DIFFERENT agent; inference should not override it.
    // (The handler will reject because that agent isn't in the room — that's
    // the correct behavior; we want explicit attribution to be authoritative.)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/mcp',
      remoteAddress: '127.0.0.1',
      headers: { 'x-fireside-room-id': 'room-1', 'x-fireside-agent-id': 'codex' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'agent.list_assignments', arguments: {} },
      },
    });
    const body = response.json() as {
      result: { isError: boolean; structuredContent: { status: string; summary: string } };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.summary).toContain('codex is not in the room');
  });

  it('falls back to mcp-client when zero or multiple runs are active (caller is ambiguous)', async () => {
    harness = makeHarness();
    seedRoomWithAgent(harness.db, 'room-1', 'claude');
    // Two running runs => can't infer.
    seedRunningRun(harness.db, { id: 'run-1', roomId: 'room-1', agentId: 'claude' });
    seedRunningRun(harness.db, { id: 'run-2', roomId: 'room-1', agentId: 'claude' });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/mcp',
      remoteAddress: '127.0.0.1',
      headers: { 'x-fireside-room-id': 'room-1' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'agent.list_assignments', arguments: {} },
      },
    });
    const body = response.json() as {
      result: { isError: boolean; structuredContent: { summary: string } };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.summary).toContain('mcp-client is not in the room');
  });
});

function seedRoomWithAgent(db: Database, roomId: string, agentId: string): void {
  db.prepare(
    `INSERT INTO rooms (id, name, created_at, agents_json, yolo_agents_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(roomId, 'room', Date.now(), JSON.stringify([agentId]), JSON.stringify([]));
}

function seedMission(db: Database, input: { id: string; roomId: string }): void {
  db.prepare(
    `INSERT INTO tasks (
      id, room_id, title, goal, repo_path, acceptance_criteria, agents_json, status,
      capability_profile, summary, created_at, updated_at
    ) VALUES (?, ?, 'mission', '', '', '', '[]', 'active', 'full-auto', '', ?, ?)`,
  ).run(input.id, input.roomId, Date.now(), Date.now());
}

function seedRunningRun(
  db: Database,
  input: { id: string; roomId: string; agentId: string; taskId?: string | null },
): void {
  // Insert a minimal trigger message so the FK on agent_runs.trigger_message_id
  // is satisfied.
  const triggerId = `${input.id}-trigger`;
  db.prepare(
    `INSERT OR IGNORE INTO messages (id, room_id, author_id, author_kind, text, created_at)
     VALUES (?, ?, 'human', 'human', 'seed', ?)`,
  ).run(triggerId, input.roomId, Date.now());
  db.prepare(
    `INSERT INTO agent_runs (
      id, room_id, task_id, trigger_message_id, agent_id, status, permission_mode,
      prompt_chars, estimated_prompt_tokens, live_messages, context_artifacts, started_at
    ) VALUES (?, ?, ?, ?, ?, 'running', 'full-auto', 0, 0, 0, 0, ?)`,
  ).run(
    input.id,
    input.roomId,
    input.taskId ?? null,
    triggerId,
    input.agentId,
    Date.now(),
  );
}
