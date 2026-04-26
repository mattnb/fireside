// server/tests/unit/db.test.ts
import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/db.js';

describe('openDatabase', () => {
  it('creates schema on a fresh in-memory db', () => {
    const db = openDatabase(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('rooms');
    expect(names).toContain('messages');
    expect(names).toContain('sessions');
  });

  it('is idempotent — second open does not error', () => {
    const db = openDatabase(':memory:');
    expect(() => openDatabase(':memory:')).not.toThrow();
    db.close();
  });
});
