import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import {
  MCP_ERROR,
  MCP_TOOL_ALLOWLIST,
  dispatchMcpRequest,
  parseJsonRpcRequest,
} from '../../src/tools/adapters/mcp-adapter.js';
import { createToolRegistry, defineTool } from '../../src/tools/registry.js';
import type {
  AgentToolDefinition,
  AgentToolResult,
} from '../../src/tools/types.js';

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

describe('dispatchMcpRequest', () => {
  it('tools/list returns only allowlisted tools, with their summary and required perms', async () => {
    const { db, registry } = makeRegistryWith(
      stub('mission.task.update', 'update task', ['mission:write']),
      stub('mission.phase.complete', 'complete phase', ['mission:admin']),
      stub('agent.set_status', 'set agent status', ['agent:write-self']),
    );

    const response = await dispatchMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        db,
        registry,
        agentId: 'mcp-client',
        roomId: 'room-1',
        missionId: 'mission-1',
        statePermissions: ['mission:write', 'mission:admin'],
      },
    );

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

    const response = await dispatchMcpRequest(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        db,
        registry,
        agentId: 'mcp-client',
        roomId: 'room-1',
        missionId: 'mission-1',
        statePermissions: ['mission:write'],
      },
    );

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
    const response = await dispatchMcpRequest(
      { jsonrpc: '2.0', id: 7, method: 'tools/run' },
      { db, registry, agentId: 'mcp-client', roomId: 'room-1', missionId: 'mission-1' },
    );
    expect('error' in response).toBe(true);
    if ('error' in response) {
      expect(response.error.code).toBe(MCP_ERROR.methodNotFound);
      expect(response.id).toBe(7);
    }
    db.close();
  });

  it('tools/call rejects missing name with -32602', async () => {
    const { db, registry } = makeRegistryWith();
    const response = await dispatchMcpRequest(
      {
        jsonrpc: '2.0',
        id: 'a',
        method: 'tools/call',
        params: { idempotencyKey: 'k', arguments: {} },
      },
      { db, registry, agentId: 'mcp-client', roomId: 'room-1', missionId: 'mission-1' },
    );
    expect('error' in response).toBe(true);
    if ('error' in response) {
      expect(response.error.code).toBe(MCP_ERROR.invalidParams);
      expect(response.error.message).toMatch(/name/);
    }
    db.close();
  });

  it('tools/call refuses to mint an idempotency key on the caller behalf', async () => {
    const { db, registry } = makeRegistryWith(
      stub('mission.task.update', 'update task', ['mission:write']),
    );
    const response = await dispatchMcpRequest(
      {
        jsonrpc: '2.0',
        id: 'b',
        method: 'tools/call',
        params: { name: 'mission.task.update', arguments: { taskId: 'task-1' } },
      },
      { db, registry, agentId: 'mcp-client', roomId: 'room-1', missionId: 'mission-1' },
    );
    expect('error' in response).toBe(true);
    if ('error' in response) {
      expect(response.error.code).toBe(MCP_ERROR.invalidParams);
      expect(response.error.message).toMatch(/idempotencyKey/);
    }
    db.close();
  });

  it('tools/call refuses tools outside the MCP allowlist', async () => {
    const { db, registry } = makeRegistryWith(
      stub('agent.set_status', 'set status', ['agent:write-self']),
    );
    const response = await dispatchMcpRequest(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'agent.set_status',
          idempotencyKey: 'k1',
          arguments: { status: 'idle' },
        },
      },
      { db, registry, agentId: 'mcp-client', roomId: 'room-1', missionId: 'mission-1' },
    );
    expect('error' in response).toBe(true);
    if ('error' in response) {
      expect(response.error.code).toBe(MCP_ERROR.toolNotExposed);
    }
    db.close();
  });

  it('tools/call refuses allowlisted names that the registry does not advertise', async () => {
    const { db, registry } = makeRegistryWith();
    const response = await dispatchMcpRequest(
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
    );

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

    const response = await dispatchMcpRequest(
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
    );

    expect(handlerCalls).toHaveLength(1);
    expect('result' in response).toBe(true);
    if ('result' in response) {
      const result = response.result as Record<string, unknown>;
      expect(result.status).toBe('applied');
      expect(result.toolName).toBe('mission.task.update');
    }

    const row = db.prepare('SELECT source, status FROM agent_tool_calls').get() as {
      source: string;
      status: string;
    };
    expect(row.source).toBe('mcp');
    expect(row.status).toBe('applied');
    db.close();
  });

  it('tools/call surfaces engine rejections as -32000 with audit context', async () => {
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

    const response = await dispatchMcpRequest(
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
    );

    expect('error' in response).toBe(true);
    if ('error' in response) {
      expect(response.error.code).toBe(MCP_ERROR.toolFailed);
      expect(response.error.message).toMatch(/taskId required/);
      const data = response.error.data as { status: string; toolName: string };
      expect(data.status).toBe('rejected');
      expect(data.toolName).toBe('mission.task.update');
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
