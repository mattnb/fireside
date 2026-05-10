// server/src/tools/schemas/mission-acceptance.ts
//
// Schemas for mission.acceptance.{create,update,reorder}. Lead manages AC rows
// during the proposal phase; once the task is approved, mutations route
// through the verify path instead.

type UnknownRecord = Record<string, unknown>;

function isRecord(input: unknown): input is UnknownRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function requireString(input: UnknownRecord, label: string, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  throw new Error(`${label} is required`);
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

function optionalInteger(input: UnknownRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export interface MissionAcceptanceCreateArgs {
  title: string;
  detail?: string;
  doer?: string;
  sortOrder?: number;
}

export const missionAcceptanceCreateSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
      title: {
        type: 'string',
        description: 'One-line acceptance criterion. Must be non-empty.',
      },
      detail: {
        type: 'string',
        description: 'Optional longer-form detail.',
      },
      doer: {
        type: 'string',
        description: 'Optional agent id assigned as the doer for this AC.',
      },
      sortOrder: {
        type: 'integer',
        description: 'Optional position in the AC list. Defaults to the next available slot.',
      },
    },
  },
  parse(input: unknown): MissionAcceptanceCreateArgs {
    if (!isRecord(input)) throw new Error('mission.acceptance.create args must be an object');
    const title = requireString(input, 'title', 'title');
    const args: MissionAcceptanceCreateArgs = { title };
    const detail = optionalString(input, 'detail', 'description');
    if (detail !== undefined) args.detail = detail;
    const doer = optionalString(input, 'doer', 'doerAgentId', 'doer_agent_id');
    if (doer !== undefined) args.doer = doer;
    const sortOrder = optionalInteger(input, 'sortOrder', 'sort_order', 'order');
    if (sortOrder !== undefined) args.sortOrder = sortOrder;
    return args;
  },
};

export interface MissionAcceptanceUpdateArgs {
  id: string;
  title?: string;
  detail?: string;
  doer?: string | null;
  sortOrder?: number;
}

export const missionAcceptanceUpdateSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: {
        type: 'string',
        description: 'AC id returned by mission.acceptance.create.',
      },
      title: { type: 'string' },
      detail: { type: 'string' },
      doer: {
        type: ['string', 'null'],
        description:
          'Set to a string to assign a doer; set to null (or empty string) to clear.',
      },
      sortOrder: { type: 'integer' },
    },
  },
  parse(input: unknown): MissionAcceptanceUpdateArgs {
    if (!isRecord(input)) throw new Error('mission.acceptance.update args must be an object');
    const id = requireString(input, 'id', 'id');
    const args: MissionAcceptanceUpdateArgs = { id };
    const title = optionalString(input, 'title');
    if (title !== undefined) args.title = title;
    const detail = optionalString(input, 'detail', 'description');
    if (detail !== undefined) args.detail = detail;
    if ('doer' in input || 'doerAgentId' in input || 'doer_agent_id' in input) {
      const raw =
        (input.doer ?? input.doerAgentId ?? input.doer_agent_id) as unknown;
      if (raw === null || (typeof raw === 'string' && !raw.trim())) {
        args.doer = null;
      } else if (typeof raw === 'string') {
        args.doer = raw.trim();
      }
    }
    const sortOrder = optionalInteger(input, 'sortOrder', 'sort_order', 'order');
    if (sortOrder !== undefined) args.sortOrder = sortOrder;
    return args;
  },
};

export interface MissionAcceptanceReorderArgs {
  id: string;
  sortOrder: number;
}

export const missionAcceptanceReorderSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'sortOrder'],
    properties: {
      id: { type: 'string' },
      sortOrder: { type: 'integer' },
    },
  },
  parse(input: unknown): MissionAcceptanceReorderArgs {
    if (!isRecord(input)) throw new Error('mission.acceptance.reorder args must be an object');
    const id = requireString(input, 'id', 'id');
    const sortOrder = optionalInteger(input, 'sortOrder', 'sort_order', 'order');
    if (sortOrder === undefined) {
      throw new Error('mission.acceptance.reorder requires a sortOrder integer');
    }
    return { id, sortOrder };
  },
};
