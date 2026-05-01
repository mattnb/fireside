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
    const briefingForeignKeys = db
      .prepare(`PRAGMA foreign_key_list(mission_briefings)`)
      .all() as Array<{ from: string; table: string; on_delete: string }>;
    expect(briefingForeignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'room_id',
          table: 'rooms',
          on_delete: 'SET NULL',
        }),
      ]),
    );
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
    const permissionColumns = db.prepare(`PRAGMA table_info(permission_requests)`).all() as Array<{
      name: string;
    }>;
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

  it('reconciles leaked collaboration blocks from agent messages', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fireside-collab-reconcile-'));
    const filename = path.join(dir, 'fireside.sqlite');
    const initial = openDatabase(filename);
    initial
      .prepare(
        `INSERT INTO rooms (id, name, created_at, agents_json, yolo_agents_json)
         VALUES ('room-1', 'room', 1, '[]', '[]')`,
      )
      .run();
    initial
      .prepare(
        `INSERT INTO messages (id, room_id, author_id, author_kind, text, created_at)
         VALUES (?, 'room-1', 'claude', 'agent', ?, ?)`,
      )
      .run(
        'message-visible',
        [
          'Visible handoff.',
          '',
          '/collab-note',
          'kind: proposal',
          'title: Keep hidden ledger hidden',
          'target: collaboration panel',
          'status: open',
          'confidence: medium',
          'evidence: test:db',
          'body: The leaked block should become a ledger item.',
          '@end-collab-note',
        ].join('\n'),
        2,
      );
    initial
      .prepare(
        `INSERT INTO messages (id, room_id, author_id, author_kind, text, created_at)
         VALUES (?, 'room-1', 'codex', 'agent', ?, ?)`,
      )
      .run(
        'message-hidden-only',
        [
          '/collab-note',
          'kind: evidence',
          'title: Hidden-only note',
          'status: informational',
          'body: This message should disappear from chat.',
          '@end-collab-note',
        ].join('\n'),
        3,
      );
    for (const [runId, messageId, agentId, startedAt] of [
      ['run-visible', 'message-visible', 'claude', 2],
      ['run-hidden-only', 'message-hidden-only', 'codex', 3],
    ]) {
      initial
        .prepare(
          `INSERT INTO agent_runs (
            id, room_id, trigger_message_id, reply_message_id, agent_id, status, permission_mode,
            prompt_chars, estimated_prompt_tokens, live_messages, context_artifacts, started_at, completed_at
          ) VALUES (?, 'room-1', 'trigger-1', ?, ?, 'completed', 'plan', 10, 3, 1, 0, ?, ?)`,
        )
        .run(runId, messageId, agentId, startedAt, startedAt);
    }
    initial.close();

    const db = openDatabase(filename);
    const visibleMessage = db
      .prepare(`SELECT text FROM messages WHERE id = 'message-visible'`)
      .get() as { text: string } | undefined;
    const hiddenOnlyMessage = db
      .prepare(`SELECT id FROM messages WHERE id = 'message-hidden-only'`)
      .get() as { id: string } | undefined;
    const hiddenOnlyRun = db
      .prepare(`SELECT reply_message_id FROM agent_runs WHERE id = 'run-hidden-only'`)
      .get() as { reply_message_id: string | null } | undefined;
    const items = db
      .prepare(
        `SELECT title, message_id, run_id, agent_id, kind, status, confidence, body, evidence_json, created_at
         FROM collaboration_items
         WHERE room_id = 'room-1'
         ORDER BY created_at ASC`,
      )
      .all() as Array<{
      title: string;
      message_id: string | null;
      run_id: string | null;
      agent_id: string;
      kind: string;
      status: string;
      confidence: string;
      body: string;
      evidence_json: string;
      created_at: number;
    }>;

    expect(visibleMessage?.text).toBe('Visible handoff.');
    expect(hiddenOnlyMessage).toBeUndefined();
    expect(hiddenOnlyRun?.reply_message_id).toBeNull();
    expect(items).toEqual([
      expect.objectContaining({
        title: 'Keep hidden ledger hidden',
        message_id: 'message-visible',
        run_id: 'run-visible',
        agent_id: 'claude',
        kind: 'proposal',
        status: 'open',
        confidence: 'medium',
        body: 'The leaked block should become a ledger item.',
        created_at: 2,
      }),
      expect.objectContaining({
        title: 'Hidden-only note',
        message_id: null,
        run_id: 'run-hidden-only',
        agent_id: 'codex',
        kind: 'evidence',
        status: 'informational',
        created_at: 3,
      }),
    ]);
    expect(JSON.parse(items[0]!.evidence_json)).toEqual(['test:db']);
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
    const columns = db.prepare(`PRAGMA table_info(collaboration_items)`).all() as Array<{
      name: string;
    }>;

    expect(columns.map((row) => row.name)).toEqual(
      expect.arrayContaining(['subject_type', 'subject_id']),
    );
    db.close();
  });

  it('keeps saved mission briefings when their source room is deleted', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO rooms (id, name, created_at, agents_json, yolo_agents_json)
       VALUES ('room-1', 'room', 1, '[]', '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO mission_briefings (
        id, room_id, task_id, title, summary, created_by, created_at, message_count, run_count, payload_json
      ) VALUES ('briefing-1', 'room-1', NULL, 'snapshot', '', 'human', 2, 0, 0, ?)`,
    ).run(JSON.stringify({ version: 1, capturedAt: 2, room: { id: 'room-1', name: 'room' } }));

    db.prepare(`DELETE FROM rooms WHERE id = 'room-1'`).run();

    const briefing = db
      .prepare(`SELECT id, room_id FROM mission_briefings WHERE id = 'briefing-1'`)
      .get() as { id: string; room_id: string | null } | undefined;
    expect(briefing).toEqual({ id: 'briefing-1', room_id: null });
    db.close();
  });

  it('migrates legacy mission briefings away from room-delete cascade', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fireside-legacy-briefings-'));
    const filename = path.join(dir, 'fireside.sqlite');
    const legacy = new Database(filename);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        agents_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE mission_briefings (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        task_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        run_count INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL
      );
      INSERT INTO rooms (id, name, created_at, agents_json)
      VALUES ('room-1', 'legacy room', 1, '[]');
      INSERT INTO mission_briefings (
        id, room_id, task_id, title, summary, created_by, created_at, message_count, run_count, payload_json
      ) VALUES ('briefing-1', 'room-1', NULL, 'snapshot', '', 'human', 2, 0, 0, '{"version":1}');
    `);
    legacy.close();

    const db = openDatabase(filename);
    db.prepare(`DELETE FROM rooms WHERE id = 'room-1'`).run();
    const briefing = db
      .prepare(`SELECT id, room_id FROM mission_briefings WHERE id = 'briefing-1'`)
      .get() as { id: string; room_id: string | null } | undefined;
    expect(briefing).toEqual({ id: 'briefing-1', room_id: null });
    db.close();
  });
});
