import type { TaskPlanStatus } from '../../repos/task-plans.js';

export type MissionPlanCreateStatus = Extract<TaskPlanStatus, 'draft' | 'active'>;

export interface MissionPlanCreateArgs {
  title: string;
  body?: string;
  status?: MissionPlanCreateStatus;
}

export interface MissionPlanUpdateArgs {
  planId: string;
  title?: string;
  body?: string;
}

export interface MissionPlanActivateArgs {
  planId: string;
}

export interface MissionPlanArchiveArgs {
  planId: string;
  status?: Extract<TaskPlanStatus, 'archived' | 'superseded'>;
  reason?: string;
}

type UnknownRecord = Record<string, unknown>;

const CREATE_STATUSES = new Set<MissionPlanCreateStatus>(['draft', 'active']);
const ARCHIVE_STATUSES = new Set<Extract<TaskPlanStatus, 'archived' | 'superseded'>>([
  'archived',
  'superseded',
]);
const PLAN_REF_SCHEMA = {
  type: 'string',
  description: 'Plan id, title, or compatibility reference.',
};

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

function parseCreateStatus(value: unknown): MissionPlanCreateStatus | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('status must be a string');
  const normalized = value.trim().toLowerCase();
  if (CREATE_STATUSES.has(normalized as MissionPlanCreateStatus)) {
    return normalized as MissionPlanCreateStatus;
  }
  throw new Error('status must be draft or active');
}

function parseArchiveStatus(
  value: unknown,
): Extract<TaskPlanStatus, 'archived' | 'superseded'> | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('status must be a string');
  const normalized = value.trim().toLowerCase();
  if (ARCHIVE_STATUSES.has(normalized as Extract<TaskPlanStatus, 'archived' | 'superseded'>)) {
    return normalized as Extract<TaskPlanStatus, 'archived' | 'superseded'>;
  }
  throw new Error('status must be archived or superseded');
}

function assignDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function planRef(input: UnknownRecord): string | undefined {
  return firstString(input, 'planId', 'plan_id', 'id', 'plan', 'title', 'name');
}

export const missionPlanCreateSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      status: {
        type: 'string',
        enum: ['draft', 'active'],
      },
    },
  },
  parse(input: unknown): MissionPlanCreateArgs {
    if (!isRecord(input)) throw new Error('mission.plan.create args must be an object');

    const title = firstString(input, 'title', 'plan', 'name');
    if (!title) {
      throw new Error('mission.plan.create requires title');
    }

    const args: MissionPlanCreateArgs = { title };
    assignDefined(args, 'body', optionalString(input, 'body', 'content', 'markdown'));
    assignDefined(args, 'status', parseCreateStatus(input.status ?? input.state));
    return args;
  },
};

export const missionPlanUpdateSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['planId'],
    properties: {
      planId: PLAN_REF_SCHEMA,
      title: { type: 'string' },
      body: { type: 'string' },
    },
  },
  parse(input: unknown): MissionPlanUpdateArgs {
    if (!isRecord(input)) throw new Error('mission.plan.update args must be an object');

    const planId = planRef(input);
    if (!planId) {
      throw new Error('mission.plan.update requires planId (or title for compatibility)');
    }

    const args: MissionPlanUpdateArgs = { planId };
    assignDefined(args, 'title', optionalString(input, 'title', 'name'));
    assignDefined(args, 'body', optionalString(input, 'body', 'content', 'markdown'));
    if (!args.title && args.body === undefined) {
      throw new Error('mission.plan.update requires title or body');
    }
    return args;
  },
};

export const missionPlanActivateSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['planId'],
    properties: {
      planId: PLAN_REF_SCHEMA,
    },
  },
  parse(input: unknown): MissionPlanActivateArgs {
    if (!isRecord(input)) throw new Error('mission.plan.activate args must be an object');

    const planId = planRef(input);
    if (!planId) {
      throw new Error('mission.plan.activate requires planId');
    }

    return { planId };
  },
};

export const missionPlanArchiveSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['planId'],
    properties: {
      planId: PLAN_REF_SCHEMA,
      status: {
        type: 'string',
        enum: ['archived', 'superseded'],
      },
      reason: { type: 'string' },
    },
  },
  parse(input: unknown): MissionPlanArchiveArgs {
    if (!isRecord(input)) throw new Error('mission.plan.archive args must be an object');

    const planId = planRef(input);
    if (!planId) {
      throw new Error('mission.plan.archive requires planId');
    }

    const args: MissionPlanArchiveArgs = { planId };
    assignDefined(args, 'status', parseArchiveStatus(input.status ?? input.state));
    assignDefined(args, 'reason', optionalString(input, 'reason', 'note', 'summary'));
    return args;
  },
};
