import type { AgentRuntimeStatus } from '../../agents/types.js';

export interface AgentSetStatusArgs {
  agentId?: string;
  status: AgentRuntimeStatus;
  reason?: string;
  until?: string;
  currentTaskId?: string;
}

export interface AgentCheckinArgs {
  includeAssignments: boolean;
  includeQuota: boolean;
  status?: AgentRuntimeStatus;
  reason?: string;
  currentTaskId?: string;
}

export interface AgentListAssignmentsArgs {
  agentId?: string;
  includeCompleted: boolean;
  includeDispatches: boolean;
  includeJobs: boolean;
  limit: number;
}

export interface AgentAckMessageArgs {
  messageIds: string[];
}

export interface AgentRequestTurnsArgs {
  agents: string[];
  reason?: string;
  message?: string;
  priority?: number;
}

type UnknownRecord = Record<string, unknown>;

const STATUS_ALIASES = new Map<string, AgentRuntimeStatus>([
  ['idle', 'idle'],
  ['available', 'idle'],
  ['ready', 'idle'],
  ['active', 'active'],
  ['busy', 'active'],
  ['running', 'active'],
  ['working', 'active'],
  ['blocked', 'blocked'],
  ['stuck', 'blocked'],
  ['waiting', 'blocked'],
  ['offline', 'offline'],
  ['away', 'offline'],
]);

function isRecord(input: unknown): input is UnknownRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function firstString(input: UnknownRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = optionalString(input[key]);
    if (value) return value;
  }
  return undefined;
}

function parseStatus(value: unknown): AgentRuntimeStatus {
  const status = optionalString(value);
  if (!status) throw new Error('agent.set_status requires status');
  const normalized = status.toLowerCase().replace(/\s+/g, '_');
  const parsed = STATUS_ALIASES.get(normalized);
  if (!parsed) throw new Error('status must be one of: idle, active, blocked, offline');
  return parsed;
}

function parseAgentRefs(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const rawValues = Array.isArray(value) ? value : [value];
  const refs = rawValues
    .flatMap((item) => {
      if (typeof item !== 'string') {
        throw new Error('agents must be a string or string[]');
      }
      return item.split(/,|;|\n/);
    })
    .map((item) => item.trim().replace(/^@/, ''))
    .filter(Boolean);
  return refs.length > 0 ? [...new Set(refs)].slice(0, 30) : undefined;
}

function parseStringList(value: unknown, fieldName: string, limit: number): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const rawValues = Array.isArray(value) ? value : [value];
  const refs = rawValues
    .flatMap((item) => {
      if (typeof item !== 'string') {
        throw new Error(`${fieldName} must be a string or string[]`);
      }
      return item.split(/,|;|\n/);
    })
    .map((item) => item.trim())
    .filter(Boolean);
  return refs.length > 0 ? [...new Set(refs)].slice(0, limit) : undefined;
}

function parsePriority(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed)) throw new Error('priority must be an integer');
  return Math.max(-100, Math.min(100, parsed));
}

function parseBoolean(value: unknown, fallback: boolean, fieldName: string): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'on'].includes(normalized)) return true;
    if (['false', 'no', '0', 'off'].includes(normalized)) return false;
  }
  throw new Error(`${fieldName} must be a boolean`);
}

function parsePositiveLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('limit must be a positive integer');
  return Math.min(parsed, max);
}

function assignDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

export const agentSetStatusSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['status'],
    properties: {
      agentId: { type: 'string', description: 'Target agent id. Defaults to the caller.' },
      status: { type: 'string', enum: ['idle', 'active', 'blocked', 'offline'] },
      reason: { type: 'string' },
      until: { type: 'string' },
      currentTaskId: { type: 'string' },
    },
  },
  parse(input: unknown): AgentSetStatusArgs {
    if (!isRecord(input)) throw new Error('agent.set_status args must be an object');
    const args: AgentSetStatusArgs = {
      status: parseStatus(input.status ?? input.state),
    };
    assignDefined(args, 'agentId', firstString(input, 'agentId', 'agent_id', 'agent', 'id'));
    assignDefined(args, 'reason', firstString(input, 'reason', 'note', 'message'));
    assignDefined(args, 'until', firstString(input, 'until', 'expiresAt', 'expires_at'));
    assignDefined(args, 'currentTaskId', firstString(input, 'currentTaskId', 'current_task_id', 'taskId', 'task_id'));
    return args;
  },
};

