// server/tests/unit/sessions-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { getCliSessionId, upsertCliSessionId } from '../../src/repos/sessions.js';

describe('sessions repo', () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('returns null for missing (room, agent)', () => {
    expect(getCliSessionId(db, 'r1', 'claude')).toBeNull();
  });

  it('upserts a new session id', () => {
    upsertCliSessionId(db, 'r1', 'claude', 'cs-abc');
    expect(getCliSessionId(db, 'r1', 'claude')).toBe('cs-abc');
  });

  it('updates an existing session id (latest wins)', () => {
    upsertCliSessionId(db, 'r1', 'claude', 'cs-old');
    upsertCliSessionId(db, 'r1', 'claude', 'cs-new');
    expect(getCliSessionId(db, 'r1', 'claude')).toBe('cs-new');
  });

  it('isolates sessions per (room, agent)', () => {
    upsertCliSessionId(db, 'r1', 'claude', 'A');
    upsertCliSessionId(db, 'r1', 'codex', 'B');
    upsertCliSessionId(db, 'r2', 'claude', 'C');
    expect(getCliSessionId(db, 'r1', 'claude')).toBe('A');
    expect(getCliSessionId(db, 'r1', 'codex')).toBe('B');
    expect(getCliSessionId(db, 'r2', 'claude')).toBe('C');
  });
});
