import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import {
  MCP_ERROR,
  MCP_TOOL_ALLOWLIST,
  dispatchMcpRequest,
  parseJsonRpcRequest,
  type JsonRpcResponse,
} from '../../src/tools/adapters/mcp-adapter.js';
import { createToolRegistry, defineTool } from '../../src/tools/registry.js';
import type {
  AgentToolDefinition,
  AgentToolResult,
} from '../../src/tools/types.js';

function expectResponse(response: JsonRpcResponse | null): JsonRpcResponse {
  if (response === null) {
    throw new Error('expected JSON-RPC response, got null (notification)');
  }
  return response;
}

describe('parseJsonRpcRequest', () => {
  it('rejects non-object payloads', () => {
    const r = parseJsonRpcRequest('not a request');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.error.code).toBe(MCP_ERROR.invalidRequest);
    }
  });

  it('rejects payloads missing jsonrpc 2.0 marker', () => {
    const r = parseJsonRpcRequest({ id: 1, method: 'tools/list' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.error.message).toMatch(/jsonrpc must be "2.0"/);
      expect(r.error.id).toBe(1);
    }
  });

  it('passes through a well-formed envelope', () => {
    const r = parseJsonRpcRequest({ jsonrpc: '2.0', id: 'abc', method: 'tools/list' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.method).toBe('tools/list');
      expect(r.value.id).toBe('abc');
    }
  });
});

describe('dispatchMcpRequest handshake', () => {
  it('initialize returns a server-info / capabilities envelope so MCP clients can complete the handshake', async () => {
    const { db, registry } = makeRegistryWith();
    const response = expectResponse(
      await dispatchMcpRequest(
        {
          jsonrpc: '2.0',
          id: 'init-1',
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'gemini', version: '1.0.0' },
          },
        },
        { db, registry, agentId: 'mcp-client', roomId: 'room-1', missionId: 'mission-1' },
      ),
    );

    expect('result' in response).toBe(true);
    if (!('result' in response)) return;
    const result = response.result as {
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo: { name: string; version: string };
    };
    // Echo back the client's requested version when we recognize it.
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo.name).toBe('fireside');
    expect(typeof result.serverInfo.version).toBe('string');
    expect(result.capabilities).toHaveProperty('tools');
    db.close();
  });

  it('initialize falls back to the default protocol version when the client requests an unknown one', async () => {
    const { db, registry } = makeRegistryWith();
    const response = expectResponse(
      await dispatchMcpRequest(
        {
          jsonrpc: '2.0',
          id: 'init-2',
          method: 'initialize',
          params: { protocolVersion: '1900-01-01', capabilities: {} },
        },
        { db, registry, agentId: 'mcp-client', roomId: 'room-1', missionId: 'mission-1' },
      ),
    );
    expect('result' in response).toBe(true);
    if (!('result' in response)) return;
    const result = response.result as { protocolVersion: string };
    expect(result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.protocolVersion).not.toBe('1900-01-01');
    db.close();
  });

  it('notifications/initialized returns null so the HTTP transport can send 202 with no body', async () => {
    const { db, registry } = makeRegistryWith();
    const response = await dispatchMcpRequest(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { db, registry, agentId: 'mcp-client', roomId: 'room-1', missionId: 'mission-1' },
    );
    expect(response).toBeNull();
    db.close();
  });

  it('any unknown notifications/* method is silently accepted (no error response)', async () => {
    const { db, registry } = makeRegistryWith();
    const response = await dispatchMcpRequest(
      { jsonrpc: '2.0', method: 'notifications/futureSpecExtension' },
      { db, registry, agentId: 'mcp-client', roomId: 'room-1', missionId: 'mission-1' },
    );
    expect(response).toBeNull();
    db.close();
  });

  it('ping returns an empty result so liveness checks succeed', async () => {
    const { db, registry } = makeRegistryWith();
    const response = expectResponse(
      await dispatchMcpRequest(
        { jsonrpc: '2.0', id: 'p1', method: 'ping' },
        { db, registry, agentId: 'mcp-client', roomId: 'room-1', missionId: 'mission-1' },
      ),
    );
    expect('result' in response).toBe(true);
    if ('result' in response) {
      expect(response.result).toEqual({});
      expect(response.id).toBe('p1');
    }
    db.close();
  });
});

