// server/src/db.ts
import Database from 'better-sqlite3';
import type { Database as DbType } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { extractCollaborationNotes } from './collaboration-notes.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  agents_json TEXT NOT NULL DEFAULT '[]',
  yolo_agents_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent', 'system')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'delivered' CHECK (delivery_status IN ('queued', 'delivered'))
);

CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS message_read_receipts (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_message_read_receipts_room_message
  ON message_read_receipts(room_id, message_id);

CREATE INDEX IF NOT EXISTS idx_message_read_receipts_room_seen
  ON message_read_receipts(room_id, seen_at);

CREATE TABLE IF NOT EXISTS sessions (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  cli_session_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);

CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('plan', 'edit', 'full-auto')),
  requested_mode TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  target_exists INTEGER,
  target_kind TEXT NOT NULL DEFAULT 'unknown',
  target_resolved_path TEXT NOT NULL DEFAULT '',
  target_checked_at INTEGER NOT NULL DEFAULT 0,
  provider_profile TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_permission_requests_room_created
  ON permission_requests(room_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  repo_path TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  agents_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'blocked', 'verifying', 'done')),
  capability_profile TEXT NOT NULL DEFAULT 'plan' CHECK (capability_profile IN ('plan', 'edit', 'full-auto')),
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_phases (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES task_plans(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'blocked', 'done')),
  gate TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_phases_task_status_order
  ON task_phases(task_id, status, sort_order);

