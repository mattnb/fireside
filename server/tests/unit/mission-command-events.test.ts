import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import {
  createMissionCommandEvent,
  listMissionCommandEventsForRoom,
} from '../../src/repos/mission-command-events.js';

describe('mission command event repository', () => {
  it('stores parsed/applied hidden command events', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO rooms (id, name, created_at, agents_json) VALUES ('room-1', 'r', 1, '[]')`,
    ).run();

    const event = createMissionCommandEvent(db, {
      roomId: 'room-1',
      taskId: null,
      runId: null,
      agentId: 'claude',
      commandKind: 'mission-task',
      action: 'update',
      targetRef: 'item-1',
      status: 'applied',
      summary: 'checklist item updated',
      payload: { id: 'item-1', status: 'done' },
    });

    expect(event).toMatchObject({
      commandKind: 'mission-task',
      targetRef: 'item-1',
      status: 'applied',
    });
    expect(listMissionCommandEventsForRoom(db, 'room-1')).toEqual([
      expect.objectContaining({
        payload: { id: 'item-1', status: 'done' },
      }),
    ]);
    db.close();
  });
});
