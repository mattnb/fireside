// server/tests/unit/audit-stream-http.test.ts
//
// HTTP-surface coverage for the per-room audit stream.

import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { Broker } from '../../src/broker.js';
import { buildHttpServer, type HttpServer } from '../../src/http-server.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { createAgentRun } from '../../src/repos/agent-runs.js';
import { addMessage } from '../../src/repos/messages.js';
import { createAgentRunAction } from '../../src/repos/run-actions.js';
import { createMissionCommandEvent } from '../../src/repos/mission-command-events.js';

describe('audit-stream HTTP route', () => {
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

  function seedSomeEvents(db: ReturnType<typeof openDatabase>) {
    const room = createRoom(db, { name: 'r', agents: ['claude', 'codex'] });
    const task = createTask(db, { roomId: room.id, title: 't' });
    const trigger = addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: 'go',
    });
    const run = createAgentRun(db, {
      roomId: room.id,
      taskId: task.id,
      agentId: 'claude',
      triggerMessageId: trigger.id,
      promptChars: 0,
      estimatedPromptTokens: 0,
      liveMessages: 0,
      contextArtifacts: 0,
      promptText: '',
      permissionMode: 'plan',
    });
    createAgentRunAction(db, {
      roomId: room.id,
      taskId: task.id,
      runId: run.id,
      agentId: 'claude',
      kind: 'prompt',
      status: 'info',
      label: 'prompt built',
    });
    createMissionCommandEvent(db, {
      roomId: room.id,
      taskId: task.id,
      runId: run.id,
      agentId: 'codex',
      commandKind: 'mission-task',
      action: 'update',
      status: 'applied',
      summary: 'task updated',
    });
    return { room, task, run };
  }

  it('returns 404 for unknown rooms', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/rooms/missing/audit' });
    expect(res.statusCode).toBe(404);
  });

  it('returns merged events newest-first', async () => {
    const { db, app } = buildApp();
    const { room } = seedSomeEvents(db);
    const res = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/audit` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ events: Array<{ kind: string; createdAt: number }> }>();
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    const ts = body.events.map((event) => event.createdAt);
    for (let i = 1; i < ts.length; i += 1) {
      expect(ts[i]!).toBeLessThanOrEqual(ts[i - 1]!);
    }
  });

  it('honors the kinds query param', async () => {
    const { db, app } = buildApp();
    const { room } = seedSomeEvents(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/audit?kinds=run-action`,
    });
    const body = res.json<{ events: Array<{ kind: string }> }>();
    expect(body.events.every((event) => event.kind === 'run-action')).toBe(true);
  });

  it('honors the agentId query param', async () => {
    const { db, app } = buildApp();
    const { room } = seedSomeEvents(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/audit?agentId=codex`,
    });
    const body = res.json<{ events: Array<{ agentId: string }> }>();
    expect(body.events.every((event) => event.agentId === 'codex')).toBe(true);
    expect(body.events.length).toBeGreaterThanOrEqual(1);
  });

  it('drops unknown kind tokens silently', async () => {
    const { db, app } = buildApp();
    const { room } = seedSomeEvents(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/audit?kinds=bogus,run-action`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ events: Array<{ kind: string }> }>();
    expect(body.events.every((event) => event.kind === 'run-action')).toBe(true);
  });

  it('respects the limit query param', async () => {
    const { db, app } = buildApp();
    const { room, task, run } = seedSomeEvents(db);
    for (let i = 0; i < 5; i += 1) {
      createAgentRunAction(db, {
        roomId: room.id,
        taskId: task.id,
        runId: run.id,
        agentId: 'claude',
        kind: 'prompt',
        status: 'info',
        label: `n${i}`,
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/audit?limit=2`,
    });
    const body = res.json<{ events: unknown[] }>();
    expect(body.events.length).toBe(2);
  });
});
