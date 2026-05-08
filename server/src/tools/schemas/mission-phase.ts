import type { TaskPhaseStatus } from '../../repos/task-phases.js';

export type MissionPhaseMutableStatus = Exclude<TaskPhaseStatus, 'done'>;
export type MissionPhaseReopenStatus = Exclude<TaskPhaseStatus, 'done'>;

export interface MissionPhaseCreateArgs {
  title: string;
  plan?: string;
  description?: string;
  gate?: string;
  status?: MissionPhaseMutableStatus;
  sortOrder?: number;
}

export interface MissionPhaseUpdateArgs {
  phaseId: string;
  title?: string;
  plan?: string;
  description?: string;
  gate?: string;
  status?: MissionPhaseMutableStatus;
  sortOrder?: number;
}

export interface MissionPhaseCompleteArgs {
  phaseId: string;
  note?: string;
  evidence?: string;
}

export interface MissionPhaseReopenArgs {
  phaseId: string;
  status?: MissionPhaseReopenStatus;
  reason?: string;
}

type UnknownRecord = Record<string, unknown>;

const MUTABLE_STATUSES = new Set<MissionPhaseMutableStatus>(['planned', 'active', 'blocked']);
const REOPEN_STATUSES = MUTABLE_STATUSES;
const MUTABLE_STATUS_SCHEMA = { type: 'string', enum: ['planned', 'active', 'blocked'] };
const PHASE_REF_SCHEMA = {
  type: 'string',
  description: 'Phase id, title, or compatibility reference.',
};
const STATUS_ALIASES = new Map<string, TaskPhaseStatus>([
  ['current', 'active'],
  ['in_progress', 'active'],
  ['in progress', 'active'],
  ['started', 'active'],
  ['waiting', 'blocked'],
  ['stuck', 'blocked'],
  ['todo', 'planned'],
  ['queued', 'planned'],
  ['pending', 'planned'],
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

function parseSortOrder(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('sortOrder must be a non-negative integer');
  }
  return parsed;
}

function parseMutableStatus(value: unknown): MissionPhaseMutableStatus | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('status must be a string');
  const normalized = value.trim().toLowerCase();
  const status =
    (MUTABLE_STATUSES.has(normalized as MissionPhaseMutableStatus)
      ? (normalized as TaskPhaseStatus)
      : STATUS_ALIASES.get(normalized)) ?? null;
  if (status && MUTABLE_STATUSES.has(status as MissionPhaseMutableStatus)) {
    return status as MissionPhaseMutableStatus;
  }
  throw new Error('status must be one of: planned, active, blocked');
}

function parseReopenStatus(value: unknown): MissionPhaseReopenStatus | undefined {
  const status = parseMutableStatus(value);
  if (status && REOPEN_STATUSES.has(status)) return status;
  return status;
}

function assignDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

export const missionPhaseCreateSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
      title: { type: 'string' },
      plan: {
        type: 'string',
        description: 'Plan id, title, or compatibility reference.',
      },
      description: { type: 'string' },
      gate: { type: 'string' },
      status: MUTABLE_STATUS_SCHEMA,
      sortOrder: {
        type: 'integer',
        minimum: 0,
      },
    },
  },
  parse(input: unknown): MissionPhaseCreateArgs {
    if (!isRecord(input)) throw new Error('mission.phase.create args must be an object');

    const title = firstString(input, 'title', 'phase', 'name');
    if (!title) {
      throw new Error('mission.phase.create requires title');
    }

    const args: MissionPhaseCreateArgs = { title };
    assignDefined(args, 'plan', optionalString(input, 'plan', 'planId', 'plan_id'));
    assignDefined(args, 'description', optionalString(input, 'description', 'detail'));
    assignDefined(
      args,
      'gate',
      optionalString(input, 'gate', 'criteria', 'exitCriteria', 'exit_criteria'),
    );
    assignDefined(args, 'status', parseMutableStatus(input.status ?? input.state));
    assignDefined(
      args,
      'sortOrder',
      parseSortOrder(input.sortOrder ?? input.sort_order ?? input.order),
    );
    return args;
  },
};

export const missionPhaseUpdateSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['phaseId'],
    properties: {
      phaseId: PHASE_REF_SCHEMA,
      title: { type: 'string' },
      plan: {
        type: 'string',
        description: 'Plan id, title, or compatibility reference.',
      },
      description: { type: 'string' },
      gate: { type: 'string' },
      status: MUTABLE_STATUS_SCHEMA,
      sortOrder: {
        type: 'integer',
        minimum: 0,
      },
    },
  },
  parse(input: unknown): MissionPhaseUpdateArgs {
    if (!isRecord(input)) throw new Error('mission.phase.update args must be an object');

    const phaseId = firstString(input, 'phaseId', 'phase_id', 'id', 'phase');
    const title = optionalString(input, 'title', 'name');
    if (!phaseId && !title) {
      throw new Error('mission.phase.update requires phaseId (or title for compatibility)');
    }

    const args: MissionPhaseUpdateArgs = { phaseId: phaseId ?? '' };
    assignDefined(args, 'title', title);
    assignDefined(args, 'plan', optionalString(input, 'plan', 'planId', 'plan_id'));
    assignDefined(args, 'description', optionalString(input, 'description', 'detail'));
    assignDefined(
      args,
      'gate',
      optionalString(input, 'gate', 'criteria', 'exitCriteria', 'exit_criteria'),
    );
    assignDefined(args, 'status', parseMutableStatus(input.status ?? input.state));
    assignDefined(
      args,
      'sortOrder',
      parseSortOrder(input.sortOrder ?? input.sort_order ?? input.order),
    );
    return args;
  },
};

export const missionPhaseCompleteSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['phaseId'],
    properties: {
      phaseId: PHASE_REF_SCHEMA,
      note: { type: 'string' },
      evidence: { type: 'string' },
    },
  },
  parse(input: unknown): MissionPhaseCompleteArgs {
    if (!isRecord(input)) throw new Error('mission.phase.complete args must be an object');

    const phaseId = firstString(input, 'phaseId', 'phase_id', 'id', 'phase');
    if (!phaseId) {
      throw new Error('mission.phase.complete requires phaseId');
    }

    const args: MissionPhaseCompleteArgs = { phaseId };
    assignDefined(args, 'note', optionalString(input, 'note', 'summary'));
    assignDefined(args, 'evidence', optionalString(input, 'evidence'));
    return args;
  },
};

export const missionPhaseReopenSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['phaseId'],
    properties: {
      phaseId: PHASE_REF_SCHEMA,
      status: MUTABLE_STATUS_SCHEMA,
      reason: { type: 'string' },
    },
  },
  parse(input: unknown): MissionPhaseReopenArgs {
    if (!isRecord(input)) throw new Error('mission.phase.reopen args must be an object');

    const phaseId = firstString(input, 'phaseId', 'phase_id', 'id', 'phase');
    if (!phaseId) {
      throw new Error('mission.phase.reopen requires phaseId');
    }

    const args: MissionPhaseReopenArgs = { phaseId };
    assignDefined(args, 'status', parseReopenStatus(input.status ?? input.state));
    assignDefined(args, 'reason', optionalString(input, 'reason', 'note', 'summary'));
    return args;
  },
};