describe('dispatchMcpRequest', () => {
  it('tools/list returns only allowlisted tools, with their summary and required perms', async () => {
    const { db, registry } = makeRegistryWith(
      stub('mission.task.update', 'update task', ['mission:write']),
      stub('mission.phase.complete', 'complete phase', ['mission:admin']),
      stub('agent.set_status', 'set agent status', ['agent:write-self']),
    );

    const response = expectResponse(await dispatchMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        db,
        registry,
        agentId: 'mcp-client',
        roomId: 'room-1',
        missionId: 'mission-1',
        statePermissions: ['mission:write', 'mission:admin'],
      },
    ));

    expect('result' in response).toBe(true);
    if (!('result' in response)) return;
    const tools = (response.result as {
      tools: { name: string; description: string; inputSchema: unknown; requiredPermissions: string[] }[];
    }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['mission.phase.complete', 'mission.task.update']);
    for (const tool of tools) {
      expect(MCP_TOOL_ALLOWLIST.has(tool.name)).toBe(true);
      // MCP spec compliance: tools/list entries expose `description`, not `summary`.
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool).not.toHaveProperty('summary');
      expect(tool).toHaveProperty('inputSchema');
      expect(Array.isArray(tool.requiredPermissions)).toBe(true);
    }
    db.close();
  });

  it('tools/list filters exposed tools by effective state permissions', async () => {
    const { db, registry } = makeRegistryWith(
      stub('mission.task.update', 'update task', ['mission:write']),
      stub('mission.phase.complete', 'complete phase', ['mission:admin']),
      stub('mission.plan.update', 'update plan', ['mission:write']),
    );

    const response = expectResponse(await dispatchMcpRequest(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        db,
        registry,
        agentId: 'mcp-client',
        roomId: 'room-1',
        missionId: 'mission-1',
        statePermissions: ['mission:write'],
      },
    ));

    expect('result' in response).toBe(true);
    if (!('result' in response)) return;
    const tools = (response.result as {
      tools: { name: string; requiredPermissions: string[] }[];
    }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'mission.plan.update',
      'mission.task.update',
    ]);
    expect(tools.every((tool) => tool.requiredPermissions.includes('mission:write'))).toBe(true);
    db.close();
  });

  it('unknown method maps to JSON-RPC -32601', async () => {
    const { db, registry } = makeRegistryWith();
    const response = expectResponse(await dispatchMcpRequest(
      { jsonrpc: '2.0', id: 7, method: 'tools/run' },
      { db, registry, agentId: 'mcp-client', roomId: 'room-1', missionId: 'mission-1' },
    ));
    expect('error' in response).toBe(true);
    if ('error' in response) {
      expect(response.error.code).toBe(MCP_ERROR.methodNotFound);
      expect(response.id).toBe(7);
    }
    db.close();
  });

  it('tools/call rejects missing name with -32602', async () => {
    const { db, registry } = makeRegistryWith();
    const response = expectResponse(await dispatchMcpRequest(
      {
        jsonrpc: '2.0',
        id: 'a',
        method: 'tools/call',
        params: { idempotencyKey: 'k', arguments: {} },
      },
      { db, registry, agentId: 'mcp-client', roomId: 'room-1', missionId: 'mission-1' },
    ));
    expect('error' in response).toBe(true);
    if ('error' in response) {
      expect(response.error.code).toBe(MCP_ERROR.invalidParams);
      expect(response.error.message).toMatch(/name/);
    }
    db.close();
  });

  it('tools/call mints a deterministic idempotency key when caller omits one, so retries collapse to duplicate', async () => {
    const handlerCalls: number[] = [];
    const { db, registry } = makeRegistryWith(
      registerTool<{ taskId: string }>({
        name: 'mission.task.update',
        summary: 'update task',
        requiredPermissions: ['mission:write'],
        schema: {
          parse(input) {
            const candidate = input as { taskId?: unknown };
            if (typeof candidate.taskId !== 'string' || !candidate.taskId) {
              throw new Error('taskId required');
            }
            return { taskId: candidate.taskId.trim() };
          },
        },
        handler: ({ args }) => {
          handlerCalls.push(1);
          return {
            status: 'applied',
            summary: `updated ${args.taskId}`,
            effects: [{ kind: 'task-updated', targetId: args.taskId, summary: 'ok' }],
          };
        },
      }),
    );

    const params = {
      name: 'mission.task.update',
      arguments: { taskId: 'task-7' },
    };
    const ctx = {
      db,
      registry,
      agentId: 'mcp-client' as const,
      roomId: 'room-1',
      missionId: 'mission-1',
      statePermissions: ['mission:write' as const],
    };

    const first = expectResponse(await dispatchMcpRequest(
      { jsonrpc: '2.0', id: 'mint-1', method: 'tools/call', params },
      ctx,
    ));
    const second = expectResponse(await dispatchMcpRequest(
      { jsonrpc: '2.0', id: 'mint-2', method: 'tools/call', params },
      ctx,
    ));

    expect('result' in first).toBe(true);
    expect('result' in second).toBe(true);
    if ('result' in first && 'result' in second) {
      const firstStructured = (first.result as { structuredContent: { status: string } }).structuredContent;
      const secondStructured = (second.result as {
        structuredContent: { status: string; duplicateOfCallId: string | null };
      }).structuredContent;
      expect(firstStructured.status).toBe('applied');
      expect(secondStructured.status).toBe('duplicate');
      expect(secondStructured.duplicateOfCallId).toBeTruthy();
    }
    expect(handlerCalls).toHaveLength(1);
    db.close();
  });

  it('tools/call accepts an idempotency key supplied via _meta.idempotencyKey', async () => {
    const { db, registry } = makeRegistryWith(
      registerTool<{ taskId: string }>({
        name: 'mission.task.update',
        summary: 'update task',
        requiredPermissions: ['mission:write'],
        schema: { parse: (input) => input as { taskId: string } },
        handler: () => ({ status: 'applied', summary: 'ok', effects: [] }),
      }),
    );
    const response = expectResponse(await dispatchMcpRequest(
      {
        jsonrpc: '2.0',
        id: 'meta',
        method: 'tools/call',
        params: {
          name: 'mission.task.update',
          arguments: { taskId: 'task-1' },
          _meta: { idempotencyKey: 'caller-supplied:via-meta' },
        },
      },
      {
        db,
        registry,
        agentId: 'mcp-client',
        roomId: 'room-1',
        missionId: 'mission-1',
        statePermissions: ['mission:write'],
      },
    ));

    expect('result' in response).toBe(true);
    const row = db
      .prepare('SELECT idempotency_key FROM agent_tool_calls')
      .get() as { idempotency_key: string };
    expect(row.idempotency_key).toBe('caller-supplied:via-meta');
    db.close();
  });

  it('tools/call refuses tools outside the MCP allowlist', async () => {
    // Use a synthetic tool name that lives in an allowed namespace but is
    // not on MCP_TOOL_ALLOWLIST. Since the 2026-05-09 widening, every
    // currently-registered Fireside tool is exposed via MCP, so we register
    // a custom tool to exercise the allowlist gate itself — the gate still
    // matters for future tools that are intentionally kept internal.
    const { db, registry } = makeRegistryWith(
      stub('mission.experimental_thing', 'reserved internal', ['mission:write']),
    );
    const response = expectResponse(await dispatchMcpRequest(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'mission.experimental_thing',
          idempotencyKey: 'k1',
          arguments: {},
        },
      },
      { db, registry, agentId: 'mcp-client', roomId: 'room-1', missionId: 'mission-1' },
    ));
    expect('error' in response).toBe(true);
    if ('error' in response) {
      expect(response.error.code).toBe(MCP_ERROR.toolNotExposed);
    }
    db.close();
  });

  it('tools/call refuses allowlisted names that the registry does not advertise', async () => {
    const { db, registry } = makeRegistryWith();
    const response = expectResponse(await dispatchMcpRequest(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'mission.task.update',
          idempotencyKey: 'k-missing-tool',
          arguments: { taskId: 'task-1' },
        },
      },
      {
        db,
        registry,
        agentId: 'mcp-client',
        roomId: 'room-1',
        missionId: 'mission-1',
        statePermissions: ['mission:write'],
      },
    ));

    expect('error' in response).toBe(true);
    if ('error' in response) {
      expect(response.error.code).toBe(MCP_ERROR.toolNotExposed);
    }
    db.close();
  });

  it('tools/call routes a happy update through executeToolCall and writes an mcp-sourced audit row', async () => {
    const handlerCalls: number[] = [];
    const { db, registry } = makeRegistryWith(
      registerTool<{ taskId: string }>({
        name: 'mission.task.update',
        summary: 'update task',
        requiredPermissions: ['mission:write'],
        schema: {
          parse(input) {
            const candidate = input as { taskId?: unknown };
            if (typeof candidate.taskId !== 'string' || !candidate.taskId) {
              throw new Error('taskId required');
            }
            return { taskId: candidate.taskId.trim() };
          },
        },
        handler: ({ args }) => {
          handlerCalls.push(1);
          const result: AgentToolResult = {
            status: 'applied',
            summary: `updated ${args.taskId}`,
            effects: [{ kind: 'task-updated', targetId: args.taskId, summary: 'ok' }],
          };
          return result;
        },
      }),
    );

    const response = expectResponse(await dispatchMcpRequest(
      {
        jsonrpc: '2.0',
        id: 'happy',
        method: 'tools/call',
        params: {
          name: 'mission.task.update',
          idempotencyKey: 'mcp:test:1',
          arguments: { taskId: 'task-7' },
        },
      },
      {
        db,
        registry,
        agentId: 'mcp-client',
        roomId: 'room-1',
        missionId: 'mission-1',
        statePermissions: ['mission:write'],
        now: () => 1000,
        newCallId: () => 'call-fixed-1',
      },
    ));

    expect(handlerCalls).toHaveLength(1);
    expect('result' in response).toBe(true);
    if ('result' in response) {
      const result = response.result as {
        content: { type: string; text: string }[];
        isError: boolean;
        structuredContent: Record<string, unknown>;
      };
      // MCP spec compliance: applied → unstructured text content + isError: false.
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toMatchObject({ type: 'text' });
      expect(typeof result.content[0]?.text).toBe('string');
      // Fireside-specific fields ride along on structuredContent.
      expect(result.structuredContent.status).toBe('applied');
      expect(result.structuredContent.toolName).toBe('mission.task.update');
      expect(result.structuredContent.callId).toBe('call-fixed-1');
    }

    const row = db.prepare('SELECT source, status FROM agent_tool_calls').get() as {
      source: string;
      status: string;
    };
    expect(row.source).toBe('mcp');
    expect(row.status).toBe('applied');
    db.close();
  });

  it('tools/call returns engine rejections as result.isError: true (MCP spec puts tool-execution errors inside the result, not the JSON-RPC envelope)', async () => {
    const { db, registry } = makeRegistryWith(
      registerTool<Record<string, unknown>>({
        name: 'mission.task.update',
        summary: 'update task',
        requiredPermissions: ['mission:write'],
        schema: {
          parse() {
            throw new Error('taskId required');
          },
        },
        handler: () => ({ status: 'applied', summary: 'unreachable', effects: [] }),
      }),
    );

    const response = expectResponse(await dispatchMcpRequest(
      {
        jsonrpc: '2.0',
        id: 'sad',
        method: 'tools/call',
        params: {
          name: 'mission.task.update',
          idempotencyKey: 'mcp:test:bad',
          arguments: {},
        },
      },
      {
        db,
        registry,
        agentId: 'mcp-client',
        roomId: 'room-1',
        missionId: 'mission-1',
        statePermissions: ['mission:write'],
      },
    ));

    expect('result' in response).toBe(true);
    if ('result' in response) {
      const result = response.result as {
        content: { type: string; text: string }[];
        isError: boolean;
        structuredContent: { status: string; toolName: string; error?: string };
      };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/taskId required/);
      expect(result.structuredContent.status).toBe('rejected');
      expect(result.structuredContent.toolName).toBe('mission.task.update');
      expect(result.structuredContent.error).toMatch(/taskId required/);
    }
    db.close();
  });
});

function makeRegistryWith(
  ...tools: Array<(registry: ReturnType<typeof createToolRegistry>) => void>
) {
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
  const registry = createToolRegistry();
  for (const register of tools) register(registry);
  return { db, registry };
}

function stub(
  name: string,
  summary: string,
  requiredPermissions: AgentToolDefinition['requiredPermissions'],
): (registry: ReturnType<typeof createToolRegistry>) => void {
  return (registry) =>
    registry.register(
      defineTool<Record<string, unknown>>({
        name,
        summary,
        requiredPermissions,
        schema: { parse: (input) => input as Record<string, unknown> },
        handler: () => ({ status: 'applied', summary: 'ok', effects: [] }),
      }),
    );
}

function registerTool<TArgs>(
  definition: AgentToolDefinition<TArgs>,
): (registry: ReturnType<typeof createToolRegistry>) => void {
  return (registry) => registry.register(definition);
}
