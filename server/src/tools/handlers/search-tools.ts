import { defaultToolRegistry, defineTool } from '../registry.js';
import type { AgentToolHandlerInput, AgentToolResult, StatePermission } from '../types.js';

export interface ToolArgReference {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}

export interface ToolSchemaReference {
  name: string;
  summary: string;
  requiredPermissions: StatePermission[];
  args: ToolArgReference[];
  notes?: string[];
}

export interface SearchToolsArgs {
  query?: string;
  names?: string[];
  namespace?: string;
  includeSchemas: boolean;
  limit: number;
}

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

export const TOOL_SCHEMA_REFERENCES: readonly ToolSchemaReference[] = [
  {
    name: 'search.tools',
    summary: 'Retrieve the structured tool manifest and argument reference.',
    requiredPermissions: ['search:read'],
    args: [
      {
        name: 'query',
        type: 'string',
        description:
          'Optional case-insensitive text search over tool names, summaries, args, and notes.',
      },
      {
        name: 'names',
        type: 'string[]',
        description: 'Optional exact tool names to retrieve.',
      },
      {
        name: 'namespace',
        type: 'string',
        description:
          'Optional namespace prefix such as mission, mission.task, collab, permission, or search.',
      },
      {
        name: 'includeSchemas',
        type: 'boolean',
        description: 'When false, return names, summaries, and permissions only.',
      },
      {
        name: 'limit',
        type: 'integer',
        description: `Maximum result count, capped at ${MAX_LIMIT}.`,
      },
    ],
    notes: [
      'This is read-only. It emits no mission or collaboration effects beyond the audit row.',
    ],
  },
  {
    name: 'search.universal',
    summary:
      'Cross-room search over rooms, tasks, mission state, messages, activity, and collaboration notes.',
    requiredPermissions: ['search:read'],
    args: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'Free-text query. Trimmed; empty queries are rejected.',
      },
      {
        name: 'scope',
        type: 'string | string[]',
        description:
          'Optional kind filter. Allowed: room, project, task, phase, plan, checklist, acceptance, clarifying, message, activity, collab.',
      },
      {
        name: 'roomId',
        type: 'string',
        description: 'Restrict to one room.',
      },
      {
        name: 'taskId',
        type: 'string',
        description: 'Restrict to one task.',
      },
      {
        name: 'limit',
        type: 'integer',
        description: 'Maximum hits to return. Defaults to 50, capped at 200.',
      },
    ],
    notes: [
      'Read-only. Returns SearchHit objects with snippet text and match offsets so the caller can highlight matches without re-running the query.',
    ],
  },
  {
    name: 'agent.checkin',
    summary: 'Record a lightweight liveness check-in and optionally return current assignments.',
    requiredPermissions: ['agent:write-self'],
    args: [
      {
        name: 'includeAssignments',
        type: 'boolean',
        description: 'When true, include the caller current assignment snapshot.',
      },
      {
        name: 'includeQuota',
        type: 'boolean',
        description: 'Reserved for provider quota data; currently returns null when requested.',
      },
      {
        name: 'status',
        type: 'idle | active | blocked | offline',
        description: 'Optional runtime status update for the caller.',
      },
      { name: 'reason', type: 'string', description: 'Short liveness or blocker context.' },
      {
        name: 'currentTaskId',
        type: 'string',
        description: 'Optional current mission/checklist context.',
      },
    ],
  },
  {
    name: 'agent.set_status',
    summary: 'Update the caller or a coordinated target agent runtime status.',
    requiredPermissions: ['agent:write-self'],
    args: [
      {
        name: 'agentId',
        type: 'string',
        description: 'Target agent id. Defaults to the caller.',
      },
      {
        name: 'status',
        type: 'idle | active | blocked | offline',
        required: true,
        description: 'Runtime status. Common aliases normalize to these four states.',
      },
      { name: 'reason', type: 'string', description: 'Short reason or blocker context.' },
      { name: 'until', type: 'string', description: 'Optional human-readable expiry.' },
      {
        name: 'currentTaskId',
        type: 'string',
        description: 'Optional current mission/checklist context.',
      },
    ],
    notes: ['Updating another agent requires agent:coordinate in addition to agent:write-self.'],
  },
  {
    name: 'agent.list_assignments',
    summary: 'List checklist, job, and queued-dispatch assignments for a room agent.',
    requiredPermissions: ['mission:read'],
    args: [
      {
        name: 'agentId',
        type: 'string',
        description: 'Target agent id. Defaults to the caller.',
      },
      {
        name: 'includeCompleted',
        type: 'boolean',
        description: 'When true, include completed and skipped checklist items.',
      },
      {
        name: 'includeDispatches',
        type: 'boolean',
        description: 'When true, include pending queued dispatches for the target agent.',
      },
      {
        name: 'includeJobs',
        type: 'boolean',
        description: 'When true, include active queued, leased, and running agent jobs.',
      },
      {
        name: 'limit',
        type: 'integer',
        description: 'Maximum result count per assignment bucket, capped at 100.',
      },
    ],
    notes: ['This is read-only. Cross-agent reads are covered by mission:read.'],
  },
  {
    name: 'agent.ack_message',
    summary: 'Record durable read acknowledgements for one or more room messages.',
    requiredPermissions: ['agent:write-self'],
    args: [
      {
        name: 'messageId',
        type: 'string',
        description: 'Single message id to acknowledge.',
      },
      {
        name: 'messageIds',
        type: 'string[]',
        description: 'Message ids to acknowledge, capped at 50.',
      },
    ],
  },
  {
    name: 'agent.request_turns',
    summary: 'Queue follow-up turns for specific room agents through the dispatch queue.',
    requiredPermissions: ['agent:coordinate'],
    args: [
      {
        name: 'agents',
        type: 'string[]',
        required: true,
        description: 'Room agent ids, handles, or unambiguous display/provider aliases.',
      },
      { name: 'reason', type: 'string', description: 'Why the turns are being requested.' },
      {
        name: 'message',
        type: 'string',
        description: 'Prompt text attached to the queued dispatch source message.',
      },
      {
        name: 'priority',
        type: 'integer',
        description: 'Dispatch priority from -100 to 100. Defaults to 0.',
      },
    ],
  },
  {
    name: 'mission.task.update',
    summary:
      'Update an existing mission checklist item status, ownership, scope, notes, and links.',
    requiredPermissions: ['mission:write'],
    args: [
      {
        name: 'taskId',
        type: 'string',
        description: 'Checklist item id or compatibility reference.',
      },
      {
        name: 'title',
        type: 'string',
        description: 'Checklist item title or title compatibility reference.',
      },
      {
        name: 'status',
        type: 'open | done | blocked | skipped',
        description: 'New checklist status. Completion aliases normalize to done.',
      },
      { name: 'owner', type: 'string', description: 'Agent id that should own the item.' },
      { name: 'note', type: 'string', description: 'Status, completion, or blocker evidence.' },
      {
        name: 'blockedReason',
        type: 'string',
        description: 'Required context when status is blocked.',
      },
      {
        name: 'councilRequired',
        type: 'boolean',
        description: 'True when human or team council is needed.',
      },
      { name: 'plan', type: 'string', description: 'Plan id or title compatibility reference.' },
      { name: 'phase', type: 'string', description: 'Phase id or title compatibility reference.' },
      { name: 'dependsOn', type: 'string[]', description: 'Checklist item dependencies.' },
      {
        name: 'expectedTouches',
        type: 'string[]',
        description: 'Expected files, globs, or logical scopes.',
      },
      {
        name: 'parallelism',
        type: 'parallel-safe | coordinate | exclusive',
        description: 'Concurrency guidance.',
      },
      {
        name: 'conflictGroup',
        type: 'string',
        description: 'Shared lock label for conflicting work.',
      },
      {
        name: 'workRole',
        type: 'implement | review | verify | research | docs | other',
        description: 'Lane role.',
      },
    ],
    notes: [
      'At least taskId or title should identify the target item. Include evidence in note when status is done.',
    ],
  },
  {
    name: 'mission.task.add_note',
    summary: 'Append a note to an existing mission checklist item without changing its status.',
    requiredPermissions: ['mission:write'],
    args: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'Checklist item id or title reference.',
      },
      {
        name: 'body',
        type: 'string',
        required: true,
        description: 'Note body, truncated by the handler at 4000 chars.',
      },
      {
        name: 'kind',
        type: 'status | evidence | completion | blocker | council',
        description: 'Note category.',
      },
    ],
  },
  {
    name: 'mission.phase.create',
    summary: 'Create a mission phase gate.',
    requiredPermissions: ['mission:write'],
    args: [
      { name: 'title', type: 'string', required: true, description: 'Phase title.' },
      { name: 'plan', type: 'string', description: 'Plan id or title reference.' },
      { name: 'description', type: 'string', description: 'One-sentence phase scope.' },
      { name: 'gate', type: 'string', description: 'Concrete exit criteria.' },
      { name: 'status', type: 'planned | active | blocked', description: 'Initial phase status.' },
      { name: 'sortOrder', type: 'integer', description: 'Non-negative display order.' },
    ],
  },
  {
    name: 'mission.phase.update',
    summary: 'Revise an unfinished mission phase gate.',
    requiredPermissions: ['mission:write'],
    args: [
      {
        name: 'phaseId',
        type: 'string',
        required: true,
        description: 'Phase id or compatibility reference.',
      },
      { name: 'title', type: 'string', description: 'New phase title.' },
      { name: 'plan', type: 'string', description: 'Plan id or title reference.' },
      { name: 'description', type: 'string', description: 'Updated phase scope.' },
      { name: 'gate', type: 'string', description: 'Updated exit criteria.' },
      { name: 'status', type: 'planned | active | blocked', description: 'Mutable phase status.' },
      { name: 'sortOrder', type: 'integer', description: 'Non-negative display order.' },
    ],
  },
  {
    name: 'mission.phase.complete',
    summary: 'Complete a phase after unfinished checklist validation passes.',
    requiredPermissions: ['mission:admin'],
    args: [
      {
        name: 'phaseId',
        type: 'string',
        required: true,
        description: 'Phase id or title reference.',
      },
      { name: 'note', type: 'string', description: 'Completion note.' },
      { name: 'evidence', type: 'string', description: 'Test, command, file, or review evidence.' },
    ],
  },
  {
    name: 'mission.phase.reopen',
    summary: 'Reopen a completed or blocked phase gate.',
    requiredPermissions: ['mission:admin'],
    args: [
      {
        name: 'phaseId',
        type: 'string',
        required: true,
        description: 'Phase id or title reference.',
      },
      { name: 'status', type: 'planned | active | blocked', description: 'Reopened status.' },
      { name: 'reason', type: 'string', description: 'Why the phase is being reopened.' },
    ],
  },
  {
    name: 'mission.plan.create',
    summary: 'Create a mission plan.',
    requiredPermissions: ['mission:write'],
    args: [
      { name: 'title', type: 'string', required: true, description: 'Plan title.' },
      { name: 'body', type: 'string', description: 'Plan markdown body.' },
      { name: 'status', type: 'draft | active', description: 'Initial plan status.' },
    ],
  },
  {
    name: 'mission.plan.update',
    summary: 'Revise a mission plan title or body.',
    requiredPermissions: ['mission:write'],
    args: [
      {
        name: 'planId',
        type: 'string',
        required: true,
        description: 'Plan id or title compatibility reference.',
      },
      { name: 'title', type: 'string', description: 'New plan title.' },
      { name: 'body', type: 'string', description: 'New plan markdown body.' },
    ],
    notes: ['At least title or body is required.'],
  },
  {
    name: 'mission.plan.activate',
    summary: 'Set the active mission plan.',
    requiredPermissions: ['mission:write'],
    args: [
      {
        name: 'planId',
        type: 'string',
        required: true,
        description: 'Plan id or title reference.',
      },
    ],
  },
  {
    name: 'mission.plan.archive',
    summary: 'Archive or supersede a mission plan.',
    requiredPermissions: ['mission:write'],
    args: [
      {
        name: 'planId',
        type: 'string',
        required: true,
        description: 'Plan id or title reference.',
      },
      { name: 'status', type: 'archived | superseded', description: 'Terminal archival status.' },
      { name: 'reason', type: 'string', description: 'Why the plan is being archived.' },
    ],
  },
  {
    name: 'mission.clarify.ask',
    summary:
      'Lead asks a clarifying question against the active mission while in draft/elaborating; blocks propose until answered.',
    requiredPermissions: ['mission:write'],
    args: [
      {
        name: 'question',
        type: 'string',
        required: true,
        description: 'The clarifying question to ask. Must be non-empty.',
      },
      {
        name: 'category',
        type: "scope | data-model | acceptance | out-of-scope | risk | general",
        description: 'Topic family. Defaults to general.',
      },
    ],
  },
  {
    name: 'mission.clarify.answer',
    summary:
      'Designated answerer answers a previously-asked clarifying question. Humans answer via HTTP, not MCP.',
    requiredPermissions: ['mission:write'],
    args: [
      { name: 'questionId', type: 'string', required: true, description: 'Question id.' },
      { name: 'answer', type: 'string', required: true, description: 'Non-empty answer text.' },
    ],
  },
  {
    name: 'mission.acceptance.create',
    summary: 'Add an acceptance criterion to the active mission during the proposal phase.',
    requiredPermissions: ['mission:write'],
    args: [
      { name: 'title', type: 'string', required: true, description: 'One-line AC title.' },
      { name: 'detail', type: 'string', description: 'Optional longer-form detail.' },
      { name: 'doer', type: 'string', description: 'Optional agent id assigned as doer.' },
      { name: 'sortOrder', type: 'integer', description: 'Optional sort position.' },
    ],
  },
  {
    name: 'mission.acceptance.update',
    summary: 'Patch an AC (title, detail, doer, sortOrder).',
    requiredPermissions: ['mission:write'],
    args: [
      { name: 'id', type: 'string', required: true, description: 'AC id.' },
      { name: 'title', type: 'string', description: 'Replacement title.' },
      { name: 'detail', type: 'string', description: 'Replacement detail.' },
      {
        name: 'doer',
        type: 'string | null',
        description: 'New doer agent id, or null to clear.',
      },
      { name: 'sortOrder', type: 'integer', description: 'New sort position.' },
    ],
  },
  {
    name: 'mission.acceptance.reorder',
    summary: 'Set the sort order of an AC within its task.',
    requiredPermissions: ['mission:write'],
    args: [
      { name: 'id', type: 'string', required: true, description: 'AC id.' },
      {
        name: 'sortOrder',
        type: 'integer',
        required: true,
        description: 'New sort position within the task.',
      },
    ],
  },
  {
    name: 'mission.propose.submit',
    summary:
      'Lead promotes the active mission from draft/elaborating → proposed once questions are answered and ACs are listed.',
    requiredPermissions: ['mission:write'],
    args: [
      {
        name: 'reason',
        type: 'string',
        description: 'Optional one-line summary of what is being proposed.',
      },
      {
        name: 'verifierAgentId',
        type: 'string',
        description:
          'Optional verifier nomination. Falls back to the auto-pick at approve time if omitted.',
      },
    ],
  },
  {
    name: 'mission.task.set_verifier',
    summary:
      'Assign or clear the verifier agent on a task. Pass null to clear (humans verify by default).',
    requiredPermissions: ['mission:write'],
    args: [
      { name: 'taskId', type: 'string', description: 'Task id; defaults to the active task.' },
      {
        name: 'verifierAgentId',
        type: 'string | null',
        required: true,
        description: 'Agent id to assign, or null to clear.',
      },
    ],
  },
  {
    name: 'mission.verify',
    summary:
      'Record a doer or verifier check on an acceptance criterion. Same-agent verifier checks are rejected.',
    requiredPermissions: ['mission:write'],
    args: [
      {
        name: 'side',
        type: 'doer | verifier',
        required: true,
        description: 'Which side of the dual-path verify is being recorded.',
      },
      { name: 'acId', type: 'string', required: true, description: 'AC id.' },
      {
        name: 'status',
        type: 'pass | fail',
        required: true,
        description: 'Whether this side passes or fails the AC.',
      },
      {
        name: 'evidence',
        type: 'string',
        required: true,
        description: 'Non-empty evidence supporting the pass/fail.',
      },
    ],
  },
  {
    name: 'mission.approve',
    summary:
      'Pre-authorised approver agent approves / rejects / requests-changes on a task. Humans use HTTP routes instead.',
    requiredPermissions: ['mission:admin'],
    args: [
      { name: 'taskId', type: 'string', required: true, description: 'Task id to act on.' },
      {
        name: 'action',
        type: 'approve | reject | request-changes',
        required: true,
        description: 'Approval verdict.',
      },
      {
        name: 'reason',
        type: 'string',
        description: 'Required for reject and request-changes; optional for approve.',
      },
    ],
  },
  {
    name: 'permission.request',
    summary: 'Request edit, command, network, or full-auto permission for a future turn.',
    requiredPermissions: ['permission:request'],
    args: [
      {
        name: 'mode',
        type: 'plan | edit | bash | full-auto',
        required: true,
        description: 'Requested permission mode.',
      },
      {
        name: 'target',
        type: 'string',
        required: true,
        description: 'Path, command, or scope requiring permission.',
      },
      {
        name: 'reason',
        type: 'string',
        required: true,
        description: 'Brief reason the permission is needed.',
      },
    ],
  },
  {
    name: 'collab.note.add',
    summary:
      'Record a durable collaboration proposal, challenge, revision, decision, or evidence note.',
    requiredPermissions: ['collab:write'],
    args: [
      {
        name: 'kind',
        type: 'proposal | challenge | revision | decision | evidence',
        required: true,
        description: 'Collaboration note kind.',
      },
      { name: 'title', type: 'string', required: true, description: 'Concise claim or direction.' },
      {
        name: 'target',
        type: 'string',
        description: 'Claim, file, decision, or plan this refers to.',
      },
      {
        name: 'status',
        type: 'open | blocked | resolved | superseded | accepted | rejected | informational',
        description: 'Note lifecycle status.',
      },
      { name: 'confidence', type: 'low | medium | high', description: 'Confidence in the note.' },
      {
        name: 'evidence',
        type: 'string',
        description: 'File path, command, test, URL, or citation.',
      },
      {
        name: 'body',
        type: 'string',
        required: true,
        description: 'One concise sentence explaining why this matters.',
      },
    ],
  },
  {
    name: 'collab.note.update',
    summary: 'Update an existing durable collaboration note.',
    requiredPermissions: ['collab:write'],
    args: [
      {
        name: 'noteId',
        type: 'string',
        required: true,
        description: 'Existing collaboration note id.',
      },
      {
        name: 'status',
        type: 'open | blocked | resolved | superseded | accepted | rejected | informational',
        description: 'Updated status.',
      },
      { name: 'confidence', type: 'low | medium | high', description: 'Updated confidence.' },
      { name: 'evidence', type: 'string', description: 'Replacement or additional evidence.' },
      { name: 'body', type: 'string', description: 'Updated body.' },
    ],
  },
];

