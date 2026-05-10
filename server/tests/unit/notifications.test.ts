// server/tests/unit/notifications.test.ts
//
// Coverage for the notifications repo + fan-out + HTTP routes.

import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { Broker } from '../../src/broker.js';
import { buildHttpServer, type HttpServer } from '../../src/http-server.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask, setProposalStatus } from '../../src/repos/tasks.js';
import { addMessage } from '../../src/repos/messages.js';
import { createAgentRun, updateAgentRun } from '../../src/repos/agent-runs.js';
import {
  countUnreadNotifications,
  createNotification,
  dismissNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../src/repos/notifications.js';
import { NotificationFanout } from '../../src/notifications/notification-fanout.js';

describe('notifications repo', () => {
  it('creates and reads back notifications', () => {
    const db = openDatabase(':memory:');
    const created = createNotification(db, {
      kind: 'task-done',
      summary: 'Task done: Wire MCP',
    });
    expect(created).not.toBeNull();
    expect(created!.kind).toBe('task-done');
    expect(created!.severity).toBe('info');
    expect(created!.readAt).toBeNull();
    expect(created!.dismissedAt).toBeNull();

    const list = listNotifications(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(created!.id);
  });

  it('honors dedupeKey to suppress duplicate notifications', () => {
    const db = openDatabase(':memory:');
    const first = createNotification(db, {
      kind: 'task-done',
      summary: 'A',
      dedupeKey: 'task-done:abc',
    });
    const second = createNotification(db, {
      kind: 'task-done',
      summary: 'B',
      dedupeKey: 'task-done:abc',
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(listNotifications(db)).toHaveLength(1);
  });

  it('distinct dedupeKeys produce distinct rows', () => {
    const db = openDatabase(':memory:');
    expect(createNotification(db, { kind: 'task-done', summary: 'x', dedupeKey: 'x' })).not.toBeNull();
    expect(createNotification(db, { kind: 'task-done', summary: 'y', dedupeKey: 'y' })).not.toBeNull();
    expect(listNotifications(db)).toHaveLength(2);
  });

  it('empty dedupeKey allows multiple inserts', () => {
    const db = openDatabase(':memory:');
    expect(createNotification(db, { kind: 'task-done', summary: 'a' })).not.toBeNull();
    expect(createNotification(db, { kind: 'task-done', summary: 'b' })).not.toBeNull();
    expect(listNotifications(db)).toHaveLength(2);
  });

  it('counts unread, marks read, dismisses', () => {
    const db = openDatabase(':memory:');
    const a = createNotification(db, { kind: 'task-done', summary: 'a' })!;
    createNotification(db, { kind: 'task-done', summary: 'b' });
    createNotification(db, { kind: 'task-done', summary: 'c' });
    expect(countUnreadNotifications(db)).toBe(3);

    markNotificationRead(db, a.id);
    expect(countUnreadNotifications(db)).toBe(2);

    expect(markAllNotificationsRead(db)).toBe(2);
    expect(countUnreadNotifications(db)).toBe(0);

    const list = listNotifications(db);
    const target = list[0]!;
    dismissNotification(db, target.id);
    expect(listNotifications(db)).toHaveLength(2); // dismissed excluded by default
    expect(listNotifications(db, { excludeDismissed: false })).toHaveLength(3);
  });

  it('lists unreadOnly filters out read rows', () => {
    const db = openDatabase(':memory:');
    const a = createNotification(db, { kind: 'task-done', summary: 'a' })!;
    createNotification(db, { kind: 'task-done', summary: 'b' });
    markNotificationRead(db, a.id);
    const list = listNotifications(db, { unreadOnly: true });
    expect(list).toHaveLength(1);
    expect(list[0]!.summary).toBe('b');
  });
});

describe('NotificationFanout', () => {
  it('emits approval-needed when a task transitions to proposed', () => {
    const db = openDatabase(':memory:');
    const broker = new Broker({
      db,
      getSpec: () => undefined,
      runAgent: async () => ({ text: '', sessionId: null, raw: { stdout: '', stderr: '' } }),
    });
    const created: Array<{ kind: string }> = [];
    const fanout = new NotificationFanout({
      db,
      broker,
      onCreated: (notification) => created.push({ kind: notification.kind }),
    });
    fanout.start();

    const room = createRoom(db, { name: 'r', agents: ['claude', 'codex'] });
    const task = createTask(db, { roomId: room.id, title: 't', proposalStatus: 'draft' });

    // First emit while still in draft — no notification.
    broker.emit('taskUpdated', { ...task });
    expect(created).toHaveLength(0);

    // Transition to proposed — notification fires.
    const proposed = setProposalStatus(db, task.id, 'proposed', 'claude');
    broker.emit('taskUpdated', proposed!);
    expect(created.map((c) => c.kind)).toEqual(['approval-needed']);

    // Re-emit same status — dedupe suppresses.
    broker.emit('taskUpdated', proposed!);
    expect(created).toHaveLength(1);

    fanout.stop();
  });

  it('emits run-failed when a run transitions to failed status', () => {
    const db = openDatabase(':memory:');
    const broker = new Broker({
      db,
      getSpec: () => undefined,
      runAgent: async () => ({ text: '', sessionId: null, raw: { stdout: '', stderr: '' } }),
    });
    const created: Array<{ kind: string; detail: string }> = [];
    const fanout = new NotificationFanout({
      db,
      broker,
      onCreated: (notification) =>
        created.push({ kind: notification.kind, detail: notification.detail }),
    });
    fanout.start();

    const room = createRoom(db, { name: 'r', agents: ['claude'] });
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

    const failed = updateAgentRun(db, run.id, { status: 'failed', error: 'kaboom' })!;
    broker.emit('agentRunUpdated', failed);
    expect(created).toHaveLength(1);
    expect(created[0]!.kind).toBe('run-failed');
    expect(created[0]!.detail).toContain('kaboom');

    fanout.stop();
  });
});

describe('notifications HTTP routes', () => {
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

  it('lists notifications + unread count', async () => {
    const { db, app } = buildApp();
    createNotification(db, { kind: 'task-done', summary: 'a' });
    createNotification(db, { kind: 'task-done', summary: 'b' });
    const res = await app.inject({ method: 'GET', url: '/api/notifications' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ notifications: unknown[]; unread: number }>();
    expect(body.notifications).toHaveLength(2);
    expect(body.unread).toBe(2);
  });

  it('marks one notification read', async () => {
    const { db, app } = buildApp();
    const created = createNotification(db, { kind: 'task-done', summary: 'a' })!;
    const res = await app.inject({ method: 'POST', url: `/api/notifications/${created.id}/read` });
    expect(res.statusCode).toBe(200);
    expect(countUnreadNotifications(db)).toBe(0);
  });

  it('marks all read', async () => {
    const { db, app } = buildApp();
    createNotification(db, { kind: 'task-done', summary: 'a' });
    createNotification(db, { kind: 'task-done', summary: 'b' });
    const res = await app.inject({ method: 'POST', url: '/api/notifications/read-all' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ marked: number }>().marked).toBe(2);
    expect(countUnreadNotifications(db)).toBe(0);
  });

  it('dismisses a notification (excludes by default afterward)', async () => {
    const { db, app } = buildApp();
    const created = createNotification(db, { kind: 'task-done', summary: 'a' })!;
    const res = await app.inject({ method: 'POST', url: `/api/notifications/${created.id}/dismiss` });
    expect(res.statusCode).toBe(200);
    const list = listNotifications(db);
    expect(list).toHaveLength(0);
  });

  it('returns 404 for unknown notification ids', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/notifications/nope/read' });
    expect(res.statusCode).toBe(404);
  });
});
