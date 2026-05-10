// server/src/tools/schemas/mission-verify.ts

import type { AcceptanceCheckStatus } from '../../repos/acceptance-criteria.js';
import type { VerifySide } from '../../mission-state/mission-verify-applicator.js';

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

function parseSide(value: unknown): VerifySide {
  if (typeof value !== 'string') throw new Error('side is required');
  const normalized = value.trim().toLowerCase();
  if (normalized === 'doer' || normalized === 'verifier') return normalized;
  throw new Error(`side must be 'doer' or 'verifier'`);
}

function parseStatus(value: unknown): Exclude<AcceptanceCheckStatus, 'pending'> {
  if (typeof value !== 'string') throw new Error('status is required');
  const normalized = value.trim().toLowerCase();
  if (normalized === 'pass' || normalized === 'fail') return normalized;
  throw new Error(`status must be 'pass' or 'fail'`);
}

export interface MissionVerifyArgs {
  side: VerifySide;
  acId: string;
  status: 'pass' | 'fail';
  evidence: string;
}

export const missionVerifySchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['side', 'acId', 'status', 'evidence'],
    properties: {
      side: { type: 'string', enum: ['doer', 'verifier'] },
      acId: { type: 'string', description: 'Acceptance criterion id.' },
      status: { type: 'string', enum: ['pass', 'fail'] },
      evidence: {
        type: 'string',
        description: 'Non-empty evidence supporting the pass/fail.',
      },
    },
  },
  parse(input: unknown): MissionVerifyArgs {
    if (!isRecord(input)) throw new Error('mission.verify args must be an object');
    const side = parseSide(input.side);
    const acId = requireString(input, 'acId', 'acId', 'ac_id', 'id');
    const status = parseStatus(input.status);
    const evidence = requireString(input, 'evidence', 'evidence', 'detail');
    return { side, acId, status, evidence };
  },
};
