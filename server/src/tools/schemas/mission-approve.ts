// server/src/tools/schemas/mission-approve.ts

import type { ApproveAction } from '../../mission-state/mission-approve-applicator.js';

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

const ACTION_ALIASES = new Map<string, ApproveAction>([
  ['approve', 'approve'],
  ['accept', 'approve'],
  ['ok', 'approve'],
  ['reject', 'reject'],
  ['deny', 'reject'],
  ['decline', 'reject'],
  ['request-changes', 'request-changes'],
  ['request_changes', 'request-changes'],
  ['changes', 'request-changes'],
  ['revise', 'request-changes'],
]);

function parseAction(value: unknown): ApproveAction {
  if (typeof value !== 'string') throw new Error('action is required');
  const normalized = value.trim().toLowerCase();
  const aliased = ACTION_ALIASES.get(normalized);
  if (aliased) return aliased;
  throw new Error(`action must be 'approve', 'reject', or 'request-changes'`);
}

export interface MissionApproveArgs {
  taskId: string;
  action: ApproveAction;
  reason?: string;
}

export const missionApproveSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['taskId', 'action'],
    properties: {
      taskId: { type: 'string', description: 'Task id to approve / reject / request-changes on.' },
      action: { type: 'string', enum: ['approve', 'reject', 'request-changes'] },
      reason: {
        type: 'string',
        description: 'Required for reject and request-changes; optional for approve.',
      },
    },
  },
  parse(input: unknown): MissionApproveArgs {
    if (!isRecord(input)) throw new Error('mission.approve args must be an object');
    const taskId = requireString(input, 'taskId', 'taskId', 'task_id', 'task', 'id');
    const action = parseAction(input.action);
    const args: MissionApproveArgs = { taskId, action };
    const reason = optionalString(input, 'reason', 'detail', 'note');
    if (reason !== undefined) args.reason = reason;
    return args;
  },
};
