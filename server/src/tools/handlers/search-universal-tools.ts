// server/src/tools/handlers/search-universal-tools.ts
//
// search.universal — read-only cross-room search over rooms, projects,
// tasks (and their child rows: phases, plans, checklist items, acceptance
// criteria, clarifying questions), messages, run-action activity, and
// collaboration items. Always idempotent; emits no effects.

import { runUniversalSearch, type SearchOptions } from '../../search/universal-search.js';
import { defineTool } from '../registry.js';
import {
  searchUniversalSchema,
  type SearchUniversalArgs,
} from '../schemas/search-universal.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

export function handleSearchUniversal(
  input: AgentToolHandlerInput<SearchUniversalArgs>,
): AgentToolResult {
  const opts: SearchOptions = {};
  if (input.args.scope !== undefined) opts.scope = input.args.scope;
  if (input.args.roomId !== undefined) opts.roomId = input.args.roomId;
  if (input.args.taskId !== undefined) opts.taskId = input.args.taskId;
  if (input.args.limit !== undefined) opts.limit = input.args.limit;
  const hits = runUniversalSearch(input.db, input.args.query, opts);
  return {
    status: 'applied',
    summary: `search.universal returned ${hits.length} hit${hits.length === 1 ? '' : 's'}`,
    data: {
      query: input.args.query,
      scope: input.args.scope ?? null,
      roomId: input.args.roomId ?? null,
      taskId: input.args.taskId ?? null,
      hits,
    },
    effects: [],
  };
}

export const searchUniversalTool = defineTool<SearchUniversalArgs>({
  name: 'search.universal',
  summary:
    'Cross-room search over rooms, tasks, mission state, messages, activity, and collaboration notes. Read-only.',
  requiredPermissions: ['search:read'],
  schema: searchUniversalSchema,
  handler: handleSearchUniversal,
});

export const searchUniversalTools = [searchUniversalTool] as const;