export const agentCheckinSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      includeAssignments: { type: 'boolean' },
      includeQuota: { type: 'boolean' },
      status: { type: 'string', enum: ['idle', 'active', 'blocked', 'offline'] },
      reason: { type: 'string' },
      currentTaskId: { type: 'string' },
    },
  },
  parse(input: unknown): AgentCheckinArgs {
    if (input === undefined || input === null) {
      return { includeAssignments: false, includeQuota: false };
    }
    if (!isRecord(input)) throw new Error('agent.checkin args must be an object');
    const args: AgentCheckinArgs = {
      includeAssignments: parseBoolean(
        input.includeAssignments ?? input.include_assignments,
        false,
        'includeAssignments',
      ),
      includeQuota: parseBoolean(input.includeQuota ?? input.include_quota, false, 'includeQuota'),
    };
    if (input.status !== undefined || input.state !== undefined) {
      assignDefined(args, 'status', parseStatus(input.status ?? input.state));
    }
    assignDefined(args, 'reason', firstString(input, 'reason', 'note', 'message'));
    assignDefined(args, 'currentTaskId', firstString(input, 'currentTaskId', 'current_task_id', 'taskId', 'task_id'));
    return args;
  },
};

export const agentListAssignmentsSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      agentId: { type: 'string', description: 'Target agent id. Defaults to the caller.' },
      includeCompleted: { type: 'boolean' },
      includeDispatches: { type: 'boolean' },
      includeJobs: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  parse(input: unknown): AgentListAssignmentsArgs {
    if (input === undefined || input === null) {
      return {
        includeCompleted: false,
        includeDispatches: true,
        includeJobs: true,
        limit: 50,
      };
    }
    if (!isRecord(input)) throw new Error('agent.list_assignments args must be an object');
    const args: AgentListAssignmentsArgs = {
      includeCompleted: parseBoolean(
        input.includeCompleted ?? input.include_completed,
        false,
        'includeCompleted',
      ),
      includeDispatches: parseBoolean(
        input.includeDispatches ?? input.include_dispatches,
        true,
        'includeDispatches',
      ),
      includeJobs: parseBoolean(input.includeJobs ?? input.include_jobs, true, 'includeJobs'),
      limit: parsePositiveLimit(input.limit, 50, 100),
    };
    assignDefined(args, 'agentId', firstString(input, 'agentId', 'agent_id', 'agent', 'id'));
    return args;
  },
};

export const agentAckMessageSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      messageId: { type: 'string' },
      messageIds: { type: 'array', items: { type: 'string' } },
    },
  },
  parse(input: unknown): AgentAckMessageArgs {
    if (!isRecord(input)) throw new Error('agent.ack_message args must be an object');
    const messageIds = parseStringList(
      input.messageIds ?? input.message_ids ?? input.messageId ?? input.message_id ?? input.id,
      'messageIds',
      50,
    );
    if (!messageIds || messageIds.length === 0) {
      throw new Error('agent.ack_message requires at least one message id');
    }
    return { messageIds };
  },
};

export const agentRequestTurnsSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['agents'],
    properties: {
      agents: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
      message: { type: 'string' },
      priority: { type: 'integer', minimum: -100, maximum: 100 },
    },
  },
  parse(input: unknown): AgentRequestTurnsArgs {
    if (!isRecord(input)) throw new Error('agent.request_turns args must be an object');
    const agents = parseAgentRefs(
      input.agents ?? input.agentIds ?? input.agent_ids ?? input.responders ?? input.targets,
    );
    if (!agents || agents.length === 0) {
      throw new Error('agent.request_turns requires at least one agent');
    }
    const args: AgentRequestTurnsArgs = { agents };
    assignDefined(args, 'reason', firstString(input, 'reason', 'why'));
    assignDefined(args, 'message', firstString(input, 'message', 'prompt', 'text'));
    assignDefined(args, 'priority', parsePriority(input.priority));
    return args;
  },
};
