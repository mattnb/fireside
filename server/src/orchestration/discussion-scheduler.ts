import type { AgentId } from '../agents/types.js';
import type { RoutingRuleTrace } from '../routing/agent-references.js';

export type DiscussionMode = 'normal' | 'yolo';

export interface DiscussionSchedulerState {
  mode: DiscussionMode;
  handoffPool: AgentId[];
  uniqueResponders: AgentId[];
  openFloor: boolean;
  leadAgentId: AgentId | null;
  maxRepliesPerAgent: number;
  maxTotalReplies: number;
  totalReplies: number;
  allowedAgents: Set<AgentId>;
  replyCounts: Map<AgentId, number>;
  quarantinedAgents: Set<AgentId>;
  opportunisticQuarantinedAgents: Set<AgentId>;
  noProgressStreaks: Map<AgentId, number>;
  candidateSource: 'initial' | 'directed' | 'open-floor';
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
  leadAgentId?: AgentId | null | undefined;
  opportunisticQuarantinedAgents?: AgentId[] | undefined;
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
  const leadAgentId =
    input.leadAgentId && handoffPool.includes(input.leadAgentId) ? input.leadAgentId : null;

  return {
    mode,
    handoffPool,
    uniqueResponders,
    openFloor: mode === 'yolo' || uniqueResponders.length > 1,
    leadAgentId,
    maxRepliesPerAgent,
    maxTotalReplies,
    totalReplies: positiveInteger(input.totalRepliesUsed ?? 0, 0),
    allowedAgents: new Set(uniqueResponders),
    replyCounts: new Map(Array.from(knownAgents).map((id) => [id, 0])),
    quarantinedAgents: new Set(),
    opportunisticQuarantinedAgents: new Set(input.opportunisticQuarantinedAgents ?? []),
    noProgressStreaks: new Map(),
    candidateSource: 'initial',
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
  const laneAgentSet = new Set(input.laneAgents);
  const directedCandidateSource = state.candidateSource === 'directed';
  const opportunisticPulse = state.mode === 'yolo' && !directedCandidateSource;
  const leadRoutingPulse = opportunisticPulse && laneAgentSet.size === 0;
  const candidateSet = new Set<AgentId>();
  if (directedCandidateSource || state.mode !== 'yolo') {
    for (const agentId of state.candidates) candidateSet.add(agentId);
  } else if (leadRoutingPulse && state.leadAgentId) {
    candidateSet.add(state.leadAgentId);
  } else if (opportunisticPulse && !state.leadAgentId) {
    for (const agentId of state.candidates) candidateSet.add(agentId);
  }
  for (const agentId of input.laneAgents) candidateSet.add(agentId);
  const eligibleAgents = Array.from(candidateSet)
    .filter(
      (agentId) =>
        !state.quarantinedAgents.has(agentId) &&
        (!leadRoutingPulse || !state.opportunisticQuarantinedAgents.has(agentId)) &&
        (state.replyCounts.get(agentId) ?? 0) < maxReplies,
    )
    .slice(0, remainingTotal);
  const trace: RoutingRuleTrace[] = [];
  if (opportunisticPulse) {
    const suppressedAgents = state.handoffPool.filter(
      (agentId) =>
        !eligibleAgents.includes(agentId) &&
        (state.candidates.includes(agentId) ||
          input.laneAgents.includes(agentId) ||
          agentId === state.leadAgentId) &&
        !laneAgentSet.has(agentId) &&
        (state.opportunisticQuarantinedAgents.has(agentId) ||
          !leadRoutingPulse ||
          agentId !== state.leadAgentId),
    );
    trace.push({
      id: 'discussion-opportunistic-suppression',
      result: suppressedAgents.length > 0 ? 'matched' : 'skipped',
      reason: state.leadAgentId
        ? 'YOLO pulse has no lane, handoff, or queued dispatch; routing only to unquarantined lead'
        : 'YOLO pulse has no lane, handoff, queued dispatch, or lead-routing target',
      agents: suppressedAgents,
    });
  }
  trace.push({
    id: 'discussion-round-candidates',
    result: eligibleAgents.length > 0 ? 'matched' : 'blocked',
    reason:
      eligibleAgents.length > 0
        ? `selected ${eligibleAgents.length} eligible agent(s) for round ${input.round}`
        : remainingTotal <= 0
          ? 'turn budget exhausted'
          : 'no candidates remain under per-agent limits',
    agents: eligibleAgents,
  });

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
    const directed = [...result.handoffs, ...result.workDispatches].filter((agentId) =>
      handoffPool.has(agentId),
    );
    const noVisibleNoProgress =
      !result.progressed && !result.hasMessage && !result.failed && directed.length === 0;
    if (noVisibleNoProgress) {
      const streak = (state.noProgressStreaks.get(result.agentId) ?? 0) + 1;
      state.noProgressStreaks.set(result.agentId, streak);
      if (state.mode === 'yolo' && streak >= 2) {
        state.opportunisticQuarantinedAgents.add(result.agentId);
        trace.push({
          id: 'discussion-no-op-quarantine',
          result: 'blocked',
          reason: `${result.agentId} produced ${streak} consecutive no-message/no-progress turns and is paused for opportunistic pulses`,
          agents: [result.agentId],
        });
      }
    } else {
      state.noProgressStreaks.set(result.agentId, 0);
    }
    if (!result.progressed && directed.length === 0) {
      trace.push({
        id: 'discussion-no-progress',
        result: 'skipped',
        reason: result.hasMessage
          ? `${result.agentId} produced a message but no mission progress or handoff`
          : `${result.agentId} produced no progress`,
        agents: [result.agentId],
      });
      continue;
    }
    activeAgents.push(result.agentId);
    state.replyCounts.set(result.agentId, (state.replyCounts.get(result.agentId) ?? 0) + 1);
    state.totalReplies += 1;

    for (const agentId of directed) {
      state.allowedAgents.add(agentId);
      if (!directedAgents.includes(agentId)) directedAgents.push(agentId);
    }
  }

  if (activeAgents.length === 0) {
    state.candidates = [];
    state.candidateSource = 'open-floor';
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
      !state.quarantinedAgents.has(agentId) && (state.replyCounts.get(agentId) ?? 0) < maxReplies,
  );
  const directedUnderLimit = directedAgents.filter(
    (agentId) =>
      !state.quarantinedAgents.has(agentId) && (state.replyCounts.get(agentId) ?? 0) < maxReplies,
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
    state.candidateSource = 'directed';
  } else if (!state.openFloor) {
    nextCandidates = [];
    state.candidateSource = 'open-floor';
  } else {
    nextCandidates =
      state.mode !== 'yolo' && activeAgents.length === 1
        ? underLimit.filter((agentId) => agentId !== activeAgents[0])
        : underLimit;
    state.candidateSource = 'open-floor';
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
