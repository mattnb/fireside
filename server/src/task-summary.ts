import type { TaskChecklistItem } from './repos/task-checklist.js';
import type { TaskPhase } from './repos/task-phases.js';
import type { TaskPlan } from './repos/task-plans.js';
import type { Task } from './repos/tasks.js';

export interface MissionControlSnapshot {
  currentPhase: TaskPhase | null;
  openChecklistItems: TaskChecklistItem[];
  blockedChecklistItems: TaskChecklistItem[];
  activePlan: TaskPlan | null;
}

export interface TaskPromptContext {
  id: string;
  title: string;
  status: string;
  goal: string;
  repoPath: string;
  acceptanceCriteria: string;
  assignedAgents: string[];
  capabilityProfile: string;
  summary: string;
  /** Proposal-gate state. 'approved' on legacy tasks. */
  proposalStatus: string;
  /** Agent currently assigned as verifier; null when humans verify. */
  verifierAgentId: string | null;
  missionControl?: MissionControlSnapshot;
}

export function buildTaskPromptContext(opts: {
  task: Task;
  missionControl?: MissionControlSnapshot;
}): TaskPromptContext {
  return {
    id: opts.task.id,
    title: opts.task.title,
    status: opts.task.status,
    goal: opts.task.goal,
    repoPath: opts.task.repoPath,
    acceptanceCriteria: opts.task.acceptanceCriteria,
    assignedAgents: opts.task.agents,
    capabilityProfile: opts.task.capabilityProfile,
    summary: opts.task.summary,
    proposalStatus: opts.task.proposalStatus,
    verifierAgentId: opts.task.verifierAgentId,
    ...(opts.missionControl ? { missionControl: opts.missionControl } : {}),
  };
}
