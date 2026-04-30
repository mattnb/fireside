// server/tests/unit/rooms-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom, deleteRoom, getRoom, listRooms, setRoomAgents } from '../../src/repos/rooms.js';
import { addMessage, listMessages } from '../../src/repos/messages.js';
import {
  addPermissionRequest,
  listPermissionRequests,
} from '../../src/repos/permission-requests.js';
import { createAgentRun, listAgentRuns } from '../../src/repos/agent-runs.js';
import { getCliSessionId, upsertCliSessionId } from '../../src/repos/sessions.js';
import { createTask, listTasks, updateTask } from '../../src/repos/tasks.js';

describe('rooms repo', () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('creates and retrieves a room', () => {
    const room = createRoom(db, { name: 'general', agents: ['claude', 'codex'] });
    expect(room.id).toMatch(/.+/);
    expect(room.name).toBe('general');
    expect(room.agents).toEqual(['claude', 'codex']);
    expect(room.createdAt).toBeGreaterThan(0);

    const fetched = getRoom(db, room.id);
    expect(fetched).toEqual(room);
  });

  it('returns null when room not found', () => {
    expect(getRoom(db, 'nonexistent')).toBeNull();
  });

  it('lists rooms in creation order', () => {
    createRoom(db, { name: 'a', agents: [] });
    createRoom(db, { name: 'b', agents: [] });
    const rooms = listRooms(db);
    expect(rooms.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('updates room agents', () => {
    const room = createRoom(db, { name: 'general', agents: ['claude'] });
    setRoomAgents(db, room.id, ['claude', 'codex', 'gemini']);
    expect(getRoom(db, room.id)!.agents).toEqual(['claude', 'codex', 'gemini']);
  });

  it('setRoomAgents removes sessions for agents that are no longer in the room', () => {
    const room = createRoom(db, { name: 'general', agents: ['claude', 'codex'] });
    upsertCliSessionId(db, room.id, 'claude', 'session-claude');
    upsertCliSessionId(db, room.id, 'codex', 'session-codex');

    setRoomAgents(db, room.id, ['claude']); // removed codex

    expect(getRoom(db, room.id)!.agents).toEqual(['claude']);
    expect(getCliSessionId(db, room.id, 'claude')).toBe('session-claude');
    expect(getCliSessionId(db, room.id, 'codex')).toBeNull();
  });

  it('setRoomAgents preserves sessions for agents that remain in the room', () => {
    const room = createRoom(db, { name: 'general', agents: ['claude', 'codex'] });
    upsertCliSessionId(db, room.id, 'claude', 'session-claude');

    setRoomAgents(db, room.id, ['claude', 'gemini']); // claude stays, gemini added

    expect(getCliSessionId(db, room.id, 'claude')).toBe('session-claude');
    expect(getCliSessionId(db, room.id, 'gemini')).toBeNull();
  });

  it('deleteRoom removes the room and cascades messages', () => {
    const room = createRoom(db, { name: 'x', agents: ['claude'] });
    addMessage(db, { roomId: room.id, authorId: 'human', authorKind: 'human', text: 'hi' });
    const task = createTask(db, {
      roomId: room.id,
      title: 'test mission',
      capabilityProfile: 'edit',
    });
    createAgentRun(db, {
      roomId: room.id,
      taskId: task.id,
      triggerMessageId: 'msg-1',
      agentId: 'claude',
      permissionMode: 'edit',
      promptChars: 100,
      estimatedPromptTokens: 25,
      liveMessages: 1,
      contextArtifacts: 0,
    });
    addPermissionRequest(db, {
      roomId: room.id,
      agentId: 'claude',
      mode: 'edit',
      target: 'foo.txt',
      reason: 'test',
    });
    upsertCliSessionId(db, room.id, 'claude', 'session-abc');

    expect(deleteRoom(db, room.id)).toBe(true);

    expect(getRoom(db, room.id)).toBeNull();
    expect(listMessages(db, room.id)).toEqual([]);
    expect(listPermissionRequests(db, room.id)).toEqual([]);
    expect(listTasks(db, room.id)).toEqual([]);
    expect(listAgentRuns(db, room.id)).toEqual([]);
    expect(getCliSessionId(db, room.id, 'claude')).toBeNull();
  });

  it('keeps one active task per room and stores capability profiles', () => {
    const room = createRoom(db, { name: 'tasks', agents: ['claude'] });
    const first = createTask(db, {
      roomId: room.id,
      title: 'first',
      capabilityProfile: 'edit',
    });
    const second = createTask(db, {
      roomId: room.id,
      title: 'second',
      capabilityProfile: 'full-auto',
    });

    let tasks = listTasks(db, room.id);
    expect(tasks.find((task) => task.id === first.id)!.status).toBe('paused');
    expect(tasks.find((task) => task.id === second.id)!).toMatchObject({
      status: 'active',
      capabilityProfile: 'full-auto',
    });

    updateTask(db, first.id, { status: 'active', capabilityProfile: 'plan' });
    tasks = listTasks(db, room.id);
    expect(tasks.find((task) => task.id === first.id)!).toMatchObject({
      status: 'active',
      capabilityProfile: 'plan',
    });
    expect(tasks.find((task) => task.id === second.id)!.status).toBe('paused');
  });

  it('deleteRoom returns false for unknown id', () => {
    expect(deleteRoom(db, 'nonexistent')).toBe(false);
  });

  it('deleteRoom does not affect other rooms', () => {
    const a = createRoom(db, { name: 'a', agents: [] });
    const b = createRoom(db, { name: 'b', agents: [] });
    addMessage(db, { roomId: a.id, authorId: 'm', authorKind: 'human', text: 'in a' });
    addMessage(db, { roomId: b.id, authorId: 'm', authorKind: 'human', text: 'in b' });

    expect(deleteRoom(db, a.id)).toBe(true);
    expect(getRoom(db, b.id)).not.toBeNull();
    expect(listMessages(db, b.id)).toHaveLength(1);
  });
});
