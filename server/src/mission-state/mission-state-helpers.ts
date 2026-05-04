import type { TaskChecklistItem, TaskChecklistNoteKind } from '../repos/task-checklist.js';
import type { TaskPhase } from '../repos/task-phases.js';
import type { TaskPlan } from '../repos/task-plans.js';
import type { ParsedMissionTaskUpdate } from '../mission-task-updates.js';

export function resolveChecklistItem(
  items: TaskChecklistItem[],
  ref: string,
): TaskChecklistItem | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  return (
    items.find((item) => item.id === trimmed) ??
    items.find((item) => item.title.toLowerCase() === lower) ??
    items.find((item) => item.title.toLowerCase().startsWith(lower)) ??
    null
  );
}

export function normalizePhaseRef(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function preferredPhaseMatch(matches: TaskPhase[]): TaskPhase | null {
  return (
    matches.find((phase) => phase.status === 'active') ??
    matches.find((phase) => phase.status === 'blocked') ??
    matches.find((phase) => phase.status === 'planned') ??
    matches.find((phase) => phase.status === 'done') ??
    null
  );
}

export function resolvePhaseId(phases: TaskPhase[], ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const exactIdMatch = phases.find((phase) => phase.id === trimmed);
  if (exactIdMatch) return exactIdMatch.id;

  const lower = trimmed.toLowerCase();
  const normalized = normalizePhaseRef(trimmed);
  return (
    preferredPhaseMatch(phases.filter((phase) => phase.title.toLowerCase() === lower))?.id ??
    (normalized
      ? preferredPhaseMatch(
          phases.filter((phase) => normalizePhaseRef(phase.title) === normalized),
        )?.id
      : null) ??
    preferredPhaseMatch(phases.filter((phase) => phase.title.toLowerCase().startsWith(lower)))
      ?.id ??
    (normalized
      ? preferredPhaseMatch(
          phases.filter((phase) => normalizePhaseRef(phase.title).startsWith(normalized)),
        )?.id
      : null) ??
    null
  );
}

export function resolvePhase(phases: TaskPhase[], ref: string): TaskPhase | null {
  const phaseId = resolvePhaseId(phases, ref);
  return phaseId ? (phases.find((phase) => phase.id === phaseId) ?? null) : null;
}

export function resolvePlan(plans: TaskPlan[], ref: string): TaskPlan | null {
  const trimmed = ref.trim();
  if (!trimmed) return plans.find((plan) => plan.status === 'active') ?? null;
  const lower = trimmed.toLowerCase();
  if (['active', 'current', 'current active'].includes(lower)) {
    return plans.find((plan) => plan.status === 'active') ?? null;
  }
  if (['none', 'unassigned', 'no plan'].includes(lower)) return null;
  return (
    plans.find((plan) => plan.id === trimmed) ??
    plans.find((plan) => plan.title.toLowerCase() === lower) ??
    plans.find((plan) => plan.title.toLowerCase().startsWith(lower)) ??
    null
  );
}

export function resolvePlanId(plans: TaskPlan[], ref: string): string | null {
  return resolvePlan(plans, ref)?.id ?? null;
}

export function isPlanClearRef(ref: string): boolean {
  return ['none', 'unassigned', 'no plan'].includes(ref.trim().toLowerCase());
}

export function resolveDependencyIds(
  items: TaskChecklistItem[],
  refs: string[],
  currentItemId = '',
): string[] {
  return [
    ...new Set(
      refs
        .map((ref) => resolveChecklistItem(items, ref)?.id ?? '')
        .filter((id) => id && id !== currentItemId),
    ),
  ];
}

export function inferChecklistCompletion(update: ParsedMissionTaskUpdate): boolean {
  if (update.status) return update.status === 'done';
  if (update.noteKind === 'completion') return true;
  const text = [update.note, update.statusNote].filter(Boolean).join(' ').toLowerCase();
  if (!text) return false;
  if (
    /\b(blocked|blocking|gated|gate|waiting|pending|queued|not done|not complete|incomplete|remaining|remains|needs|requires|required)\b/.test(
      text,
    )
  ) {
    return false;
  }
  return /\b(done|complete|completed|finished|resolved|accepted|settled|merged|landed)\b/.test(
    text,
  );
}

export function noteKindForMissionTaskUpdate(
  update: ParsedMissionTaskUpdate,
): TaskChecklistNoteKind {
  if (update.councilRequired === true) return 'council';
  if (inferChecklistCompletion(update)) return 'completion';
  return update.noteKind;
}
