// server/src/tools/schemas/search-universal.ts
//
// Schema for `search.universal` — the cross-room/task fuzzy search tool. The
// tool is read-only; it never mutates state. Args mirror the HTTP query
// shape so an MCP-only client and a UI client see the same surface.

import { SEARCH_KINDS, type SearchKind } from '../../search/universal-search.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(input: unknown): input is UnknownRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function optionalString(input: UnknownRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function optionalLimit(input: UnknownRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error('limit must be a positive integer');
    }
    return parsed;
  }
  return undefined;
}

function parseScope(value: unknown): SearchKind[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const list = Array.isArray(value) ? value : [value];
  const allowed = new Set(SEARCH_KINDS as readonly SearchKind[]);
  const out: SearchKind[] = [];
  const seen = new Set<SearchKind>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().toLowerCase() as SearchKind;
    if (!allowed.has(trimmed)) {
      throw new Error(`scope entries must be one of: ${[...allowed].join(', ')}`);
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out.length > 0 ? out : undefined;
}

export interface SearchUniversalArgs {
  query: string;
  scope?: SearchKind[];
  roomId?: string;
  taskId?: string;
  limit?: number;
}

export const searchUniversalSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'Free-text query. Required, non-empty after trimming.',
      },
      scope: {
        type: ['array', 'string'],
        description:
          'Optional kind filter. Single string or array. Allowed: ' + SEARCH_KINDS.join(', '),
      },
      roomId: {
        type: 'string',
        description: 'Restrict to a single room.',
      },
      taskId: {
        type: 'string',
        description: 'Restrict to a single task.',
      },
      limit: {
        type: 'integer',
        description: 'Max hits to return. Defaults to 50, capped at 200.',
      },
    },
  },
  parse(input: unknown): SearchUniversalArgs {
    if (!isRecord(input)) throw new Error('search.universal args must be an object');
    const query = optionalString(input, 'query', 'q', 'text');
    if (!query) throw new Error('query is required');

    const args: SearchUniversalArgs = { query };
    const scope = parseScope(input.scope ?? input.kinds ?? input.kind);
    if (scope !== undefined) args.scope = scope;
    const roomId = optionalString(input, 'roomId', 'room_id');
    if (roomId !== undefined) args.roomId = roomId;
    const taskId = optionalString(input, 'taskId', 'task_id');
    if (taskId !== undefined) args.taskId = taskId;
    const limit = optionalLimit(input, 'limit', 'max');
    if (limit !== undefined) args.limit = limit;
    return args;
  },
};
