import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import {
  createRoutingDecision,
  listRoutingDecisionsForRoom,
} from '../../src/repos/routing-decisions.js';

describe('routing decision repository', () => {
  it('stores decision trace for later explanation', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO rooms (id, name, created_at, agents_json) VALUES ('room-1', 'r', 1, '[]')`,
    ).run();

    const decision = createRoutingDecision(db, {
      roomId: 'room-1',
      authorId: 'human',
      kind: 'human-message',
      action: 'direct-agent-turn',
      reason: 'explicit-human-mention',
      responders: ['codex'],
      trace: [
        {
          id: 'explicit-mention',
          result: 'matched',
          reason: '@codex matched one room participant',
          agents: ['codex'],
        },
      ],
    });

    expect(decision).toMatchObject({
      roomId: 'room-1',
      kind: 'human-message',
      responders: ['codex'],
    });
    expect(listRoutingDecisionsForRoom(db, 'room-1')).toEqual([
      expect.objectContaining({
        action: 'direct-agent-turn',
        trace: [expect.objectContaining({ id: 'explicit-mention' })],
      }),
    ]);
    db.close();
  });
});
