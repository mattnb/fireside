// client/app/task-constants.ts
// Shared task-status constants. ACTIVE_TASK_STATUSES is the authoritative
// definition of "this task is currently in flight" — used everywhere from
// activeTask resolution to mission-history sorting to event handling.

import type { TaskStatus } from './api.types';

export const ACTIVE_TASK_STATUSES: TaskStatus[] = ['active', 'blocked', 'verifying'];
