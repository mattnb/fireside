// server/tests/unit/rooms-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom, getRoom, listRooms, setRoomAgents } from '../../src/repos/rooms.js';

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
});
