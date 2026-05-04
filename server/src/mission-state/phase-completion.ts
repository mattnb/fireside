import type { Database } from 'better-sqlite3';
import type { TaskChecklistItem } from '../repos/task-checklist.js';
import { listTaskChecklistItems } from '../repos/task-checklist.js';
import type { TaskPhase } from '../repos/task-phases.js';

export function unfinishedChecklistItemsForPhase(
  db: Database,
  taskId: string,
  phaseId: string,
): TaskChecklistItem[] {
  return listTaskChecklistItems(db, taskId).filter(
    (item) =>
      item.phaseId === phaseId &&
      item.status !== 'done' &&
      item.status !== 'skipped',
  );
}

export function phaseCompletionBlockedDetail(
  phase: Pick<TaskPhase, 'title'>,
  unfinished: TaskChecklistItem[],
): string {
  const preview = unfinished
    .slice(0, 4)
    .map((item) => `${item.title} (${item.status})`)
    .join('; ');
  const suffix = unfinished.length > 4 ? `; +${unfinished.length - 4} more` : '';
  return `${phase.title} cannot be marked done while ${unfinished.length} checklist item(s) remain unfinished: ${preview}${suffix}`;
}