export const searchToolsSchema = {
  parse(input: unknown): SearchToolsArgs {
    if (input === undefined || input === null) {
      return { includeSchemas: true, limit: DEFAULT_LIMIT };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('search.tools args must be an object');
    }
    const raw = input as Record<string, unknown>;
    const args: SearchToolsArgs = {
      includeSchemas: optionalBoolean(raw.includeSchemas ?? raw.include_schemas, true),
      limit: boundedLimit(raw.limit),
    };
    assignDefined(args, 'query', optionalString(raw.query));
    assignDefined(
      args,
      'names',
      optionalStringList(raw.names ?? raw.name ?? raw.tools ?? raw.tool),
    );
    assignDefined(args, 'namespace', optionalString(raw.namespace ?? raw.ns));
    return args;
  },
};

export function handleSearchTools(input: AgentToolHandlerInput<SearchToolsArgs>): AgentToolResult {
  const matches = filterToolReferences(input.args);
  const tools = matches.map((tool) =>
    input.args.includeSchemas
      ? tool
      : {
          name: tool.name,
          summary: tool.summary,
          requiredPermissions: tool.requiredPermissions,
        },
  );

  return {
    status: 'applied',
    summary: `search.tools returned ${tools.length} tool reference${tools.length === 1 ? '' : 's'}`,
    data: {
      query: input.args.query ?? null,
      namespace: input.args.namespace ?? null,
      names: input.args.names ?? [],
      includeSchemas: input.args.includeSchemas,
      tools,
    },
    effects: [],
  };
}

