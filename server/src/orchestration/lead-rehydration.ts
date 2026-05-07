import type { Database } from 'better-sqlite3';
import type { AgentId } from '../agents/types.js';
import { listCollaborationItems } from '../repos/collaboration.js';
import { getActiveTask } from '../repos/tasks.js';
import { listTaskPhases } from '../repos/task-phases.js';
import { listTaskPlans } from '../repos/task-plans.js';
import { listTaskChecklistItems } from '../repos/task-checklist.js';
import { listAgentTurnOutcomesForRoom } from '../repos/turn-outcomes.js';

export interface LeadRehydrationChecklistEntry {
  id: string;
  title: string;
  status: string;
  ownerAgentId: string;
  blockedReason?: string;
}

export interface LeadRehydrationCouncilEntry {
  id: string;
  kind: string;
  status: string;
  title: string;
  body: string;
  agentId: AgentId;
}

export interface LeadRehydrationWorkerOutcome {
  agentId: AgentId;
  runId: string;
  status: string;
  runKind: string;
  summary: string;
  at: number;
}

export interface LeadRehydrationCheckpoint {
  missionGoal: string;
  missionTitle: string;
  currentPhaseTitle: string | null;
  currentPhaseId: string | null;
  planExcerpt: string;
  openChecklist: LeadRehydrationChecklistEntry[];
  recentlyResolvedChecklist: LeadRehydrationChecklistEntry[];
  blockers: LeadRehydrationChecklistEntry[];
  recentCouncilDecisions: LeadRehydrationCouncilEntry[];
  recentWorkerOutcomes: LeadRehydrationWorkerOutcome[];
}

const DEFAULT_PLAN_EXCERPT_CHARS = 1_500;
const DEFAULT_RESOLVED_LIMIT = 5;
const DEFAULT_COUNCIL_LIMIT = 5;
const DEFAULT_WORKER_OUTCOMES_LIMIT = 6;
const DEFAULT_BLOCK_BUDGET_CHARS = 16_000; // ~4k tokens at 4 chars/token

export function buildLeadRehydrationCheckpoint(
  db: Database,
  roomId: string,
  leadAgentId: AgentId | null = null,
): LeadRehydrationCheckpoint {
  const task = getActiveTask(db, roomId);
  const taskId = task?.id ?? null;
  const phases = taskId ? listTaskPhases(db, taskId) : [];
  const activePhase =
    phases.find((phase) => phase.status === 'active') ??
    phases.find((phase) => phase.status === 'blocked') ??
    null;
  const plans = taskId ? listTaskPlans(db, taskId) : [];
  const activePlan =
    plans.find((plan) => plan.status === 'active') ?? plans.find((plan) => plan.status === 'draft');
  const planExcerpt = activePlan
    ? activePlan.body.slice(0, DEFAULT_PLAN_EXCERPT_CHARS)
    : '';

  const checklistItems = taskId ? listTaskChecklistItems(db, taskId) : [];
  const openChecklist = checklistItems
    .filter((item) => item.status === 'open')
    .map((item): LeadRehydrationChecklistEntry => ({
      id: item.id,
      title: item.title,
      status: item.status,
      ownerAgentId: item.ownerAgentId,
    }));
  const blockers = checklistItems
    .filter((item) => item.status === 'blocked')
    .map((item): LeadRehydrationChecklistEntry => ({
      id: item.id,
      title: item.title,
      status: item.status,
      ownerAgentId: item.ownerAgentId,
      blockedReason: item.blockedReason || item.statusNote || '',
    }));
  const recentlyResolvedChecklist = checklistItems
    .filter((item) => item.status === 'done' || item.status === 'skipped')
    .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
    .slice(0, DEFAULT_RESOLVED_LIMIT)
    .map((item): LeadRehydrationChecklistEntry => ({
      id: item.id,
      title: item.title,
      status: item.status,
      ownerAgentId: item.ownerAgentId,
    }));

  const collaborationItems = listCollaborationItems(db, roomId, {
    limit: DEFAULT_COUNCIL_LIMIT * 4,
    ...(taskId ? { taskId } : {}),
  });
  const recentCouncilDecisions = collaborationItems
    .filter(
      (item) =>
        item.kind === 'decision' ||
        item.status === 'accepted' ||
        item.status === 'resolved' ||
        item.status === 'rejected',
    )
    .slice(0, DEFAULT_COUNCIL_LIMIT)
    .map((item): LeadRehydrationCouncilEntry => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      title: item.title,
      body: item.body,
      agentId: item.agentId,
    }));

  const outcomes = listAgentTurnOutcomesForRoom(db, roomId, 50);
  const recentWorkerOutcomes = outcomes
    .filter((outcome) => leadAgentId === null || outcome.agentId !== leadAgentId)
    .slice(0, DEFAULT_WORKER_OUTCOMES_LIMIT)
    .map((outcome): LeadRehydrationWorkerOutcome => ({
      agentId: outcome.agentId,
      runId: outcome.runId,
      status: outcome.status,
      runKind: outcome.runKind ?? 'normal.turn',
      summary: outcome.summary,
      at: outcome.createdAt,
    }));

  return {
    missionGoal: task?.title ?? '',
    missionTitle: task?.title ?? '',
    currentPhaseTitle: activePhase?.title ?? null,
    currentPhaseId: activePhase?.id ?? null,
    planExcerpt,
    openChecklist,
    recentlyResolvedChecklist,
    blockers,
    recentCouncilDecisions,
    recentWorkerOutcomes,
  };
}

