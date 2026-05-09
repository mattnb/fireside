// server/src/tools/schemas/collab.ts
//
// Schema skeletons for the `collab.*` tool family. Phase 4 (design pass)
// only fixes the contract; Milestone 4 will wrap `storeCollaborationNotes`
// in `server/src/mission-state/collaboration-note-applicator.ts`.
//
// Status defaults match `defaultStatus(kind)` in `collaboration-notes.ts` so
// the tool layer behaves identically to the legacy `/collab-note` parser.
// See docs/phase-4-permission-collab-design-2026-05-07.md for the full design.

import type {
  CollaborationConfidence,
  CollaborationKind,
  CollaborationStatus,
} from '../../repos/collaboration.js';

const KIND_SET: ReadonlySet<CollaborationKind> = new Set<CollaborationKind>([
  'proposal',
  'challenge',
  'revision',
  'decision',
  'evidence',
]);

const STATUS_SET: ReadonlySet<CollaborationStatus> = new Set<CollaborationStatus>([
  'open',
  'blocked',
  'accepted',
  'rejected',
  'resolved',
  'superseded',
  'informational',
]);

const CONFIDENCE_SET: ReadonlySet<CollaborationConfidence> =
  new Set<CollaborationConfidence>(['', 'low', 'medium', 'high']);

const TITLE_MAX = 200;
const TARGET_MAX = 200;
const BODY_MAX = 4000;
const EVIDENCE_ITEM_MAX = 500;
const EVIDENCE_COUNT_MAX = 16;

export interface CollabNoteAddArgs {
  kind: CollaborationKind;
  title?: string;
  body?: string;
  target?: string;
  evidence?: string[];
  status?: CollaborationStatus;
  confidence?: CollaborationConfidence;
}

export interface CollabNoteUpdateArgs {
  /** Existing collaboration_notes.id */
  id: string;
  status?: CollaborationStatus;
  title?: string;
  body?: string;
  evidence?: string[];
  confidence?: CollaborationConfidence;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(input: unknown): input is UnknownRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalCappedString(
  input: UnknownRecord,
  key: string,
  max: number,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new Error(`${key} exceeds ${max} characters`);
  return trimmed;
}

function parseEvidence(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('evidence must be an array');
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length > EVIDENCE_ITEM_MAX) {
      throw new Error(`evidence item exceeds ${EVIDENCE_ITEM_MAX} characters`);
    }
    out.push(trimmed);
    if (out.length > EVIDENCE_COUNT_MAX) {
      throw new Error(`evidence is limited to ${EVIDENCE_COUNT_MAX} items`);
    }
  }
  return out;
}

function parseStatus(value: unknown): CollaborationStatus | undefined {
  const trimmed = trimmedString(value).toLowerCase();
  if (!trimmed) return undefined;
  if (!STATUS_SET.has(trimmed as CollaborationStatus)) {
    throw new Error(`unknown collaboration status: ${trimmed}`);
  }
  return trimmed as CollaborationStatus;
}

function parseConfidence(value: unknown): CollaborationConfidence | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const trimmed = trimmedString(value).toLowerCase();
  if (!CONFIDENCE_SET.has(trimmed as CollaborationConfidence)) {
    throw new Error(`unknown collaboration confidence: ${trimmed}`);
  }
  return trimmed as CollaborationConfidence;
}

export function parseCollabNoteAddArgs(input: unknown): CollabNoteAddArgs {
  if (!isRecord(input)) throw new Error('collab.note.add args must be an object');

  const kindRaw = trimmedString(input.kind).toLowerCase();
  if (!kindRaw) throw new Error('kind is required');
  if (!KIND_SET.has(kindRaw as CollaborationKind)) {
    throw new Error(`unknown collaboration kind: ${kindRaw}`);
  }
  const kind = kindRaw as CollaborationKind;

  const title = optionalCappedString(input, 'title', TITLE_MAX);
  const body = optionalCappedString(input, 'body', BODY_MAX);
  const target = optionalCappedString(input, 'target', TARGET_MAX);
  const evidence = parseEvidence(input.evidence);
  const status = parseStatus(input.status);
  const confidence = parseConfidence(input.confidence);

  if (!title && !body) {
    throw new Error('collab.note.add requires at least one of title or body');
  }

  return {
    kind,
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

export function parseCollabNoteUpdateArgs(input: unknown): CollabNoteUpdateArgs {
  if (!isRecord(input)) throw new Error('collab.note.update args must be an object');

  const id = trimmedString(input.id);
  if (!id) throw new Error('id is required');

  const title = optionalCappedString(input, 'title', TITLE_MAX);
  const body = optionalCappedString(input, 'body', BODY_MAX);
  const evidence = parseEvidence(input.evidence);
  const status = parseStatus(input.status);
  const confidence = parseConfidence(input.confidence);

  if (
    title === undefined &&
    body === undefined &&
    evidence === undefined &&
    status === undefined &&
    confidence === undefined
  ) {
    throw new Error('collab.note.update requires at least one mutable field');
  }

  return {
    id,
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

/**
 * Default `status` for a freshly added note when the agent omits it. Mirrors
 * the legacy `/collab-note` parser so the tool layer is behaviorally
 * indistinguishable from the hidden block.
 */
export function defaultCollabNoteStatus(kind: CollaborationKind): CollaborationStatus {
  if (kind === 'decision') return 'accepted';
  if (kind === 'evidence') return 'informational';
  if (kind === 'revision') return 'resolved';
  return 'open';
}

const COLLABORATION_KINDS: readonly CollaborationKind[] = [
  'proposal',
  'challenge',
  'revision',
  'decision',
  'evidence',
];
const COLLABORATION_STATUSES: readonly CollaborationStatus[] = [
  'open',
  'blocked',
  'accepted',
  'rejected',
  'resolved',
  'superseded',
  'informational',
];
const COLLABORATION_CONFIDENCES: readonly CollaborationConfidence[] = ['low', 'medium', 'high'];

export const collabNoteAddSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: COLLABORATION_KINDS as unknown as string[] },
      title: { type: 'string', maxLength: TITLE_MAX },
      body: { type: 'string', maxLength: BODY_MAX },
      target: {
        type: 'string',
        maxLength: TARGET_MAX,
        description: 'Subject of the note (e.g. checklist item title or path).',
      },
      evidence: {
        type: 'array',
        maxItems: EVIDENCE_COUNT_MAX,
        items: { type: 'string', maxLength: EVIDENCE_ITEM_MAX },
        description: 'Array of evidence strings (paths, citations, command output).',
      },
      status: { type: 'string', enum: COLLABORATION_STATUSES as unknown as string[] },
      confidence: { type: 'string', enum: COLLABORATION_CONFIDENCES as unknown as string[] },
    },
  },
  parse: parseCollabNoteAddArgs,
};

export const collabNoteUpdateSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: {
        type: 'string',
        description: 'Existing collaboration note id to update.',
      },
      title: { type: 'string', maxLength: TITLE_MAX },
      body: { type: 'string', maxLength: BODY_MAX },
      evidence: {
        type: 'array',
        maxItems: EVIDENCE_COUNT_MAX,
        items: { type: 'string', maxLength: EVIDENCE_ITEM_MAX },
      },
      status: { type: 'string', enum: COLLABORATION_STATUSES as unknown as string[] },
      confidence: { type: 'string', enum: COLLABORATION_CONFIDENCES as unknown as string[] },
    },
  },
  parse: parseCollabNoteUpdateArgs,
};
