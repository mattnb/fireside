import type {
  TaskChecklistNoteKind,
  TaskChecklistParallelism,
  TaskChecklistStatus,
} from './repos/task-checklist.js';
import {
  hiddenBlockRegex,
  parseHiddenBlockFields,
  stripEmptyHiddenBlockComments,
} from './hidden-blocks.js';

export type MissionTaskAction = 'create' | 'update' | 'note';

export interface ParsedMissionTaskUpdate {
  action: MissionTaskAction;
  id: string;
  title: string;
  detail: string;
  status: TaskChecklistStatus | null;
  dependencyRefs: string[];
  expectedTouches: string[];
  parallelism: TaskChecklistParallelism | null;
  conflictGroup: string;
  workRole: string;
  ownerAgentId: string;
  statusNote: string;
  blockedReason: string;
  councilRequired: boolean | null;
  noteKind: TaskChecklistNoteKind;
  note: string;
  planRef: string;
  phaseRef: string;
}

export interface ExtractedMissionTaskUpdates {
  visibleText: string;
  updates: ParsedMissionTaskUpdate[];
}

const TASK_RE = hiddenBlockRegex('mission-task', ['mission-task', 'collab-note']);
const ACTIONS = new Set(['create', 'update', 'note']);
const STATUSES = new Set(['open', 'blocked', 'done', 'skipped']);
const STATUS_ALIASES = new Map<string, TaskChecklistStatus>([
  ['accepted', 'done'],
  ['closed', 'done'],
  ['complete', 'done'],
  ['completed', 'done'],
  ['finished', 'done'],
  ['resolved', 'done'],
  ['merged', 'done'],
  ['todo', 'open'],
  ['queued', 'open'],
  ['pending', 'open'],
  ['in_progress', 'open'],
  ['in progress', 'open'],
  ['working', 'open'],
  ['started', 'open'],
  ['waiting', 'blocked'],
  ['stuck', 'blocked'],
  ['deferred', 'skipped'],
]);
const NOTE_KINDS = new Set(['status', 'completion', 'blocker', 'council']);
const PARALLELISM_ALIASES = new Map<string, TaskChecklistParallelism>([
  ['parallel', 'parallel-safe'],
  ['parallel_safe', 'parallel-safe'],
  ['parallel-safe', 'parallel-safe'],
  ['safe', 'parallel-safe'],
  ['independent', 'parallel-safe'],
  ['coordinate', 'coordinate'],
  ['coordinated', 'coordinate'],
  ['shared', 'coordinate'],
  ['exclusive', 'exclusive'],
  ['serial', 'exclusive'],
  ['single_writer', 'exclusive'],
  ['single-writer', 'exclusive'],
  ['lock', 'exclusive'],
  ['locked', 'exclusive'],
]);

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

function normalizeAction(value: string): MissionTaskAction {
  const normalized = value.trim().toLowerCase();
  return ACTIONS.has(normalized) ? (normalized as MissionTaskAction) : 'update';
}

function normalizeStatus(value: string): TaskChecklistStatus | null {
  const normalized = value.trim().toLowerCase();
  return STATUSES.has(normalized)
    ? (normalized as TaskChecklistStatus)
    : (STATUS_ALIASES.get(normalized) ?? null);
}

function normalizeNoteKind(
  value: string,
  status: TaskChecklistStatus | null,
): TaskChecklistNoteKind {
  const normalized = value.trim().toLowerCase();
  if (NOTE_KINDS.has(normalized)) return normalized as TaskChecklistNoteKind;
  if (status === 'done') return 'completion';
  if (status === 'blocked') return 'blocker';
  return 'status';
}

function normalizeParallelism(value: string): TaskChecklistParallelism | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_');
  return PARALLELISM_ALIASES.get(normalized) ?? null;
}

function splitRefs(values: string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => value.split(/,|;|\n/))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

function parseBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'required'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0', 'none'].includes(normalized)) return false;
  return null;
}

function parseBlock(block: string): ParsedMissionTaskUpdate | null {
  const fields = parseHiddenBlockFields(block);
  const action = normalizeAction(first(fields, 'action', 'mode'));
  const id = first(fields, 'id', 'item_id', 'task_id');
  const title = first(fields, 'title', 'task', 'name');
  const detail = all(fields, 'detail', 'description').join('\n').trim();
  const status = normalizeStatus(first(fields, 'status', 'state'));
  const statusNote = all(fields, 'status_note', 'note', 'summary').join('\n').trim();
  const parallelism = normalizeParallelism(
    first(fields, 'parallelism', 'parallel', 'coordination'),
  );
  const blockedReason = all(fields, 'blocked_reason', 'blocker', 'reason').join('\n').trim();
  const councilRequired = parseBoolean(
    first(fields, 'council', 'council_required', 'needs_council'),
  );
  const note = all(fields, 'note', 'status_note', 'blocked_reason', 'blocker').join('\n').trim();

  if (action !== 'create' && !id && !title) return null;
  if (action === 'create' && !title) return null;

  return {
    action,
    id,
    title,
    detail,
    status,
    dependencyRefs: splitRefs(all(fields, 'depends_on', 'dependencies', 'dependency_ids')),
    expectedTouches: splitRefs(
      all(fields, 'expected_touches', 'expected_touch', 'touches', 'files', 'paths'),
    ),
    parallelism,
    conflictGroup: first(fields, 'conflict_group', 'conflict', 'scope_group', 'scope'),
    workRole: first(fields, 'work_role', 'role'),
    ownerAgentId: first(fields, 'owner', 'agent', 'assignee'),
    statusNote,
    blockedReason,
    councilRequired,
    noteKind: normalizeNoteKind(first(fields, 'note_kind', 'kind'), status),
    note,
    planRef: first(fields, 'plan', 'plan_id'),
    phaseRef: first(fields, 'phase', 'phase_id'),
  };
}

export function extractMissionTaskUpdates(text: string): ExtractedMissionTaskUpdates {
  const updates: ParsedMissionTaskUpdate[] = [];
  const visibleText = text.replace(TASK_RE, (match, prefix: string, block: string) => {
    const parsed = parseBlock(block);
    if (parsed) updates.push(parsed);
    return prefix === '\n' ? '\n' : '';
  });
  return {
    visibleText: stripEmptyHiddenBlockComments(visibleText).trim(),
    updates,
  };
}