function bullet(text: string): string {
  return `- ${text.replace(/\s+/g, ' ').trim()}`;
}

export function renderLeadRehydrationBlock(
  checkpoint: LeadRehydrationCheckpoint,
  options: { budgetChars?: number } = {},
): string {
  const budget = options.budgetChars ?? DEFAULT_BLOCK_BUDGET_CHARS;
  const sections: string[] = [];

  sections.push(`/lead-rehydration`);
  sections.push(
    `Reason: your CLI session was deterministically reset to drop accumulated provider amplifier. Below is the durable Mission Control state assembled from existing artifacts. No new lossy summarization; everything here is sourced from the canonical store.`,
  );
  sections.push(``);

  if (checkpoint.missionTitle) sections.push(`Mission: ${checkpoint.missionTitle}`);
  if (checkpoint.currentPhaseTitle) {
    sections.push(`Current phase: ${checkpoint.currentPhaseTitle}`);
  }
  sections.push(``);

  if (checkpoint.planExcerpt) {
    sections.push(`Plan excerpt:`);
    sections.push(checkpoint.planExcerpt);
    sections.push(``);
  }

  if (checkpoint.blockers.length > 0) {
    sections.push(`Blockers (${checkpoint.blockers.length}):`);
    for (const item of checkpoint.blockers) {
      sections.push(
        bullet(
          `[${item.id}] ${item.title}${item.blockedReason ? ` — ${item.blockedReason}` : ''}`,
        ),
      );
    }
    sections.push(``);
  }

  if (checkpoint.openChecklist.length > 0) {
    sections.push(`Open checklist (${checkpoint.openChecklist.length}):`);
    for (const item of checkpoint.openChecklist) {
      sections.push(
        bullet(
          `[${item.id}] ${item.title}${item.ownerAgentId ? ` (owner: ${item.ownerAgentId})` : ''}`,
        ),
      );
    }
    sections.push(``);
  }

  if (checkpoint.recentlyResolvedChecklist.length > 0) {
    sections.push(`Recently resolved (${checkpoint.recentlyResolvedChecklist.length}):`);
    for (const item of checkpoint.recentlyResolvedChecklist) {
      sections.push(bullet(`[${item.id}] ${item.title} (${item.status})`));
    }
    sections.push(``);
  }

  if (checkpoint.recentCouncilDecisions.length > 0) {
    sections.push(`Recent council decisions (${checkpoint.recentCouncilDecisions.length}):`);
    for (const item of checkpoint.recentCouncilDecisions) {
      sections.push(
        bullet(
          `[${item.kind}/${item.status}] ${item.title}${item.body ? ` — ${item.body}` : ''}`,
        ),
      );
    }
    sections.push(``);
  }

  if (checkpoint.recentWorkerOutcomes.length > 0) {
    sections.push(`Recent worker outcomes (${checkpoint.recentWorkerOutcomes.length}):`);
    for (const outcome of checkpoint.recentWorkerOutcomes) {
      sections.push(
        bullet(
          `${outcome.agentId} run=${outcome.runId} status=${outcome.status} kind=${outcome.runKind} — ${outcome.summary}`,
        ),
      );
    }
    sections.push(``);
  }

  sections.push(`/end-lead-rehydration`);
  return enforceBudget(sections, budget);
}

function enforceBudget(sections: string[], budget: number): string {
  let text = sections.join('\n');
  if (text.length <= budget) return text;
  // Truncation drops oldest worker outcomes first, then oldest council decisions,
  // then plan excerpt tail. Implemented as a coarse line-from-end shrink because
  // the rendered block already orders sections from most-to-least essential.
  const lines = text.split('\n');
  while (text.length > budget && lines.length > 0) {
    // Skip the trailing /end-lead-rehydration marker so the block stays well-formed.
    const dropIdx = lines.length - 2;
    if (dropIdx <= 0) break;
    lines.splice(dropIdx, 1);
    text = lines.join('\n');
  }
  if (text.length > budget) {
    text = text.slice(0, budget - 32) + '\n... [truncated]\n/end-lead-rehydration';
  }
  return text;
}
