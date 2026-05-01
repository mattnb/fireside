export type MissionReceiptStatus =
  | 'completed'
  | 'blocked'
  | 'needs_review'
  | 'continuing'
  | 'no_update';

export interface ParsedMissionReceipt {
  status: MissionReceiptStatus;
  itemRef: string;
  phaseRef: string;
  planRef: string;
  summary: string;
  evidence: string;
  next: string;
}

export interface ExtractedMissionReceipts {
  visibleText: string;
  receipts: ParsedMissionReceipt[];
}

const RECEIPT_RE =
  /(^|\n)\/mission-receipt\s*\n([\s\S]*?)\n[/@]end-(?:mission-receipt|collab-note)(?=\s|$)/gi;
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

function parseFields(block: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase().replace(/-/g, '_');
    const value = line.slice(idx + 1).trim();
    if (!fields.has(key)) fields.set(key, []);
    fields.get(key)!.push(value);
  }
  return fields;
}

function first(fields: Map<string, string[]>, ...keys: string[]): string {
  for (const key of keys) {
    const value = fields.get(key)?.[0];
    if (value) return value.trim();
  }
  return '';
}

function all(fields: Map<string, string[]>, ...keys: string[]): string {
  return keys
    .flatMap((key) => fields.get(key) ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeStatus(value: string): MissionReceiptStatus {
  const normalized = value.trim().toLowerCase();
  if (STATUSES.has(normalized as MissionReceiptStatus)) return normalized as MissionReceiptStatus;
  return STATUS_ALIASES.get(normalized) ?? 'continuing';
}

function parseBlock(block: string): ParsedMissionReceipt | null {
  const fields = parseFields(block);
  const status = normalizeStatus(first(fields, 'status', 'state', 'outcome'));
  const summary = all(fields, 'summary', 'note', 'body');
  const evidence = all(fields, 'evidence', 'proof', 'verified_by');
  const next = all(fields, 'next', 'next_step', 'follow_up');
  const itemRef = first(
    fields,
    'item',
    'item_id',
    'task',
    'task_id',
    'checklist',
    'checklist_item',
  );
  const phaseRef = first(fields, 'phase', 'phase_id', 'gate');
  const planRef = first(fields, 'plan', 'plan_id');

  if (!summary && !evidence && !next && !itemRef && !phaseRef && !planRef) return null;

  return {
    status,
    itemRef,
    phaseRef,
    planRef,
    summary,
    evidence,
    next,
  };
}

export function extractMissionReceipts(text: string): ExtractedMissionReceipts {
  const receipts: ParsedMissionReceipt[] = [];
  const visibleText = text.replace(RECEIPT_RE, (match, prefix: string, block: string) => {
    const parsed = parseBlock(block);
    if (parsed) receipts.push(parsed);
    return prefix === '\n' ? '\n' : '';
  });
  return {
    visibleText: visibleText.trim(),
    receipts,
  };
}
