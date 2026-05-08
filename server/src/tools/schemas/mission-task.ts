import type {
  TaskChecklistNoteKind,
  TaskChecklistParallelism,
  TaskChecklistStatus,
} from '../../repos/task-checklist.js';

export interface MissionTaskAddNoteArgs {
  taskId: string;
  body: string;
  kind?: TaskChecklistNoteKind;
}

export type MissionTaskUpdateAction = 'create' | 'update';

export interface MissionTaskUpdateArgs {
  /** Defaults to 'update'. Use 'create' to add a brand-new checklist item. */
  action?: MissionTaskUpdateAction;
  taskId: string;
  title?: string;
  detail?: string;
  status?: TaskChecklistStatus;
  owner?: string;
  note?: string;
  noteKind?: TaskChecklistNoteKind;
  plan?: string;
  phase?: string;
  dependsOn?: string[];
  expectedTouches?: string[];
  parallelism?: TaskChecklistParallelism;
  conflictGroup?: string;
  workRole?: string;
  blockedReason?: string;
  councilRequired?: boolean;
}

type UnknownRecord = Record<string, unknown>;

const STATUSES = new Set<TaskChecklistStatus>(['open', 'blocked', 'done', 'skipped']);
const STATUS_ALIASES = new Map<string, TaskChecklistStatus>([
  ['accepted', 'done'],
  ['closed', 'done'],
  ['complete', 'done'],
  ['completed', 'done'],
  ['finished', 'done'],
  ['resolved', 'done'],
  ['merged', 'done'],
  ['todo', 'open'],
  ['queued', 'open'],
  ['pending', 'open'],
  ['in_progress', 'open'],
  ['in progress', 'open'],
  ['working', 'open'],
  ['started', 'open'],
  ['waiting', 'blocked'],
  ['stuck', 'blocked'],
  ['deferred', 'skipped'],
]);
const NOTE_KINDS = new Set<TaskChecklistNoteKind>(['status', 'completion', 'blocker', 'council']);
const PARALLELISMS = new Set<TaskChecklistParallelism>([
  'parallel-safe',
  'coordinate',
  'exclusive',
]);
const PARALLELISM_ALIASES = new Map<string, TaskChecklistParallelism>([
  ['parallel', 'parallel-safe'],
  ['parallel_safe', 'parallel-safe'],
  ['parallel-safe', 'parallel-safe'],
  ['safe', 'parallel-safe'],
  ['independent', 'parallel-safe'],
  ['coordinate', 'coordinate'],
  ['coordinated', 'coordinate'],
  ['shared', 'coordinate'],
  ['exclusive', 'exclusive'],
  ['serial', 'exclusive'],
  ['single_writer', 'exclusive'],
  ['single-writer', 'exclusive'],
  ['lock', 'exclusive'],
  ['locked', 'exclusive'],
]);

function isRecord(input: unknown): input is UnknownRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function firstString(input: UnknownRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function optionalString(input: UnknownRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') return value.trim();
  }
  return undefined;
}

function splitRefs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  const refs = values
    .flatMap((item) => {
      if (typeof item !== 'string') {
        throw new Error('expected string or string[]');
      }
      return item.split(/,|;|\n/);
    })
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(refs)].slice(0, 30);
}

const ACTIONS = new Set<MissionTaskUpdateAction>(['create', 'update']);

function parseAction(value: unknown): MissionTaskUpdateAction | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('action must be a string');
  const normalized = value.trim().toLowerCase();
  if (ACTIONS.has(normalized as MissionTaskUpdateAction)) {
    return normalized as MissionTaskUpdateAction;
  }
  throw new Error(`action must be one of: ${Array.from(ACTIONS).join(', ')}`);
}

function parseStatus(value: unknown): TaskChecklistStatus | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('status must be a string');
  const normalized = value.trim().toLowerCase();
  if (STATUSES.has(normalized as TaskChecklistStatus)) return normalized as TaskChecklistStatus;
  const aliased = STATUS_ALIASES.get(normalized);
  if (aliased) return aliased;
  throw new Error(`status must be one of: ${Array.from(STATUSES).join(', ')}`);
}

function parseNoteKind(
  value: unknown,
  status: TaskChecklistStatus | undefined,
): TaskChecklistNoteKind | undefined {
  if (value === undefined || value === null || value === '') {
    if (status === 'done') return 'completion';
    if (status === 'blocked') return 'blocker';
    return undefined;
  }
  if (typeof value !== 'string') throw new Error('noteKind must be a string');
  const normalized = value.trim().toLowerCase();
  if (NOTE_KINDS.has(normalized as TaskChecklistNoteKind)) {
    return normalized as TaskChecklistNoteKind;
  }
  throw new Error(`noteKind must be one of: ${Array.from(NOTE_KINDS).join(', ')}`);
}

function parseParallelism(value: unknown): TaskChecklistParallelism | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('parallelism must be a string');
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_');
  if (PARALLELISMS.has(normalized as TaskChecklistParallelism)) {
    return normalized as TaskChecklistParallelism;
  }
  const aliased = PARALLELISM_ALIASES.get(normalized);
  if (aliased) return aliased;
  throw new Error(`parallelism must be one of: ${Array.from(PARALLELISMS).join(', ')}`);
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') throw new Error('councilRequired must be a boolean');
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'required'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0', 'none'].includes(normalized)) return false;
  throw new Error('councilRequired must be a boolean');
}

