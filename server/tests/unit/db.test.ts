// server/tests/unit/db.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    expect(names).toContain('collaboration_items');
    expect(names).toContain('agent_run_actions');
    expect(names).toContain('task_phases');
    expect(names).toContain('task_checklist_items');
    expect(names).toContain('task_plans');
    expect(names).toContain('mission_briefings');
  });

  it('is idempotent — second open does not error', () => {
    const db = openDatabase(':memory:');
    expect(() => openDatabase(':memory:')).not.toThrow();
    db.close();
  });
  it('migrates legacy task tables that predate capability profiles', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fireside-legacy-db-'));
    const filename = path.join(dir, 'fireside.sqlite');
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        agents_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO rooms (id, name, created_at, agents_json) VALUES ('room-1', 'legacy', 1, '[]')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO tasks (id, room_id, title, created_at, updated_at)
         VALUES ('task-1', 'room-1', 'Legacy task', 1, 1)`,
      )
      .run();
    legacy.close();

    const db = openDatabase(filename);
    const task = db.prepare(`SELECT * FROM tasks WHERE id = 'task-1'`).get() as {
      capability_profile?: string;
      summary?: string;
      repo_path?: string;
    };

    expect(task.capability_profile).toBe('plan');
    expect(task.summary).toBe('');
    expect(task.repo_path).toBe('');
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (
            id, room_id, title, goal, repo_path, acceptance_criteria, agents_json, status,
            capability_profile, summary, created_at, updated_at
          ) VALUES ('task-2', 'room-1', 'New task', '', '', '', '[]', 'active', 'edit', '', 2, 2)`,
        )
        .run(),
    ).not.toThrow();
    db.close();
  });

  it('migrates legacy permission/run capability columns', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fireside-legacy-permissions-'));
    const filename = path.join(dir, 'fireside.sqlite');
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        agents_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL,
        author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent', 'system')),
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE permission_requests (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('plan', 'edit', 'full-auto')),
        target TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT
      );
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        trigger_message_id TEXT NOT NULL,
        reply_message_id TEXT,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'empty', 'permission-requested')),
        permission_mode TEXT NOT NULL CHECK (permission_mode IN ('plan', 'edit', 'full-auto')),
        prompt_chars INTEGER NOT NULL,
        estimated_prompt_tokens INTEGER NOT NULL,
        live_messages INTEGER NOT NULL,
        context_artifacts INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT NOT NULL DEFAULT ''
      );
    `);
    legacy.close();

    const db = openDatabase(filename);
    const permissionColumns = db
      .prepare(`PRAGMA table_info(permission_requests)`)
      .all() as Array<{ name: string }>;
    const runColumns = db.prepare(`PRAGMA table_info(agent_runs)`).all() as Array<{ name: string }>;

    expect(permissionColumns.map((row) => row.name)).toEqual(
      expect.arrayContaining(['requested_mode', 'capabilities_json', 'provider_profile']),
    );
    expect(runColumns.map((row) => row.name)).toEqual(
      expect.arrayContaining(['permission_capabilities_json', 'permission_provider_profile']),
    );
    db.close();
  });

  it('accepts blocked collaboration ledger status', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO rooms (id, name, created_at, agents_json) VALUES ('room-1', 'r', 1, '[]')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO collaboration_items (
            id, room_id, task_id, message_id, run_id, agent_id, kind, status, confidence,
            title, target, body, evidence_json, created_at
          ) VALUES ('item-1', 'room-1', NULL, NULL, NULL, 'claude', 'challenge', 'blocked', '',
            'blocked item', '', '', '[]', 1)`,
        )
        .run(),
    ).not.toThrow();
    db.close();
  });

  it('adds collaboration subject columns to legacy tables', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fireside-legacy-collab-subjects-'));
    const filename = path.join(dir, 'fireside.sqlite');
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        agents_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE collaboration_items (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        task_id TEXT,
        message_id TEXT,
        run_id TEXT,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('proposal', 'challenge', 'revision', 'decision', 'evidence')),
        status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'rejected', 'resolved', 'superseded', 'informational')),
        confidence TEXT NOT NULL DEFAULT '' CHECK (confidence IN ('', 'low', 'medium', 'high')),
        title TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    const db = openDatabase(filename);
    const columns = db
      .prepare(`PRAGMA table_info(collaboration_items)`)
      .all() as Array<{ name: string }>;

    expect(columns.map((row) => row.name)).toEqual(
      expect.arrayContaining(['subject_type', 'subject_id']),
    );
    db.close();
  });
});
