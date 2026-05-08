// Verifies the four trust-model gating cases for POST /api/mcp described in
// docs/phase-6-mcp-endpoint-design-2026-05-07.md §2: flag-off (404), loopback
// OK, non-loopback without key (403), non-loopback with key (200). Uses
// Fastify's `inject` so we don't bind a real socket; remoteAddress is forced
// via the `remoteAddress` option to simulate non-loopback callers.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { Broker } from '../../src/broker.js';
import { buildHttpServer } from '../../src/http-server.js';
import type { Database } from 'better-sqlite3';

interface Harness {
  app: ReturnType<typeof buildHttpServer>;
  db: Database;
  broker: Broker;
}

function makeHarness(input: { enableMcp: boolean; mcpApiKey?: string | null }): Harness {
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
    enableMcp: input.enableMcp,
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

  it('returns 404 when FIRESIDE_ENABLE_MCP is not set (route is not registered)', async () => {
    harness = makeHarness({ enableMcp: false });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('accepts loopback requests with no auth header and dispatches tools/list', async () => {
    harness = makeHarness({ enableMcp: true });
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
    harness = makeHarness({ enableMcp: true, mcpApiKey: null });
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
    harness = makeHarness({ enableMcp: true, mcpApiKey: 'secret-token' });
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
    harness = makeHarness({ enableMcp: true, mcpApiKey: 'secret-token' });
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
    harness = makeHarness({ enableMcp: true });
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
});
