import type { AgentRunSummary } from './repos/agent-runs.js';
import type { TaskChecklistItem } from './repos/task-checklist.js';
import type { TaskPhase } from './repos/task-phases.js';
import type { TaskPlan } from './repos/task-plans.js';
import type { Message } from './repos/messages.js';
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
  recentActivity: string[];
  missionControl?: MissionControlSnapshot;
}

function oneLine(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 15))} ...`;
}

function formatRun(run: AgentRunSummary): string {
  const elapsed =
    run.completedAt !== null
      ? `${Math.max(0, Math.round((run.completedAt - run.startedAt) / 1000))}s`
      : 'running';
  const prompt = `${run.estimatedPromptTokens} est tokens`;
  const error = run.error ? `; error: ${oneLine(run.error, 120)}` : '';
  return `${run.agentId}: ${run.status} (${elapsed}, ${prompt})${error}`;
}

function formatMessage(message: Message): string {
  return `${message.authorId}: ${oneLine(message.text, 180)}`;
}

export function buildTaskPromptContext(opts: {
  task: Task;
  recentMessages: Message[];
  recentRuns: AgentRunSummary[];
  missionControl?: MissionControlSnapshot;
}): TaskPromptContext {
  const recentActivity = [
    ...opts.recentRuns.slice(0, 5).map(formatRun),
    ...opts.recentMessages.slice(-5).map(formatMessage),
  ].slice(0, 10);

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
    recentActivity,
    ...(opts.missionControl ? { missionControl: opts.missionControl } : {}),
  };
}
