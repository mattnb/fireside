import type { TaskPhaseStatus } from './repos/task-phases.js';
import { hiddenBlockRegex } from './hidden-blocks.js';

export type MissionPhaseAction = 'create' | 'update';

export interface ParsedMissionPhaseUpdate {
  action: MissionPhaseAction;
  id: string;
  planRef: string;
  title: string;
  description: string;
  status: TaskPhaseStatus | null;
  gate: string;
  sortOrder: number | null;
}

export interface ExtractedMissionPhaseUpdates {
  visibleText: string;
  updates: ParsedMissionPhaseUpdate[];
}

const PHASE_RE = hiddenBlockRegex('mission-phase', ['mission-phase', 'collab-note']);
const ACTIONS = new Set(['create', 'update']);
const STATUSES = new Set(['planned', 'active', 'blocked', 'done']);
const STATUS_ALIASES = new Map<string, TaskPhaseStatus>([
  ['accepted', 'done'],
  ['closed', 'done'],
  ['complete', 'done'],
  ['completed', 'done'],
  ['finished', 'done'],
  ['resolved', 'done'],
  ['satisfied', 'done'],
  ['current', 'active'],
  ['in_progress', 'active'],
  ['in progress', 'active'],
  ['waiting', 'blocked'],
  ['stuck', 'blocked'],
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

function all(fields: Map<string, string[]>, ...keys: string[]): string[] {
  return keys
    .flatMap((key) => fields.get(key) ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeAction(value: string): MissionPhaseAction {
  const normalized = value.trim().toLowerCase();
  return ACTIONS.has(normalized) ? (normalized as MissionPhaseAction) : 'update';
}

function normalizeStatus(value: string): TaskPhaseStatus | null {
  const normalized = value.trim().toLowerCase();
  return STATUSES.has(normalized)
    ? (normalized as TaskPhaseStatus)
    : (STATUS_ALIASES.get(normalized) ?? null);
}

function parseSortOrder(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseBlock(block: string): ParsedMissionPhaseUpdate | null {
  const fields = parseFields(block);
  const action = normalizeAction(first(fields, 'action', 'mode'));
  const id = first(fields, 'id', 'phase_id');
  const planRef = first(fields, 'plan', 'plan_id');
  const title = first(fields, 'title', 'phase', 'name');

  if (action !== 'create' && !id && !title) return null;
  if (action === 'create' && !title) return null;

  return {
    action,
    id,
    planRef,
    title,
    description: all(fields, 'description', 'detail').join('\n').trim(),
    status: normalizeStatus(first(fields, 'status', 'state')),
    gate: all(fields, 'gate', 'criteria', 'exit_criteria').join('\n').trim(),
    sortOrder: parseSortOrder(first(fields, 'sort_order', 'order')),
  };
}

export function extractMissionPhaseUpdates(text: string): ExtractedMissionPhaseUpdates {
  const updates: ParsedMissionPhaseUpdate[] = [];
  const visibleText = text.replace(PHASE_RE, (match, prefix: string, block: string) => {
    const parsed = parseBlock(block);
    if (parsed) updates.push(parsed);
    return prefix === '\n' ? '\n' : '';
  });
  return {
    visibleText: visibleText.trim(),
    updates,
  };
}