function parseRefList(input: UnknownRecord, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    if (key in input) return splitRefs(input[key]);
  }
  return undefined;
}

function assignDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

export const missionTaskAddNoteSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['taskId', 'body'],
    properties: {
      taskId: {
        type: 'string',
        description: 'Checklist item id or title/reference to append the note to.',
      },
      body: {
        type: 'string',
        description: 'Note text to append.',
      },
      kind: {
        type: 'string',
        enum: ['status', 'completion', 'blocker', 'council'],
      },
    },
  },
  parse(input: unknown): MissionTaskAddNoteArgs {
    if (!isRecord(input)) throw new Error('mission.task.add_note args must be an object');

    const taskId = firstString(input, 'taskId', 'task_id', 'id', 'itemId', 'item_id');
    if (!taskId) {
      throw new Error('mission.task.add_note requires taskId');
    }

    const body = firstString(input, 'body', 'note', 'text', 'content');
    if (!body) {
      throw new Error('mission.task.add_note requires a non-empty body');
    }

    const args: MissionTaskAddNoteArgs = { taskId, body };
    const kind = parseNoteKind(input.kind ?? input.noteKind ?? input.note_kind, undefined);
    assignDefined(args, 'kind', kind);
    return args;
  },
};

export const missionTaskUpdateSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['taskId'],
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'update'],
        description: 'Defaults to update. Use create only when adding a new checklist item.',
      },
      taskId: {
        type: 'string',
        description: 'Checklist item id or title/reference. Alias-compatible keys include id and itemId.',
      },
      title: { type: 'string' },
      detail: { type: 'string' },
      status: {
        type: 'string',
        enum: ['open', 'blocked', 'done', 'skipped'],
      },
      owner: { type: 'string' },
      note: { type: 'string' },
      noteKind: {
        type: 'string',
        enum: ['status', 'completion', 'blocker', 'council'],
      },
      plan: { type: 'string' },
      phase: { type: 'string' },
      dependsOn: {
        type: 'array',
        items: { type: 'string' },
      },
      expectedTouches: {
        type: 'array',
        items: { type: 'string' },
      },
      parallelism: {
        type: 'string',
        enum: ['parallel-safe', 'coordinate', 'exclusive'],
      },
      conflictGroup: { type: 'string' },
      workRole: { type: 'string' },
      blockedReason: { type: 'string' },
      councilRequired: { type: 'boolean' },
    },
  },
  parse(input: unknown): MissionTaskUpdateArgs {
    if (!isRecord(input)) throw new Error('mission.task.update args must be an object');

    const taskId = firstString(input, 'taskId', 'task_id', 'id', 'itemId', 'item_id');
    const title = optionalString(input, 'title', 'task', 'name');
    const action = parseAction(input.action ?? input.mode);
    if (!taskId && !title) {
      throw new Error('mission.task.update requires taskId (or title for compatibility)');
    }
    if (action === 'create' && !title) {
      throw new Error('mission.task.update with action=create requires a title');
    }

    const status = parseStatus(input.status ?? input.state);
    const noteKind = parseNoteKind(input.noteKind ?? input.note_kind ?? input.kind, status);
    const args: MissionTaskUpdateArgs = {
      taskId: taskId ?? '',
    };

    assignDefined(args, 'action', action);
    assignDefined(args, 'title', title);
    assignDefined(args, 'detail', optionalString(input, 'detail', 'description'));
    assignDefined(args, 'status', status);
    assignDefined(args, 'owner', optionalString(input, 'owner', 'agent', 'assignee'));
    assignDefined(args, 'note', optionalString(input, 'note', 'status_note', 'summary'));
    assignDefined(args, 'noteKind', noteKind);
    assignDefined(args, 'plan', optionalString(input, 'plan', 'plan_id'));
    assignDefined(args, 'phase', optionalString(input, 'phase', 'phase_id'));
    assignDefined(
      args,
      'dependsOn',
      parseRefList(input, 'dependsOn', 'depends_on', 'dependencies', 'dependency_ids'),
    );
    assignDefined(
      args,
      'expectedTouches',
      parseRefList(input, 'expectedTouches', 'expected_touches', 'files', 'paths'),
    );
    assignDefined(
      args,
      'parallelism',
      parseParallelism(input.parallelism ?? input.parallel ?? input.coordination),
    );
    assignDefined(
      args,
      'conflictGroup',
      optionalString(input, 'conflictGroup', 'conflict_group', 'conflict', 'scope_group', 'scope'),
    );
    assignDefined(args, 'workRole', optionalString(input, 'workRole', 'work_role', 'role'));
    assignDefined(
      args,
      'blockedReason',
      optionalString(input, 'blockedReason', 'blocked_reason', 'blocker', 'reason'),
    );
    assignDefined(
      args,
      'councilRequired',
      parseBoolean(input.councilRequired ?? input.council_required ?? input.council),
    );

    return args;
  },
};
