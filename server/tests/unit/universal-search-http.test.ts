// server/tests/unit/universal-search-http.test.ts
//
// HTTP-surface coverage for the universal search route. Verifies query
// parsing, scope filtering, room/task scoping, error handling, and the MCP
// tool wrapper behaves identically.

import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { Broker } from '../../src/broker.js';
import { buildHttpServer, type HttpServer } from '../../src/http-server.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { addMessage } from '../../src/repos/messages.js';
import { ensureDefaultToolsRegistered } from '../../src/tools/default-tools.js';
import { defaultToolRegistry } from '../../src/tools/registry.js';
import { executeToolCall } from '../../src/tools/execute-tool-call.js';
import type { AgentToolCall } from '../../src/tools/types.js';

ensureDefaultToolsRegistered();

describe('universal search HTTP route', () => {
  let app: HttpServer | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function buildApp() {
    const db = openDatabase(':memory:');
    const broker = new Broker({
      db,
      getSpec: () => undefined,
      runAgent: async () => ({ text: '', sessionId: null, raw: { stdout: '', stderr: '' } }),
    });
    app = buildHttpServer({ db, broker, uiDir: process.cwd() });
    return { db, app };
  }

  it('returns 400 when q is missing or empty', async () => {
    const { app } = buildApp();
    const noQuery = await app.inject({ method: 'GET', url: '/api/search' });
    expect(noQuery.statusCode).toBe(400);
    const blank = await app.inject({ method: 'GET', url: '/api/search?q=%20%20' });
    expect(blank.statusCode).toBe(400);
  });

  it('searches across all sources and returns the hit envelope', async () => {
    const { db, app } = buildApp();
    const room = createRoom(db, { name: 'launch-lane', agents: ['claude'] });
    createTask(db, { roomId: room.id, title: 'finish the launch' });
    addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: 'launch checklist due Monday',
    });

    const res = await app.inject({ method: 'GET', url: '/api/search?q=launch' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ query: string; scope: string[] | null; hits: Array<{ kind: string; id: string }> }>();
    expect(body.query).toBe('launch');
    expect(body.scope).toBeNull();
    const kinds = new Set(body.hits.map((hit) => hit.kind));
    expect(kinds.has('room')).toBe(true);
    expect(kinds.has('task')).toBe(true);
    expect(kinds.has('message')).toBe(true);
  });

  it('honors the scope query param (comma-separated)', async () => {
    const { db, app } = buildApp();
    const room = createRoom(db, { name: 'mission-control', agents: ['claude'] });
    createTask(db, { roomId: room.id, title: 'mission control build' });
    addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: 'mission control kickoff',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=mission&scope=task,message',
    });
    const body = res.json<{ hits: Array<{ kind: string }> }>();
    const kinds = new Set(body.hits.map((hit) => hit.kind));
    expect(kinds.has('task')).toBe(true);
    expect(kinds.has('message')).toBe(true);
    expect(kinds.has('room')).toBe(false);
  });

  it('drops unknown scope tokens silently', async () => {
    const { db, app } = buildApp();
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    createTask(db, { roomId: room.id, title: 'searchable thing' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=searchable&scope=nope,task,bogus',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ hits: Array<{ kind: string }> }>();
    expect(body.hits.every((hit) => hit.kind === 'task')).toBe(true);
  });

  it('respects roomId and limit query params', async () => {
    const { db, app } = buildApp();
    const a = createRoom(db, { name: 'alpha', agents: ['claude'] });
    const b = createRoom(db, { name: 'beta', agents: ['claude'] });
    createTask(db, { roomId: a.id, title: 'shared marker A' });
    createTask(db, { roomId: b.id, title: 'shared marker B' });

    const scoped = await app.inject({
      method: 'GET',
      url: `/api/search?q=marker&roomId=${a.id}&scope=task`,
    });
    const body = scoped.json<{ hits: Array<{ roomId: string }> }>();
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]!.roomId).toBe(a.id);

    const limited = await app.inject({
      method: 'GET',
      url: '/api/search?q=marker&scope=task&limit=1',
    });
    expect(limited.json<{ hits: unknown[] }>().hits).toHaveLength(1);
  });

  it('search.universal MCP tool returns the same hit envelope', async () => {
    const { db } = buildApp();
    const room = createRoom(db, { name: 'tooling', agents: ['claude'] });
    createTask(db, { roomId: room.id, title: 'tooling deep dive' });

    const call: AgentToolCall = {
      id: 'call-1',
      tool: 'search.universal',
      idempotencyKey: 'k1',
      args: { query: 'tooling' },
      source: 'replay',
      roomId: room.id,
      missionId: null,
      runId: null,
      messageId: null,
      agentId: 'claude',
      createdAt: 1,
    };
    const out = await executeToolCall({
      db,
      registry: defaultToolRegistry,
      call,
      statePermissions: ['search:read'],
      now: () => 1,
    });
    expect(out.status).toBe('applied');
    const data = out.result?.data as { query: string; hits: Array<{ kind: string }> };
    expect(data.query).toBe('tooling');
    const kinds = new Set(data.hits.map((hit) => hit.kind));
    expect(kinds.has('room')).toBe(true);
    expect(kinds.has('task')).toBe(true);
  });

  it('search.universal rejects empty query', async () => {
    const { db } = buildApp();
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    const call: AgentToolCall = {
      id: 'call-2',
      tool: 'search.universal',
      idempotencyKey: 'k2',
      args: { query: '   ' },
      source: 'replay',
      roomId: room.id,
      missionId: null,
      runId: null,
      messageId: null,
      agentId: 'claude',
      createdAt: 1,
    };
    const out = await executeToolCall({
      db,
      registry: defaultToolRegistry,
      call,
      statePermissions: ['search:read'],
      now: () => 1,
    });
    expect(out.status).toBe('rejected');
  });
});
