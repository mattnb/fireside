import type { MissionReceiptStatus } from '../../mission-receipts.js';

export interface MissionReceiptSubmitArgs {
  status: MissionReceiptStatus;
  summary?: string;
  evidence?: string;
  next?: string;
  planRef?: string;
  phaseRef?: string;
  itemRef?: string;
}

type UnknownRecord = Record<string, unknown>;

const STATUSES = new Set<MissionReceiptStatus>([
  'completed',
  'blocked',
  'needs_review',
  'continuing',
  'no_update',
]);

const STATUS_ALIASES = new Map<string, MissionReceiptStatus>([
  ['accepted', 'completed'],
  ['complete', 'completed'],
  ['done', 'completed'],
  ['finished', 'completed'],
  ['resolved', 'completed'],
  ['verified', 'completed'],
  ['stuck', 'blocked'],
  ['waiting', 'blocked'],
  ['review', 'needs_review'],
  ['needs review', 'needs_review'],
  ['verify', 'needs_review'],
  ['verification', 'needs_review'],
  ['in_progress', 'continuing'],
  ['in progress', 'continuing'],
  ['working', 'continuing'],
  ['active', 'continuing'],
  ['none', 'no_update'],
  ['no update', 'no_update'],
  ['no-update', 'no_update'],
  ['noop', 'no_update'],
]);

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

function parseStatus(value: unknown): MissionReceiptStatus {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('mission.receipt.submit requires a status');
  }
  const normalized = value.trim().toLowerCase();
  if (STATUSES.has(normalized as MissionReceiptStatus)) {
    return normalized as MissionReceiptStatus;
  }
  const aliased = STATUS_ALIASES.get(normalized);
  if (aliased) return aliased;
  throw new Error(`status must be one of: ${Array.from(STATUSES).join(', ')}`);
}

function assignDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined && value !== '') target[key] = value;
}

export const missionReceiptSubmitSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['status'],
    properties: {
      status: {
        type: 'string',
        enum: ['completed', 'blocked', 'needs_review', 'continuing', 'no_update'],
        description:
          'Receipt status. Aliases (done, finished, working, in_progress, ...) are normalized.',
      },
      summary: {
        type: 'string',
        description: 'One-line summary of progress, completion, or blocker.',
      },
      evidence: {
        type: 'string',
        description: 'Supporting evidence for the receipt (paths, command output, citations).',
      },
      next: {
        type: 'string',
        description: 'Optional next step the agent intends to take.',
      },
      planRef: {
        type: 'string',
        description: 'Plan id, title, or compatibility reference the receipt relates to.',
      },
      phaseRef: {
        type: 'string',
        description: 'Phase id, title, or compatibility reference the receipt relates to.',
      },
      itemRef: {
        type: 'string',
        description:
          'Checklist item id or title/reference. When omitted, the active work-lane assignment is used (when applicable).',
      },
    },
  },
  parse(input: unknown): MissionReceiptSubmitArgs {
    if (!isRecord(input)) {
      throw new Error('mission.receipt.submit args must be an object');
    }
    const status = parseStatus(input.status ?? input.state);
    const args: MissionReceiptSubmitArgs = { status };
    assignDefined(args, 'summary', optionalString(input, 'summary', 'note', 'message'));
    assignDefined(args, 'evidence', optionalString(input, 'evidence', 'evidence_link', 'proof'));
    assignDefined(args, 'next', optionalString(input, 'next', 'next_step', 'followup'));
    assignDefined(args, 'planRef', optionalString(input, 'planRef', 'plan_ref', 'plan'));
    assignDefined(args, 'phaseRef', optionalString(input, 'phaseRef', 'phase_ref', 'phase'));
    assignDefined(
      args,
      'itemRef',
      optionalString(input, 'itemRef', 'item_ref', 'item', 'taskId', 'task_id'),
    );
    return args;
  },
};
