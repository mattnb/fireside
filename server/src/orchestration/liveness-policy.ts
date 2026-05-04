import type { AgentId } from '../agents/types.js';
import type { AgentJob } from '../repos/agent-jobs.js';
import type { TaskChecklistItem } from '../repos/task-checklist.js';
import type { Task } from '../repos/tasks.js';
import type { AgentTurnOutcome } from '../repos/turn-outcomes.js';
import {
  routeMissionWorkUpdates,
  type MissionWorkDispatch,
} from '../routing/mission-work-router.js';
import type { RoutingRuleTrace } from '../routing/agent-references.js';

export type MissionLivenessAction =
  | 'idle'
  | 'dispatch-ready-work'
  | 'wait-for-agent'
  | 'wait-for-human'
  | 'needs-assignment'
  | 'mission-complete';

export interface MissionLivenessDecision {
  action: MissionLivenessAction;
  reason: string;
  dispatches: MissionWorkDispatch[];
  trace: RoutingRuleTrace[];
  latestOutcome: AgentTurnOutcome | null;
}

export interface EvaluateMissionLivenessInput {
  task: Task | null;
  items: TaskChecklistItem[];
  roomAgents: AgentId[];
  activeJobs: AgentJob[];
  suppressAgents?: Set<AgentId>;
  recentOutcomes?: AgentTurnOutcome[];
}

export function evaluateMissionLiveness(
  input: EvaluateMissionLivenessInput,
): MissionLivenessDecision {
  const trace: RoutingRuleTrace[] = [];
  const latestOutcome = input.recentOutcomes?.[0] ?? null;
  if (!input.task) {
    return decision('idle', 'no active mission', [], trace, latestOutcome);
  }

  const activeJobs = input.activeJobs.filter((job) => job.taskId === input.task!.id);
  const activeItemIds = new Set(
    activeJobs.map((job) => job.checklistItemId).filter((id): id is string => Boolean(id)),
  );
  const busyAgents = new Set(activeJobs.map((job) => job.agentId));
  const openItems = input.items.filter((item) => item.status === 'open');
  const blockedCouncilItems = input.items.filter(
    (item) => item.status === 'blocked' && item.councilRequired,
  );

  if (blockedCouncilItems.length > 0 && openItems.length === 0 && activeJobs.length === 0) {
    trace.push({
      id: 'liveness-human-blocker',
      result: 'blocked',
      reason: `${blockedCouncilItems.length} council-required blocked item(s) need human/team decision`,
      agents: blockedCouncilItems.map((item) => item.ownerAgentId).filter(Boolean),
    });
    return decision(
      'wait-for-human',
      'mission is blocked on council-required checklist items',
      [],
      trace,
      latestOutcome,
    );
  }

  if (openItems.length === 0) {
    const reason =
      activeJobs.length > 0
        ? 'no open unassigned work, but provider jobs are still active'
        : 'no open checklist work remains';
    return decision(
      activeJobs.length > 0 ? 'wait-for-agent' : 'mission-complete',
      reason,
      [],
      trace,
      latestOutcome,
    );
  }

  const routableItems = openItems.filter((item) => item.ownerAgentId);
  if (routableItems.length === 0) {
    trace.push({
      id: 'liveness-owner',
      result: 'blocked',
      reason: `${openItems.length} open item(s) have no owner`,
    });
    return decision(
      'needs-assignment',
      'open checklist work exists but no owner can be nudged',
      [],
      trace,
      latestOutcome,
    );
  }

  const routed = routeMissionWorkUpdates({
    changedItems: routableItems,
    allItems: input.items,
    roomAgents: input.roomAgents,
    authorId: 'fireside',
    busyAgents,
    activeItemIds,
  });
  trace.push(...routed.trace);
  const dispatches = dedupeLivenessDispatches(routed.dispatches, input.suppressAgents, trace);
  if (dispatches.length > 0) {
    return decision(
      'dispatch-ready-work',
      `${dispatches.length} ready owned agent(s) can be nudged`,
      dispatches,
      trace,
      latestOutcome,
    );
  }

  const allOwnedOpenItemsBusyOrActive = routableItems.every(
    (item) => busyAgents.has(item.ownerAgentId) || activeItemIds.has(item.id),
  );
  if (activeJobs.length > 0 || allOwnedOpenItemsBusyOrActive) {
    return decision(
      'wait-for-agent',
      'owned open checklist work is already attached to active or busy agents',
      [],
      trace,
      latestOutcome,
    );
  }

  return decision(
    'wait-for-agent',
    'open checklist work is not currently dispatchable; dependency or room-membership rule blocked it',
    [],
    trace,
    latestOutcome,
  );
}

function dedupeLivenessDispatches(
  dispatches: MissionWorkDispatch[],
  suppressAgents: Set<AgentId> | undefined,
  trace: RoutingRuleTrace[],
): MissionWorkDispatch[] {
  const selected: MissionWorkDispatch[] = [];
  const seenAgents = new Set<AgentId>();
  for (const dispatch of dispatches) {
    if (suppressAgents?.has(dispatch.agentId)) {
      trace.push({
        id: 'liveness-suppress-current-agent',
        result: 'skipped',
        reason: `${dispatch.agentId} just completed a turn; not immediately re-dispatching the same agent`,
        agents: [dispatch.agentId],
      });
      continue;
    }
    if (seenAgents.has(dispatch.agentId)) {
      trace.push({
        id: 'liveness-dedupe-agent',
        result: 'skipped',
        reason: `${dispatch.agentId} already has a ready liveness dispatch`,
        agents: [dispatch.agentId],
      });
      continue;
    }
    seenAgents.add(dispatch.agentId);
    selected.push(dispatch);
  }
  return selected;
}

function decision(
  action: MissionLivenessAction,
  reason: string,
  dispatches: MissionWorkDispatch[],
  trace: RoutingRuleTrace[],
  latestOutcome: AgentTurnOutcome | null,
): MissionLivenessDecision {
  return { action, reason, dispatches, trace, latestOutcome };
}
