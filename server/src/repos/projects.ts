import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export const DEFAULT_PROJECT_ID = 'general';

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function ensureDefaultProject(db: Database): Project {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(DEFAULT_PROJECT_ID, 'General', 'Default project for existing missions.', now, now);
  return getProject(db, DEFAULT_PROJECT_ID)!;
}

export function createProject(
  db: Database,
  input: { name: string; description?: string },
): Project {
  const id = nanoid(12);
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects (id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.description ?? '', now, now);
  return getProject(db, id)!;
}

export function getProject(db: Database, id: string): Project | null {
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export function listProjects(db: Database): Project[] {
  const rows = db
    .prepare(`SELECT * FROM projects ORDER BY created_at ASC, name ASC`)
    .all() as ProjectRow[];
  return rows.map(rowToProject);
}

export function updateProject(
  db: Database,
  id: string,
  input: { name?: string; description?: string },
): Project | null {
  const existing = getProject(db, id);
  if (!existing) return null;
  const name = input.name ?? existing.name;
  const description = input.description ?? existing.description;
  db.prepare(`UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?`).run(
    name,
    description,
    Date.now(),
    id,
  );
  return getProject(db, id);
}