CREATE TABLE IF NOT EXISTS task_checklist_items (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES task_plans(id) ON DELETE SET NULL,
  phase_id TEXT REFERENCES task_phases(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('open', 'blocked', 'done', 'skipped')),
  dependency_ids_json TEXT NOT NULL DEFAULT '[]',
  expected_touches_json TEXT NOT NULL DEFAULT '[]',
  parallelism TEXT NOT NULL DEFAULT 'parallel-safe' CHECK (parallelism IN ('parallel-safe', 'coordinate', 'exclusive')),
  conflict_group TEXT NOT NULL DEFAULT '',
  work_role TEXT NOT NULL DEFAULT '',
  owner_agent_id TEXT NOT NULL DEFAULT '',
  status_note TEXT NOT NULL DEFAULT '',
  blocked_reason TEXT NOT NULL DEFAULT '',
  council_required INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL DEFAULT '',
  completed_at INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_checklist_items_task_status_order
  ON task_checklist_items(task_id, status, sort_order);

CREATE INDEX IF NOT EXISTS idx_task_checklist_items_phase
  ON task_checklist_items(phase_id);

CREATE TABLE IF NOT EXISTS task_checklist_notes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES task_checklist_items(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('status', 'completion', 'blocker', 'council')),
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_checklist_notes_item_created
  ON task_checklist_notes(item_id, created_at);

CREATE INDEX IF NOT EXISTS idx_task_checklist_notes_task_created
  ON task_checklist_notes(task_id, created_at);

CREATE TABLE IF NOT EXISTS task_plans (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded', 'archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_plans_task_status_updated
  ON task_plans(task_id, status, updated_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_job_id TEXT NOT NULL DEFAULT '',
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
  error TEXT NOT NULL DEFAULT '',
  prompt_text TEXT NOT NULL DEFAULT '',
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  reply_text TEXT NOT NULL DEFAULT '',
  cli_session_id TEXT,
  permission_source TEXT NOT NULL DEFAULT '',
  permission_target TEXT NOT NULL DEFAULT '',
  permission_reason TEXT NOT NULL DEFAULT '',
  permission_filesystem_scope TEXT NOT NULL DEFAULT '',
  permission_web INTEGER NOT NULL DEFAULT 0,
  permission_capabilities_json TEXT NOT NULL DEFAULT '[]',
  permission_target_exists INTEGER,
  permission_target_kind TEXT NOT NULL DEFAULT 'unknown',
  permission_target_resolved_path TEXT NOT NULL DEFAULT '',
  permission_target_checked_at INTEGER NOT NULL DEFAULT 0,
  permission_provider_profile TEXT NOT NULL DEFAULT '',
  lifecycle_state TEXT NOT NULL DEFAULT 'launching_agent_process',
  lifecycle_reason TEXT NOT NULL DEFAULT '',
  lifecycle_updated_at INTEGER NOT NULL DEFAULT 0,
  last_signal_at INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  continuation_turn INTEGER NOT NULL DEFAULT 1,
  max_turns INTEGER NOT NULL DEFAULT 1,
  workspace_path TEXT NOT NULL DEFAULT '',
  retry_of_run_id TEXT NOT NULL DEFAULT '',
  retry_after INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_room_started
  ON agent_runs(room_id, started_at);

CREATE INDEX IF NOT EXISTS idx_agent_runs_task_started
  ON agent_runs(task_id, started_at);

CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  checklist_item_id TEXT REFERENCES task_checklist_items(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'running', 'completed', 'failed', 'canceled', 'superseded')),
  work_packet_json TEXT NOT NULL DEFAULT '{}',
  permission_json TEXT NOT NULL DEFAULT '{}',
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_jobs_room_status_updated
  ON agent_jobs(room_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_agent_jobs_run
  ON agent_jobs(run_id);

CREATE TABLE IF NOT EXISTS collaboration_items (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  subject_type TEXT,
  subject_id TEXT,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('proposal', 'challenge', 'revision', 'decision', 'evidence')),
  status TEXT NOT NULL CHECK (status IN ('open', 'blocked', 'accepted', 'rejected', 'resolved', 'superseded', 'informational')),
  confidence TEXT NOT NULL DEFAULT '' CHECK (confidence IN ('', 'low', 'medium', 'high')),
  title TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collaboration_items_room_created
  ON collaboration_items(room_id, created_at);

CREATE INDEX IF NOT EXISTS idx_collaboration_items_task_created
  ON collaboration_items(task_id, created_at);

CREATE TABLE IF NOT EXISTS agent_run_actions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('prompt', 'run', 'permission', 'adapter', 'diagnostic', 'message', 'error', 'ledger')),
  status TEXT NOT NULL CHECK (status IN ('info', 'running', 'completed', 'failed')),
  label TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  context_usage_json TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_run_actions_room_created
  ON agent_run_actions(room_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_run_actions_run_created
  ON agent_run_actions(run_id, created_at);

CREATE TABLE IF NOT EXISTS mission_briefings (
  id TEXT PRIMARY KEY,
  room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  run_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mission_briefings_created
  ON mission_briefings(created_at);

CREATE INDEX IF NOT EXISTS idx_mission_briefings_room_created
  ON mission_briefings(room_id, created_at);
`;

function columnNames(db: DbType, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function ensureProjects(db: DbType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at)
     VALUES ('general', 'General', 'Default project for existing missions.', ?, ?)`,
  ).run(now, now);
}

function ensureRoomColumns(db: DbType): void {
  const columns = columnNames(db, 'rooms');
  if (!columns.has('yolo_agents_json')) {
    db.prepare(`ALTER TABLE rooms ADD COLUMN yolo_agents_json TEXT NOT NULL DEFAULT '[]'`).run();
  }
  if (!columns.has('project_id')) {
    db.prepare(`ALTER TABLE rooms ADD COLUMN project_id TEXT`).run();
  }
  db.prepare(
    `UPDATE rooms SET project_id = 'general' WHERE project_id IS NULL OR project_id = ''`,
  ).run();
}

function ensureMessageColumns(db: DbType): void {
  const columns = columnNames(db, 'messages');
  if (!columns.has('delivery_status')) {
    db.prepare(
      `ALTER TABLE messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'delivered'`,
    ).run();
  }
}

function ensureMessageReadReceiptTables(db: DbType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_read_receipts (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_message_read_receipts_room_message
      ON message_read_receipts(room_id, message_id);

    CREATE INDEX IF NOT EXISTS idx_message_read_receipts_room_seen
      ON message_read_receipts(room_id, seen_at);
  `);
}

function ensureAgentRunColumns(db: DbType): void {
  const columns = columnNames(db, 'agent_runs');
  const additions: Array<[string, string]> = [
    ['agent_job_id', "TEXT NOT NULL DEFAULT ''"],
    ['prompt_text', "TEXT NOT NULL DEFAULT ''"],
    ['stdout', "TEXT NOT NULL DEFAULT ''"],
    ['stderr', "TEXT NOT NULL DEFAULT ''"],
    ['reply_text', "TEXT NOT NULL DEFAULT ''"],
    ['cli_session_id', 'TEXT'],
    ['permission_source', "TEXT NOT NULL DEFAULT ''"],
    ['permission_target', "TEXT NOT NULL DEFAULT ''"],
    ['permission_reason', "TEXT NOT NULL DEFAULT ''"],
    ['permission_filesystem_scope', "TEXT NOT NULL DEFAULT ''"],
    ['permission_web', 'INTEGER NOT NULL DEFAULT 0'],
    ['permission_capabilities_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['permission_target_exists', 'INTEGER'],
    ['permission_target_kind', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['permission_target_resolved_path', "TEXT NOT NULL DEFAULT ''"],
    ['permission_target_checked_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['permission_provider_profile', "TEXT NOT NULL DEFAULT ''"],
    ['lifecycle_state', "TEXT NOT NULL DEFAULT 'launching_agent_process'"],
    ['lifecycle_reason', "TEXT NOT NULL DEFAULT ''"],
    ['lifecycle_updated_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_signal_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['attempt', 'INTEGER NOT NULL DEFAULT 1'],
    ['continuation_turn', 'INTEGER NOT NULL DEFAULT 1'],
    ['max_turns', 'INTEGER NOT NULL DEFAULT 1'],
    ['workspace_path', "TEXT NOT NULL DEFAULT ''"],
    ['retry_of_run_id', "TEXT NOT NULL DEFAULT ''"],
    ['retry_after', 'INTEGER NOT NULL DEFAULT 0'],
  ];

  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.prepare(`ALTER TABLE agent_runs ADD COLUMN ${name} ${definition}`).run();
    }
  }
}

function ensureAgentJobTables(db: DbType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      checklist_item_id TEXT REFERENCES task_checklist_items(id) ON DELETE SET NULL,
      agent_id TEXT NOT NULL,
      trigger_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'running', 'completed', 'failed', 'canceled', 'superseded')),
      work_packet_json TEXT NOT NULL DEFAULT '{}',
      permission_json TEXT NOT NULL DEFAULT '{}',
      lease_owner TEXT NOT NULL DEFAULT '',
      lease_expires_at INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 1,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_agent_jobs_room_status_updated
      ON agent_jobs(room_id, status, updated_at);

    CREATE INDEX IF NOT EXISTS idx_agent_jobs_run
      ON agent_jobs(run_id);
  `);
}

function ensureAgentRunActionColumns(db: DbType): void {
  const columns = columnNames(db, 'agent_run_actions');
  if (!columns.has('context_usage_json')) {
    db.prepare(
      `ALTER TABLE agent_run_actions ADD COLUMN context_usage_json TEXT NOT NULL DEFAULT ''`,
    ).run();
  }
}

function ensurePermissionRequestColumns(db: DbType): void {
  const columns = columnNames(db, 'permission_requests');
  const additions: Array<[string, string]> = [
    ['requested_mode', "TEXT NOT NULL DEFAULT ''"],
    ['capabilities_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['target_exists', 'INTEGER'],
    ['target_kind', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['target_resolved_path', "TEXT NOT NULL DEFAULT ''"],
    ['target_checked_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['provider_profile', "TEXT NOT NULL DEFAULT ''"],
  ];

  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.prepare(`ALTER TABLE permission_requests ADD COLUMN ${name} ${definition}`).run();
    }
  }
}

function ensureTaskColumns(db: DbType): void {
  const columns = columnNames(db, 'tasks');
  const additions: Array<[string, string]> = [
    ['goal', "TEXT NOT NULL DEFAULT ''"],
    ['repo_path', "TEXT NOT NULL DEFAULT ''"],
    ['acceptance_criteria', "TEXT NOT NULL DEFAULT ''"],
    ['agents_json', "TEXT NOT NULL DEFAULT '[]'"],
    [
      'status',
      "TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'blocked', 'verifying', 'done'))",
    ],
    [
      'capability_profile',
      "TEXT NOT NULL DEFAULT 'plan' CHECK (capability_profile IN ('plan', 'edit', 'full-auto'))",
    ],
    ['summary', "TEXT NOT NULL DEFAULT ''"],
    ['created_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
  ];

  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.prepare(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`).run();
    }
  }
}

function ensureTaskIndexes(db: DbType): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_room_status_updated
      ON tasks(room_id, status, updated_at);
  `);
}

function ensureMissionControlTables(db: DbType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_phases (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      plan_id TEXT REFERENCES task_plans(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'blocked', 'done')),
      gate TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_phases_task_status_order
      ON task_phases(task_id, status, sort_order);

    CREATE TABLE IF NOT EXISTS task_checklist_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      plan_id TEXT REFERENCES task_plans(id) ON DELETE SET NULL,
      phase_id TEXT REFERENCES task_phases(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('open', 'blocked', 'done', 'skipped')),
      dependency_ids_json TEXT NOT NULL DEFAULT '[]',
      expected_touches_json TEXT NOT NULL DEFAULT '[]',
      parallelism TEXT NOT NULL DEFAULT 'parallel-safe' CHECK (parallelism IN ('parallel-safe', 'coordinate', 'exclusive')),
      conflict_group TEXT NOT NULL DEFAULT '',
      work_role TEXT NOT NULL DEFAULT '',
      owner_agent_id TEXT NOT NULL DEFAULT '',
      status_note TEXT NOT NULL DEFAULT '',
      blocked_reason TEXT NOT NULL DEFAULT '',
      council_required INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT NOT NULL DEFAULT '',
      completed_at INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_checklist_items_task_status_order
      ON task_checklist_items(task_id, status, sort_order);

    CREATE INDEX IF NOT EXISTS idx_task_checklist_items_phase
      ON task_checklist_items(phase_id);

    CREATE TABLE IF NOT EXISTS task_plans (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded', 'archived')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_plans_task_status_updated
      ON task_plans(task_id, status, updated_at);
  `);

  const phaseColumns = columnNames(db, 'task_phases');
  if (!phaseColumns.has('plan_id')) {
    db.prepare(
      `ALTER TABLE task_phases ADD COLUMN plan_id TEXT REFERENCES task_plans(id) ON DELETE SET NULL`,
    ).run();
  }

  const checklistColumns = columnNames(db, 'task_checklist_items');
  if (!checklistColumns.has('plan_id')) {
    db.prepare(
      `ALTER TABLE task_checklist_items ADD COLUMN plan_id TEXT REFERENCES task_plans(id) ON DELETE SET NULL`,
    ).run();
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_phases_plan
      ON task_phases(plan_id);

    CREATE INDEX IF NOT EXISTS idx_task_checklist_items_plan
      ON task_checklist_items(plan_id);
  `);
}

function ensureTaskChecklistColumns(db: DbType): void {
  const columns = columnNames(db, 'task_checklist_items');
  const additions: Array<[string, string]> = [
    ['dependency_ids_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['expected_touches_json', "TEXT NOT NULL DEFAULT '[]'"],
    [
      'parallelism',
      "TEXT NOT NULL DEFAULT 'parallel-safe' CHECK (parallelism IN ('parallel-safe', 'coordinate', 'exclusive'))",
    ],
    ['conflict_group', "TEXT NOT NULL DEFAULT ''"],
    ['work_role', "TEXT NOT NULL DEFAULT ''"],
    ['owner_agent_id', "TEXT NOT NULL DEFAULT ''"],
    ['status_note', "TEXT NOT NULL DEFAULT ''"],
    ['blocked_reason', "TEXT NOT NULL DEFAULT ''"],
    ['council_required', 'INTEGER NOT NULL DEFAULT 0'],
    ['updated_by', "TEXT NOT NULL DEFAULT ''"],
    ['completed_at', 'INTEGER'],
  ];

  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.prepare(`ALTER TABLE task_checklist_items ADD COLUMN ${name} ${definition}`).run();
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_checklist_notes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES task_checklist_items(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('status', 'completion', 'blocker', 'council')),
      body TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_checklist_notes_item_created
      ON task_checklist_notes(item_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_task_checklist_notes_task_created
      ON task_checklist_notes(task_id, created_at);
  `);
}

function ensureCollaborationSubjectColumns(db: DbType): void {
  const columns = columnNames(db, 'collaboration_items');
  const additions: Array<[string, string]> = [
    ['subject_type', 'TEXT'],
    ['subject_id', 'TEXT'],
  ];

  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.prepare(`ALTER TABLE collaboration_items ADD COLUMN ${name} ${definition}`).run();
    }
  }
}

function ensureCollaborationStatusConstraint(db: DbType): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'collaboration_items'`)
    .get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'blocked'")) return;
  const columns = columnNames(db, 'collaboration_items');
  const subjectTypeSelect = columns.has('subject_type') ? 'subject_type' : 'NULL';
  const subjectIdSelect = columns.has('subject_id') ? 'subject_id' : 'NULL';

  db.pragma('foreign_keys = OFF');
  db.exec(`
    ALTER TABLE collaboration_items RENAME TO collaboration_items_old;

    CREATE TABLE collaboration_items (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      subject_type TEXT,
      subject_id TEXT,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('proposal', 'challenge', 'revision', 'decision', 'evidence')),
      status TEXT NOT NULL CHECK (status IN ('open', 'blocked', 'accepted', 'rejected', 'resolved', 'superseded', 'informational')),
      confidence TEXT NOT NULL DEFAULT '' CHECK (confidence IN ('', 'low', 'medium', 'high')),
      title TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    INSERT INTO collaboration_items (
      id, room_id, task_id, subject_type, subject_id, message_id, run_id, agent_id, kind, status, confidence,
      title, target, body, evidence_json, created_at
    )
    SELECT
      id, room_id, task_id, ${subjectTypeSelect}, ${subjectIdSelect}, message_id, run_id, agent_id, kind, status, confidence,
      title, target, body, evidence_json, created_at
    FROM collaboration_items_old;

    DROP TABLE collaboration_items_old;
  `);
  db.pragma('foreign_keys = ON');
}

function ensureCollaborationIndexes(db: DbType): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_collaboration_items_room_created
      ON collaboration_items(room_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_collaboration_items_task_created
      ON collaboration_items(task_id, created_at);
  `);
}

interface LeakedCollaborationMessageRow {
  id: string;
  room_id: string;
  author_id: string;
  text: string;
  created_at: number;
}

interface AgentRunForMessageRow {
  id: string;
  task_id: string | null;
}

function bounded(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function collaborationItemAlreadyStored(
  db: DbType,
  input: {
    roomId: string;
    agentId: string;
    kind: string;
    title: string;
    target: string;
    body: string;
    createdAt: number;
  },
): boolean {
  const row = db
    .prepare(
      `SELECT id FROM collaboration_items
       WHERE room_id = ?
         AND agent_id = ?
         AND kind = ?
         AND title = ?
         AND target = ?
         AND body = ?
         AND created_at = ?
       LIMIT 1`,
    )
    .get(
      input.roomId,
      input.agentId,
      input.kind,
      input.title,
      input.target,
      input.body,
      input.createdAt,
    ) as { id: string } | undefined;
  return Boolean(row);
}

function reconcileLeakedCollaborationNotes(db: DbType): void {
  const rows = db
    .prepare(
      `SELECT id, room_id, author_id, text, created_at
       FROM messages
       WHERE author_kind = 'agent'
         AND text LIKE '%/collab-note%'
         AND (text LIKE '%/end-collab-note%' OR text LIKE '%@end-collab-note%')`,
    )
    .all() as LeakedCollaborationMessageRow[];
  if (rows.length === 0) return;

  const findRun = db.prepare(
    `SELECT id, task_id
     FROM agent_runs
     WHERE reply_message_id = ?
     ORDER BY completed_at DESC, started_at DESC
     LIMIT 1`,
  );
  const insertItem = db.prepare(
    `INSERT INTO collaboration_items (
      id, room_id, task_id, subject_type, subject_id, message_id, run_id, agent_id, kind, status, confidence,
      title, target, body, evidence_json, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateMessage = db.prepare(`UPDATE messages SET text = ? WHERE id = ?`);
  const clearRunReply = db.prepare(
    `UPDATE agent_runs SET reply_message_id = NULL WHERE reply_message_id = ?`,
  );
  const deleteMessage = db.prepare(`DELETE FROM messages WHERE id = ?`);

  const repair = db.transaction((messages: LeakedCollaborationMessageRow[]) => {
    for (const message of messages) {
      const extracted = extractCollaborationNotes(message.text);
      if (extracted.notes.length === 0) continue;

      const visibleText = extracted.visibleText.trim();
      const run = findRun.get(message.id) as AgentRunForMessageRow | undefined;
      const retainedMessageId = visibleText ? message.id : null;

      for (const note of extracted.notes) {
        const title = bounded(note.title, 240);
        const target = bounded(note.target, 500);
        const body = bounded(note.body, 2000);
        if (
          collaborationItemAlreadyStored(db, {
            roomId: message.room_id,
            agentId: message.author_id,
            kind: note.kind,
            title,
            target,
            body,
            createdAt: message.created_at,
          })
        ) {
          continue;
        }
        insertItem.run(
          nanoid(16),
          message.room_id,
          run?.task_id ?? null,
          retainedMessageId,
          run?.id ?? null,
          message.author_id,
          note.kind,
          note.status,
          note.confidence,
          title,
          target,
          body,
          JSON.stringify(note.evidence.map((item) => bounded(item, 500)).slice(0, 12)),
          message.created_at,
        );
      }

      if (visibleText) {
        updateMessage.run(visibleText, message.id);
      } else {
        clearRunReply.run(message.id);
        deleteMessage.run(message.id);
      }
    }
  });

  repair(rows);
}

function ensureMissionBriefingTables(db: DbType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mission_briefings (
      id TEXT PRIMARY KEY,
      room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      run_count INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mission_briefings_created
      ON mission_briefings(created_at);

    CREATE INDEX IF NOT EXISTS idx_mission_briefings_room_created
      ON mission_briefings(room_id, created_at);
  `);
  ensureMissionBriefingRetention(db);
}

function ensureMissionBriefingRetention(db: DbType): void {
  const columns = db.prepare(`PRAGMA table_info(mission_briefings)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  const roomColumn = columns.find((column) => column.name === 'room_id');
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(mission_briefings)`).all() as Array<{
    from: string;
    table: string;
    on_delete: string;
  }>;
  const roomForeignKey = foreignKeys.find(
    (foreignKey) => foreignKey.from === 'room_id' && foreignKey.table === 'rooms',
  );
  const needsMigration =
    roomColumn?.notnull === 1 || roomForeignKey?.on_delete.toUpperCase() === 'CASCADE';
  if (!needsMigration) return;

  db.pragma('foreign_keys = OFF');
  db.exec(`
    ALTER TABLE mission_briefings RENAME TO mission_briefings_old;

    CREATE TABLE mission_briefings (
      id TEXT PRIMARY KEY,
      room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      run_count INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL
    );

    INSERT INTO mission_briefings (
      id, room_id, task_id, title, summary, created_by, created_at, message_count, run_count, payload_json
    )
    SELECT
      id, room_id, task_id, title, summary, created_by, created_at, message_count, run_count, payload_json
    FROM mission_briefings_old;

    DROP TABLE mission_briefings_old;

    CREATE INDEX IF NOT EXISTS idx_mission_briefings_created
      ON mission_briefings(created_at);

    CREATE INDEX IF NOT EXISTS idx_mission_briefings_room_created
      ON mission_briefings(room_id, created_at);
  `);
  db.pragma('foreign_keys = ON');
}

export function openDatabase(filename: string): DbType {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  ensureProjects(db);
  ensureRoomColumns(db);
  ensureMessageColumns(db);
  ensureMessageReadReceiptTables(db);
  ensurePermissionRequestColumns(db);
  ensureTaskColumns(db);
  ensureTaskIndexes(db);
  ensureMissionControlTables(db);
  ensureTaskChecklistColumns(db);
  ensureAgentRunColumns(db);
  ensureAgentJobTables(db);
  ensureAgentRunActionColumns(db);
  ensureCollaborationStatusConstraint(db);
  ensureCollaborationSubjectColumns(db);
  ensureCollaborationIndexes(db);
  reconcileLeakedCollaborationNotes(db);
  ensureMissionBriefingTables(db);
  return db;
}
