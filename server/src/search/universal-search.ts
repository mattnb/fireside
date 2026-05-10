// server/src/search/universal-search.ts
//
// Universal cross-room search. Returns a flat list of `SearchHit` objects
// drawn from the principal data sources fireside accumulates: rooms,
// projects, tasks (and their phases / plans / checklist items / acceptance
// criteria / clarifying questions), messages, run actions, and collaboration
// items.
//
// The search uses straight SQL `LIKE` scans plus an in-memory ranker. There
// is no FTS5 virtual table because the entire data set is local and small
// (single-user harness, ~megabytes of text), the index would need migrations
// + triggers, and we want zero-cost correctness — what you can see in the DB
// is what you can search. Snippets are computed in JS so callers can render
// the match boundaries however they like.
//
// All sources support an optional `roomId` and `taskId` filter, applied at
// the SQL layer to avoid pulling rows we'd just discard later.

import type { Database } from 'better-sqlite3';

export const SEARCH_KINDS = [
  'room',
  'project',
  'task',
  'phase',
  'plan',
  'checklist',
  'acceptance',
  'clarifying',
  'message',
  'activity',
  'collab',
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export interface SearchHit {
  kind: SearchKind;
  /** Primary key in the source table. */
  id: string;
  /** Human-readable title (room name, task title, message preview, etc). */
  title: string;
  /** Snippet around the first match. Truncated to ~140 chars. */
  snippet: string;
  /** Match offsets within `snippet`, in sorted order. UI uses these to wrap
   *  matches in `<mark>` tags without re-running the query in the browser. */
  matches: Array<{ start: number; end: number }>;
  /** Score in [0, ∞). Higher = better. Title hits dominate body hits. */
  score: number;
  /** Owning room when applicable. */
  roomId: string | null;
  /** Owning task when applicable. */
  taskId: string | null;
  /** Source row's createdAt or updatedAt — used as a recency tiebreaker. */
  timestamp: number | null;
  /** Free-form context label (e.g., agent id, status, kind). */
  context: string;
}

export interface SearchOptions {
  /** Restrict to these kinds. Empty/undefined = all kinds. */
  scope?: readonly SearchKind[];
  /** Restrict to a single room. */
  roomId?: string;
  /** Restrict to a single task. */
  taskId?: string;
  /** Cap on returned hits. Defaults to 50, max 200. */
  limit?: number;
  /** When > 0, expanded snippet length around the first match. */
  snippetChars?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_SNIPPET_CHARS = 140;

const TITLE_HIT_SCORE = 8;
const BODY_HIT_SCORE = 1;
const BODY_HIT_CAP = 5;

function escapeLike(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Returns the offsets of every (case-insensitive) substring match. */
function findAllMatches(text: string, query: string): Array<{ start: number; end: number }> {
  if (!text || !query) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx === -1) break;
    out.push({ start: idx, end: idx + needle.length });
    cursor = idx + needle.length;
  }
  return out;
}

interface SnippetOutput {
  snippet: string;
  matches: Array<{ start: number; end: number }>;
}

/** Builds a snippet around the first match, with all matches inside the
 *  visible window translated to snippet-relative offsets. */
function buildSnippet(text: string, query: string, snippetChars: number): SnippetOutput {
  if (!text) return { snippet: '', matches: [] };
  const allMatches = findAllMatches(text, query);
  if (allMatches.length === 0) {
    const snippet = text.length > snippetChars ? `${text.slice(0, snippetChars - 1).trimEnd()}…` : text;
    return { snippet, matches: [] };
  }
  const first = allMatches[0]!;
  // Center the window on the first match. Bias slightly to the left so the
  // match isn't at the very start (some context is helpful).
  const margin = Math.max(20, Math.floor((snippetChars - (first.end - first.start)) / 2));
  let start = Math.max(0, first.start - margin);
  let end = Math.min(text.length, start + snippetChars);
  // If we hit the right edge, shift the window left to use full snippetChars.
  if (end - start < snippetChars) {
    start = Math.max(0, end - snippetChars);
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const visibleText = text.slice(start, end);
  const snippet = prefix + visibleText + suffix;
  const offsetShift = prefix.length - start;
  const matchesInWindow = allMatches
    .filter((m) => m.start >= start && m.end <= end)
    .map((m) => ({ start: m.start + offsetShift, end: m.end + offsetShift }));
  return { snippet, matches: matchesInWindow };
}

/** Score a hit. Title matches are worth far more than body matches; recency
 *  acts as a tiebreaker. */
function scoreHit(opts: {
  title: string;
  body: string;
  query: string;
  timestamp: number | null;
  now: number;
}): number {
  const titleHits = findAllMatches(opts.title, opts.query).length;
  const bodyHits = Math.min(findAllMatches(opts.body, opts.query).length, BODY_HIT_CAP);
  let score = titleHits * TITLE_HIT_SCORE + bodyHits * BODY_HIT_SCORE;
  if (opts.timestamp !== null) {
    // Younger rows get up to +0.5; >30 days old contribute 0. Strictly
    // ordered with each other but always less than a single body hit, so
    // recency only breaks ties.
    const ageMs = Math.max(0, opts.now - opts.timestamp);
    const recencyBoost = Math.max(0, 0.5 * (1 - ageMs / (30 * 24 * 60 * 60 * 1000)));
    score += recencyBoost;
  }
  return score;
}

interface RowContext {
  query: string;
  snippetChars: number;
  now: number;
}

function makeHit(opts: {
  kind: SearchKind;
  id: string;
  title: string;
  body: string;
  roomId: string | null;
  taskId: string | null;
  timestamp: number | null;
  context: string;
  ctx: RowContext;
}): SearchHit | null {
  const { snippet, matches } = buildSnippet(opts.body || opts.title, opts.ctx.query, opts.ctx.snippetChars);
  const score = scoreHit({
    title: opts.title,
    body: opts.body,
    query: opts.ctx.query,
    timestamp: opts.timestamp,
    now: opts.ctx.now,
  });
  if (score <= 0) return null;
  return {
    kind: opts.kind,
    id: opts.id,
    title: opts.title,
    snippet,
    matches,
    score,
    roomId: opts.roomId,
    taskId: opts.taskId,
    timestamp: opts.timestamp,
    context: opts.context,
  };
}

interface SourceQuery {
  kind: SearchKind;
  /** SQL with `?` placeholders. The first placeholder pair must be the LIKE
   *  expressions for whichever fields are being scanned. The query MUST
   *  return rows that the per-source `mapper` can convert to a SearchHit. */
  buildQuery(opts: {
    roomId?: string;
    taskId?: string;
  }): { sql: string; params: unknown[] };
  /** Convert raw rows into SearchHit. Sources may return null to skip. */
  mapper(row: Record<string, unknown>, ctx: RowContext): SearchHit | null;
}

const SOURCES: Record<SearchKind, SourceQuery> = {
  room: {
    kind: 'room',
    buildQuery: (opts) => {
      const filters: string[] = [];
      const params: unknown[] = [];
      // Match name only (rooms don't carry a description).
      filters.push('name LIKE ? ESCAPE ?');
      params.push('%LIKE%', '\\');
      if (opts.roomId) {
        filters.push('id = ?');
        params.push(opts.roomId);
      }
      return { sql: `SELECT id, name, created_at FROM rooms WHERE ${filters.join(' AND ')}`, params };
    },
    mapper: (row, ctx) => {
      const name = String(row['name'] ?? '');
      return makeHit({
        kind: 'room',
        id: String(row['id']),
        title: name,
        body: name,
        roomId: String(row['id']),
        taskId: null,
        timestamp: typeof row['created_at'] === 'number' ? row['created_at'] : null,
        context: 'room',
        ctx,
      });
    },
  },
  project: {
    kind: 'project',
    buildQuery: () => ({
      sql: `SELECT id, name, description, updated_at FROM projects WHERE archived_at IS NULL AND (name LIKE ? ESCAPE ? OR description LIKE ? ESCAPE ?)`,
      params: ['%LIKE%', '\\', '%LIKE%', '\\'],
    }),
    mapper: (row, ctx) => {
      const name = String(row['name'] ?? '');
      const description = String(row['description'] ?? '');
      return makeHit({
        kind: 'project',
        id: String(row['id']),
        title: name,
        body: `${name}\n${description}`,
        roomId: null,
        taskId: null,
        timestamp: typeof row['updated_at'] === 'number' ? row['updated_at'] : null,
        context: 'project',
        ctx,
      });
    },
  },
  task: {
    kind: 'task',
    buildQuery: (opts) => {
      const filters: string[] = [
        '(title LIKE ? ESCAPE ? OR goal LIKE ? ESCAPE ? OR acceptance_criteria LIKE ? ESCAPE ? OR summary LIKE ? ESCAPE ?)',
      ];
      const params: unknown[] = ['%LIKE%', '\\', '%LIKE%', '\\', '%LIKE%', '\\', '%LIKE%', '\\'];
      if (opts.roomId) {
        filters.push('room_id = ?');
        params.push(opts.roomId);
      }
      if (opts.taskId) {
        filters.push('id = ?');
        params.push(opts.taskId);
      }
      return {
        sql: `SELECT id, room_id, title, goal, acceptance_criteria, summary, status, updated_at
              FROM tasks WHERE ${filters.join(' AND ')}`,
        params,
      };
    },
    mapper: (row, ctx) => {
      const title = String(row['title'] ?? '');
      const body = [row['goal'], row['acceptance_criteria'], row['summary']]
        .map((value) => String(value ?? ''))
        .filter(Boolean)
        .join('\n');
      return makeHit({
        kind: 'task',
        id: String(row['id']),
        title,
        body: `${title}\n${body}`,
        roomId: row['room_id'] !== null && row['room_id'] !== undefined ? String(row['room_id']) : null,
        taskId: String(row['id']),
        timestamp: typeof row['updated_at'] === 'number' ? row['updated_at'] : null,
        context: `task · ${String(row['status'] ?? '')}`,
        ctx,
      });
    },
  },
  phase: {
    kind: 'phase',
    buildQuery: (opts) => {
      const filters: string[] = ['(p.title LIKE ? ESCAPE ? OR p.description LIKE ? ESCAPE ?)'];
      const params: unknown[] = ['%LIKE%', '\\', '%LIKE%', '\\'];
      if (opts.taskId) {
        filters.push('p.task_id = ?');
        params.push(opts.taskId);
      }
      if (opts.roomId) {
        filters.push('t.room_id = ?');
        params.push(opts.roomId);
      }
      return {
        sql: `SELECT p.id, p.task_id, p.title, p.description, p.status, p.updated_at, t.room_id
              FROM task_phases p JOIN tasks t ON t.id = p.task_id
              WHERE ${filters.join(' AND ')}`,
        params,
      };
    },
    mapper: (row, ctx) => {
      const title = String(row['title'] ?? '');
      const description = String(row['description'] ?? '');
      return makeHit({
        kind: 'phase',
        id: String(row['id']),
        title,
        body: `${title}\n${description}`,
        roomId: row['room_id'] !== null && row['room_id'] !== undefined ? String(row['room_id']) : null,
        taskId: String(row['task_id']),
        timestamp: typeof row['updated_at'] === 'number' ? row['updated_at'] : null,
        context: `phase · ${String(row['status'] ?? '')}`,
        ctx,
      });
    },
  },
  plan: {
    kind: 'plan',
    buildQuery: (opts) => {
      const filters: string[] = ['(p.title LIKE ? ESCAPE ? OR p.body LIKE ? ESCAPE ?)'];
      const params: unknown[] = ['%LIKE%', '\\', '%LIKE%', '\\'];
      if (opts.taskId) {
        filters.push('p.task_id = ?');
        params.push(opts.taskId);
      }
      if (opts.roomId) {
        filters.push('t.room_id = ?');
        params.push(opts.roomId);
      }
      return {
        sql: `SELECT p.id, p.task_id, p.title, p.body, p.status, p.updated_at, t.room_id
              FROM task_plans p JOIN tasks t ON t.id = p.task_id
              WHERE ${filters.join(' AND ')}`,
        params,
      };
    },
    mapper: (row, ctx) => {
      const title = String(row['title'] ?? '');
      const body = String(row['body'] ?? '');
      return makeHit({
        kind: 'plan',
        id: String(row['id']),
        title,
        body: `${title}\n${body}`,
        roomId: row['room_id'] !== null && row['room_id'] !== undefined ? String(row['room_id']) : null,
        taskId: String(row['task_id']),
        timestamp: typeof row['updated_at'] === 'number' ? row['updated_at'] : null,
        context: `plan · ${String(row['status'] ?? '')}`,
        ctx,
      });
    },
  },
  checklist: {
    kind: 'checklist',
    buildQuery: (opts) => {
      const filters: string[] = [
        '(c.title LIKE ? ESCAPE ? OR c.detail LIKE ? ESCAPE ? OR c.status_note LIKE ? ESCAPE ? OR c.blocked_reason LIKE ? ESCAPE ?)',
      ];
      const params: unknown[] = ['%LIKE%', '\\', '%LIKE%', '\\', '%LIKE%', '\\', '%LIKE%', '\\'];
      if (opts.taskId) {
        filters.push('c.task_id = ?');
        params.push(opts.taskId);
      }
      if (opts.roomId) {
        filters.push('t.room_id = ?');
        params.push(opts.roomId);
      }
      return {
        sql: `SELECT c.id, c.task_id, c.title, c.detail, c.status, c.status_note, c.blocked_reason,
                     c.updated_at, t.room_id
              FROM task_checklist_items c JOIN tasks t ON t.id = c.task_id
              WHERE ${filters.join(' AND ')}`,
        params,
      };
    },
    mapper: (row, ctx) => {
      const title = String(row['title'] ?? '');
      const body = [row['detail'], row['status_note'], row['blocked_reason']]
        .map((value) => String(value ?? ''))
        .filter(Boolean)
        .join('\n');
      return makeHit({
        kind: 'checklist',
        id: String(row['id']),
        title,
        body: `${title}\n${body}`,
        roomId: row['room_id'] !== null && row['room_id'] !== undefined ? String(row['room_id']) : null,
        taskId: String(row['task_id']),
        timestamp: typeof row['updated_at'] === 'number' ? row['updated_at'] : null,
        context: `checklist · ${String(row['status'] ?? '')}`,
        ctx,
      });
    },
  },
  acceptance: {
    kind: 'acceptance',
    buildQuery: (opts) => {
      const filters: string[] = [
        '(a.title LIKE ? ESCAPE ? OR a.detail LIKE ? ESCAPE ? OR a.doer_check_evidence LIKE ? ESCAPE ? OR a.verifier_check_evidence LIKE ? ESCAPE ?)',
      ];
      const params: unknown[] = ['%LIKE%', '\\', '%LIKE%', '\\', '%LIKE%', '\\', '%LIKE%', '\\'];
      if (opts.taskId) {
        filters.push('a.task_id = ?');
        params.push(opts.taskId);
      }
      if (opts.roomId) {
        filters.push('t.room_id = ?');
        params.push(opts.roomId);
      }
      return {
        sql: `SELECT a.id, a.task_id, a.title, a.detail, a.status,
                     a.doer_check_evidence, a.verifier_check_evidence, a.updated_at, t.room_id
              FROM task_acceptance_criteria a JOIN tasks t ON t.id = a.task_id
              WHERE ${filters.join(' AND ')}`,
        params,
      };
    },
    mapper: (row, ctx) => {
      const title = String(row['title'] ?? '');
      const body = [row['detail'], row['doer_check_evidence'], row['verifier_check_evidence']]
        .map((value) => String(value ?? ''))
        .filter(Boolean)
        .join('\n');
      return makeHit({
        kind: 'acceptance',
        id: String(row['id']),
        title,
        body: `${title}\n${body}`,
        roomId: row['room_id'] !== null && row['room_id'] !== undefined ? String(row['room_id']) : null,
        taskId: String(row['task_id']),
        timestamp: typeof row['updated_at'] === 'number' ? row['updated_at'] : null,
        context: `AC · ${String(row['status'] ?? 'pending')}`,
        ctx,
      });
    },
  },
  clarifying: {
    kind: 'clarifying',
    buildQuery: (opts) => {
      const filters: string[] = ['(q.question LIKE ? ESCAPE ? OR q.answer LIKE ? ESCAPE ?)'];
      const params: unknown[] = ['%LIKE%', '\\', '%LIKE%', '\\'];
      if (opts.taskId) {
        filters.push('q.task_id = ?');
        params.push(opts.taskId);
      }
      if (opts.roomId) {
        filters.push('t.room_id = ?');
        params.push(opts.roomId);
      }
      return {
        sql: `SELECT q.id, q.task_id, q.question, q.answer, q.category, q.updated_at, t.room_id
              FROM task_clarifying_questions q JOIN tasks t ON t.id = q.task_id
              WHERE ${filters.join(' AND ')}`,
        params,
      };
    },
    mapper: (row, ctx) => {
      const question = String(row['question'] ?? '');
      const answer = String(row['answer'] ?? '');
      const body = answer ? `${question}\nA: ${answer}` : question;
      const status = answer ? 'answered' : 'open';
      return makeHit({
        kind: 'clarifying',
        id: String(row['id']),
        title: question,
        body,
        roomId: row['room_id'] !== null && row['room_id'] !== undefined ? String(row['room_id']) : null,
        taskId: String(row['task_id']),
        timestamp: typeof row['updated_at'] === 'number' ? row['updated_at'] : null,
        context: `Q&A · ${String(row['category'] ?? 'general')} · ${status}`,
        ctx,
      });
    },
  },
  message: {
    kind: 'message',
    buildQuery: (opts) => {
      const filters: string[] = ['text LIKE ? ESCAPE ?'];
      const params: unknown[] = ['%LIKE%', '\\'];
      if (opts.roomId) {
        filters.push('room_id = ?');
        params.push(opts.roomId);
      }
      return {
        sql: `SELECT id, room_id, author_id, author_kind, text, created_at
              FROM messages WHERE ${filters.join(' AND ')}`,
        params,
      };
    },
    mapper: (row, ctx) => {
      const text = String(row['text'] ?? '');
      const authorId = String(row['author_id'] ?? '');
      const authorKind = String(row['author_kind'] ?? '');
      const title = `${authorId}: ${text.slice(0, 80)}`;
      return makeHit({
        kind: 'message',
        id: String(row['id']),
        title,
        body: text,
        roomId: String(row['room_id']),
        taskId: null,
        timestamp: typeof row['created_at'] === 'number' ? row['created_at'] : null,
        context: `${authorKind} · ${authorId}`,
        ctx,
      });
    },
  },
  activity: {
    kind: 'activity',
    buildQuery: (opts) => {
      const filters: string[] = ['(label LIKE ? ESCAPE ? OR detail LIKE ? ESCAPE ?)'];
      const params: unknown[] = ['%LIKE%', '\\', '%LIKE%', '\\'];
      if (opts.roomId) {
        filters.push('room_id = ?');
        params.push(opts.roomId);
      }
      if (opts.taskId) {
        filters.push('task_id = ?');
        params.push(opts.taskId);
      }
      return {
        sql: `SELECT id, room_id, task_id, agent_id, kind, status, label, detail, created_at
              FROM agent_run_actions WHERE ${filters.join(' AND ')}`,
        params,
      };
    },
    mapper: (row, ctx) => {
      const label = String(row['label'] ?? '');
      const detail = String(row['detail'] ?? '');
      return makeHit({
        kind: 'activity',
        id: String(row['id']),
        title: label,
        body: `${label}\n${detail}`,
        roomId: row['room_id'] !== null && row['room_id'] !== undefined ? String(row['room_id']) : null,
        taskId: row['task_id'] ? String(row['task_id']) : null,
        timestamp: typeof row['created_at'] === 'number' ? row['created_at'] : null,
        context: `${String(row['kind'] ?? '')} · ${String(row['agent_id'] ?? '')} · ${String(row['status'] ?? '')}`,
        ctx,
      });
    },
  },
  collab: {
    kind: 'collab',
    buildQuery: (opts) => {
      const filters: string[] = [
        '(title LIKE ? ESCAPE ? OR body LIKE ? ESCAPE ? OR target LIKE ? ESCAPE ?)',
      ];
      const params: unknown[] = ['%LIKE%', '\\', '%LIKE%', '\\', '%LIKE%', '\\'];
      if (opts.roomId) {
        filters.push('room_id = ?');
        params.push(opts.roomId);
      }
      if (opts.taskId) {
        filters.push('task_id = ?');
        params.push(opts.taskId);
      }
      return {
        sql: `SELECT id, room_id, task_id, agent_id, kind, status, title, body, target, created_at
              FROM collaboration_items WHERE ${filters.join(' AND ')}`,
        params,
      };
    },
    mapper: (row, ctx) => {
      const title = String(row['title'] ?? '');
      const body = String(row['body'] ?? '');
      const target = String(row['target'] ?? '');
      return makeHit({
        kind: 'collab',
        id: String(row['id']),
        title,
        body: `${title}\n${target}\n${body}`,
        roomId: row['room_id'] !== null && row['room_id'] !== undefined ? String(row['room_id']) : null,
        taskId: row['task_id'] ? String(row['task_id']) : null,
        timestamp: typeof row['created_at'] === 'number' ? row['created_at'] : null,
        context: `${String(row['kind'] ?? '')} · ${String(row['status'] ?? '')} · ${String(row['agent_id'] ?? '')}`,
        ctx,
      });
    },
  },
};

/** Substitute the placeholder `%LIKE%` token with the actual escaped LIKE
 *  pattern for the user's query. We use `%LIKE%` as a sentinel inside the
 *  `buildQuery` outputs so each source can describe its WHERE shape without
 *  knowing the user's input string. */
function inflateLikeParams(params: readonly unknown[], query: string): unknown[] {
  const pattern = `%${escapeLike(query)}%`;
  return params.map((value) => (value === '%LIKE%' ? pattern : value));
}

export function runUniversalSearch(
  db: Database,
  rawQuery: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const query = rawQuery.trim();
  if (!query) return [];
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const snippetChars = Math.max(40, opts.snippetChars ?? DEFAULT_SNIPPET_CHARS);
  const allowedKinds: ReadonlySet<SearchKind> = new Set(
    opts.scope && opts.scope.length > 0 ? opts.scope : SEARCH_KINDS,
  );
  const ctx: RowContext = { query, snippetChars, now: Date.now() };

  const hits: SearchHit[] = [];
  for (const kind of SEARCH_KINDS) {
    if (!allowedKinds.has(kind)) continue;
    const source = SOURCES[kind];
    const queryFilter: { roomId?: string; taskId?: string } = {};
    if (opts.roomId) queryFilter.roomId = opts.roomId;
    if (opts.taskId) queryFilter.taskId = opts.taskId;
    const { sql, params } = source.buildQuery(queryFilter);
    const inflatedParams = inflateLikeParams(params, query);
    let rows: Record<string, unknown>[];
    try {
      rows = db.prepare(sql).all(...inflatedParams) as Record<string, unknown>[];
    } catch {
      // A source we can't query (e.g., schema mismatch) should not break the
      // whole search — degrade gracefully.
      continue;
    }
    for (const row of rows) {
      const hit = source.mapper(row, ctx);
      if (hit) hits.push(hit);
    }
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aTime = a.timestamp ?? 0;
    const bTime = b.timestamp ?? 0;
    if (bTime !== aTime) return bTime - aTime;
    return a.id.localeCompare(b.id);
  });
  return hits.slice(0, limit);
}
