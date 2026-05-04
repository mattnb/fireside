import type { AgentId } from '../agents/types.js';
import type { RoutingRuleTrace } from '../routing/agent-references.js';

export type DiscussionMode = 'normal' | 'yolo';

export interface DiscussionSchedulerState {
  mode: DiscussionMode;
  handoffPool: AgentId[];
  uniqueResponders: AgentId[];
  openFloor: boolean;
  maxRepliesPerAgent: number;
  maxTotalReplies: number;
  totalReplies: number;
  allowedAgents: Set<AgentId>;
  replyCounts: Map<AgentId, number>;
  quarantinedAgents: Set<AgentId>;
  candidates: AgentId[];
}

export interface CreateDiscussionSchedulerInput {
  mode?: DiscussionMode | undefined;
  responders: AgentId[];
  roomAgents: AgentId[];
  handoffPool?: AgentId[] | undefined;
  preferResponderPool?: boolean | undefined;
  maxRepliesPerAgent: number;
  maxTotalReplies?: number | undefined;
  totalRepliesUsed?: number | undefined;
}

export interface DiscussionRoundPlan {
  round: number;
  eligibleAgents: AgentId[];
  remainingTotal: number;
  maxPromptRounds: number;
  maxRepliesPerAgent: number;
  maxTotalReplies: number;
  trace: RoutingRuleTrace[];
}

export interface DiscussionResultSummary {
  agentId: AgentId;
  progressed: boolean;
  hasMessage: boolean;
  failed: boolean;
  handoffs: AgentId[];
  workDispatches: AgentId[];
  runId: string;
  error: string;
}

export interface FailedYoloAgent {
  agentId: AgentId;
  runId: string;
  error: string;
}

export interface DiscussionRoundOutcome {
  activeAgents: AgentId[];
  directedAgents: AgentId[];
  directedYoloAgents: AgentId[];
  directedNormalAgents: AgentId[];
  failedYoloAgents: FailedYoloAgent[];
  nextCandidates: AgentId[];
  shouldStop: boolean;
  stopReason: string;
  trace: RoutingRuleTrace[];
}

