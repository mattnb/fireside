import type {
  CollaborationConfidence,
  CollaborationKind,
  CollaborationStatus,
} from './repos/collaboration.js';

export interface ParsedCollaborationNote {
  kind: CollaborationKind;
  status: CollaborationStatus;
  confidence: CollaborationConfidence;
  title: string;
  target: string;
  body: string;
  evidence: string[];
}

export interface ExtractedCollaborationNotes {
  visibleText: string;
  notes: ParsedCollaborationNote[];
}

const NOTE_RE = /(^|\n)\/collab-note\s*\n([\s\S]*?)\n[/@]end-collab-note(?=\s|$)/gi;
const KINDS: ReadonlySet<string> = new Set([
  'proposal',
  'challenge',
  'revision',
  'decision',
  'evidence',
]);
const STATUSES: ReadonlySet<string> = new Set([
  'open',
  'blocked',
  'accepted',
  'rejected',
  'resolved',
  'superseded',
  'informational',
]);
const CONFIDENCE: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

function normalizeKind(value: string): CollaborationKind | null {
  const normalized = value.trim().toLowerCase();
  return KINDS.has(normalized) ? (normalized as CollaborationKind) : null;
}

function defaultStatus(kind: CollaborationKind): CollaborationStatus {
  if (kind === 'decision') return 'accepted';
  if (kind === 'evidence') return 'informational';
  if (kind === 'revision') return 'resolved';
  return 'open';
}

function normalizeStatus(value: string, kind: CollaborationKind): CollaborationStatus {
  const normalized = value.trim().toLowerCase();
  return STATUSES.has(normalized) ? (normalized as CollaborationStatus) : defaultStatus(kind);
}

function normalizeConfidence(value: string): CollaborationConfidence {
  const normalized = value.trim().toLowerCase();
  return CONFIDENCE.has(normalized) ? (normalized as CollaborationConfidence) : '';
}

function splitEvidence(value: string): string[] {
  return value
    .split(/;|\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBlock(block: string): ParsedCollaborationNote | null {
  const fields = new Map<string, string[]>();
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!fields.has(key)) fields.set(key, []);
    fields.get(key)!.push(value);
  }

  const kind = normalizeKind(fields.get('kind')?.[0] ?? fields.get('type')?.[0] ?? '');
  if (!kind) return null;

  const title =
    fields.get('title')?.[0] ??
    fields.get('claim')?.[0] ??
    fields.get('summary')?.[0] ??
    fields.get('body')?.[0] ??
    '';
  const body = [
    ...(fields.get('body') ?? []),
    ...(fields.get('summary') ?? []),
    ...(fields.get('rationale') ?? []),
  ]
    .join('\n')
    .trim();
  const evidence = (fields.get('evidence') ?? []).flatMap(splitEvidence);

  return {
    kind,
    status: normalizeStatus(fields.get('status')?.[0] ?? '', kind),
    confidence: normalizeConfidence(fields.get('confidence')?.[0] ?? ''),
    title: title.trim() || kind,
    target: (fields.get('target')?.[0] ?? '').trim(),
    body,
    evidence,
  };
}

export function extractCollaborationNotes(text: string): ExtractedCollaborationNotes {
  const notes: ParsedCollaborationNote[] = [];
  const visibleText = text.replace(NOTE_RE, (match, prefix: string, block: string) => {
    const parsed = parseBlock(block);
    if (parsed) notes.push(parsed);
    return prefix === '\n' ? '\n' : '';
  });
  return {
    visibleText: visibleText.trim(),
    notes,
  };
}