export const searchToolsTool = defineTool<SearchToolsArgs>({
  name: 'search.tools',
  summary: 'Retrieve the structured tool manifest and argument reference.',
  requiredPermissions: ['search:read'],
  schema: searchToolsSchema,
  handler: handleSearchTools,
});

export function ensureSearchToolsRegistered(): void {
  if (!defaultToolRegistry.has(searchToolsTool.name)) {
    defaultToolRegistry.register(searchToolsTool);
  }
}

function filterToolReferences(args: SearchToolsArgs): ToolSchemaReference[] {
  const requested = new Set((args.names ?? []).map((name) => name.toLowerCase()));
  const namespace = args.namespace?.toLowerCase();
  const terms = (args.query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  return TOOL_SCHEMA_REFERENCES.filter((tool) => {
    const lowerName = tool.name.toLowerCase();
    if (requested.size > 0 && !requested.has(lowerName)) return false;
    if (namespace && lowerName !== namespace && !lowerName.startsWith(`${namespace}.`))
      return false;
    if (terms.length === 0) return true;
    const haystack = [
      tool.name,
      tool.summary,
      ...tool.requiredPermissions,
      ...tool.args.flatMap((arg) => [arg.name, arg.type, arg.description]),
      ...(tool.notes ?? []),
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).slice(0, args.limit);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function assignDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(normalized)) return true;
    if (['false', 'no', '0'].includes(normalized)) return false;
  }
  throw new Error('includeSchemas must be a boolean');
}

function optionalStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const rawValues = Array.isArray(value) ? value : [value];
  const values = rawValues.map(optionalString).filter((item): item is string => Boolean(item));
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function boundedLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('limit must be a positive integer');
  return Math.min(parsed, MAX_LIMIT);
}