function uniqueAgents(agents: AgentId[]): AgentId[] {
  return agents.filter((agent, index) => agents.indexOf(agent) === index);
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function createDiscussionScheduler(
  input: CreateDiscussionSchedulerInput,
): DiscussionSchedulerState {
  const mode = input.mode ?? 'normal';
  const roomAgents = input.roomAgents.length > 0 ? input.roomAgents : input.responders;
  const uniqueResponders = uniqueAgents(input.responders);
  const filteredHandoffPool =
    mode === 'yolo' && input.handoffPool
      ? uniqueAgents(input.handoffPool.filter((agent) => roomAgents.includes(agent)))
      : [];
  const handoffPool =
    mode === 'yolo'
      ? filteredHandoffPool.length > 0
        ? filteredHandoffPool
        : input.preferResponderPool
          ? uniqueResponders
          : roomAgents
      : roomAgents;
  const maxRepliesPerAgent = positiveInteger(input.maxRepliesPerAgent, 1);
  const maxTotalReplies = positiveInteger(
    input.maxTotalReplies ?? maxRepliesPerAgent * Math.max(1, handoffPool.length),
    Math.max(1, maxRepliesPerAgent * Math.max(1, handoffPool.length)),
  );
  const knownAgents = new Set<AgentId>([...handoffPool, ...uniqueResponders]);

  return {
    mode,
    handoffPool,
    uniqueResponders,
    openFloor: mode === 'yolo' || uniqueResponders.length > 1,
    maxRepliesPerAgent,
    maxTotalReplies,
    totalReplies: positiveInteger(input.totalRepliesUsed ?? 0, 0),
    allowedAgents: new Set(uniqueResponders),
    replyCounts: new Map(Array.from(knownAgents).map((id) => [id, 0])),
    quarantinedAgents: new Set(),
    candidates: [...uniqueResponders],
  };
}

export function syncDiscussionTotalBudget(
  state: DiscussionSchedulerState,
  maxTotalReplies: number,
): void {
  state.maxTotalReplies = Math.max(state.maxTotalReplies, positiveInteger(maxTotalReplies, 1));
}

export function currentMaxTotalReplies(state: DiscussionSchedulerState): number {
  return state.maxTotalReplies;
}

export function currentMaxRepliesPerAgent(state: DiscussionSchedulerState): number {
  return state.mode === 'yolo' ? state.maxTotalReplies : state.maxRepliesPerAgent;
}

export function currentMaxPromptRounds(state: DiscussionSchedulerState): number {
  return state.mode === 'yolo' || state.handoffPool.length > 1
    ? Math.max(1, Math.min(currentMaxRepliesPerAgent(state), currentMaxTotalReplies(state)))
    : 1;
}

export function planDiscussionRound(
  state: DiscussionSchedulerState,
  input: { round: number; laneAgents: AgentId[] },
): DiscussionRoundPlan {
  const maxReplies = currentMaxRepliesPerAgent(state);
  const maxTotal = currentMaxTotalReplies(state);
  const remainingTotal = Math.max(0, maxTotal - state.totalReplies);
  const candidateSet = new Set<AgentId>([...state.candidates, ...input.laneAgents]);
  const eligibleAgents = Array.from(candidateSet)
    .filter(
      (agentId) =>
        !state.quarantinedAgents.has(agentId) &&
        (state.replyCounts.get(agentId) ?? 0) < maxReplies,
    )
    .slice(0, remainingTotal);
  const trace: RoutingRuleTrace[] = [
    {
      id: 'discussion-round-candidates',
      result: eligibleAgents.length > 0 ? 'matched' : 'blocked',
      reason:
        eligibleAgents.length > 0
          ? `selected ${eligibleAgents.length} eligible agent(s) for round ${input.round}`
          : remainingTotal <= 0
            ? 'turn budget exhausted'
            : 'no candidates remain under per-agent limits',
      agents: eligibleAgents,
    },
  ];

  return {
    round: input.round,
    eligibleAgents,
    remainingTotal,
    maxPromptRounds: currentMaxPromptRounds(state),
    maxRepliesPerAgent: maxReplies,
    maxTotalReplies: maxTotal,
    trace,
  };
}

export function applyDiscussionRoundResults(
  state: DiscussionSchedulerState,
  input: {
    results: DiscussionResultSummary[];
    roomYoloAgents: AgentId[];
  },
): DiscussionRoundOutcome {
  const trace: RoutingRuleTrace[] = [];
  const activeAgents: AgentId[] = [];
  const directedAgents: AgentId[] = [];
  const failedYoloAgents: FailedYoloAgent[] = [];
  const handoffPool = new Set(state.handoffPool);

  for (const result of input.results) {
    if (result.failed && state.mode === 'yolo') {
      state.quarantinedAgents.add(result.agentId);
      failedYoloAgents.push({
        agentId: result.agentId,
        runId: result.runId,
        error: result.error,
      });
      trace.push({
        id: 'discussion-quarantine',
        result: 'blocked',
        reason: `${result.agentId} failed during YOLO and is paused for this session`,
        agents: [result.agentId],
      });
      continue;
    }
    if (!result.progressed && !result.hasMessage) {
      trace.push({
        id: 'discussion-no-progress',
        result: 'skipped',
        reason: `${result.agentId} produced no progress`,
        agents: [result.agentId],
      });
      continue;
    }
    activeAgents.push(result.agentId);
    state.replyCounts.set(result.agentId, (state.replyCounts.get(result.agentId) ?? 0) + 1);
    state.totalReplies += 1;

    const directed = [...result.handoffs, ...result.workDispatches].filter((agentId) =>
      handoffPool.has(agentId),
    );
    for (const agentId of directed) {
      state.allowedAgents.add(agentId);
      if (!directedAgents.includes(agentId)) directedAgents.push(agentId);
    }
  }

  if (activeAgents.length === 0) {
    state.candidates = [];
    return {
      activeAgents,
      directedAgents,
      directedYoloAgents: [],
      directedNormalAgents: [],
      failedYoloAgents,
      nextCandidates: [],
      shouldStop: true,
      stopReason: state.mode === 'yolo' ? 'idle:no-progress-round' : 'idle:no-progress-round',
      trace: [
        ...trace,
        {
          id: 'discussion-stop',
          result: 'blocked',
          reason: 'no agent produced progress this round',
        },
      ],
    };
  }

  const maxReplies = currentMaxRepliesPerAgent(state);
  const underLimit = Array.from(state.allowedAgents).filter(
    (agentId) =>
      !state.quarantinedAgents.has(agentId) &&
      (state.replyCounts.get(agentId) ?? 0) < maxReplies,
  );
  const directedUnderLimit = directedAgents.filter(
    (agentId) =>
      !state.quarantinedAgents.has(agentId) &&
      (state.replyCounts.get(agentId) ?? 0) < maxReplies,
  );
  const directedYoloAgents =
    state.mode === 'yolo'
      ? []
      : directedUnderLimit.filter((agentId) => input.roomYoloAgents.includes(agentId));
  const directedNormalAgents =
    directedYoloAgents.length > 0
      ? directedUnderLimit.filter((agentId) => !directedYoloAgents.includes(agentId))
      : directedUnderLimit;

  let nextCandidates: AgentId[];
  if (directedUnderLimit.length > 0) {
    nextCandidates = directedNormalAgents;
  } else if (!state.openFloor) {
    nextCandidates = [];
  } else {
    nextCandidates =
      state.mode !== 'yolo' && activeAgents.length === 1
        ? underLimit.filter((agentId) => agentId !== activeAgents[0])
        : underLimit;
  }
  state.candidates = nextCandidates;

  trace.push({
    id: 'discussion-next-candidates',
    result: nextCandidates.length > 0 ? 'matched' : 'skipped',
    reason:
      nextCandidates.length > 0
        ? `next round has ${nextCandidates.length} candidate(s)`
        : 'no normal next-round candidates remain',
    agents: nextCandidates,
  });

  return {
    activeAgents,
    directedAgents,
    directedYoloAgents,
    directedNormalAgents,
    failedYoloAgents,
    nextCandidates,
    shouldStop: false,
    stopReason: '',
    trace,
  };
}
