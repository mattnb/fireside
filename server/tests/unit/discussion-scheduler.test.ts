import { describe, expect, it } from 'vitest';
import type { AgentId } from '../../src/agents/types.js';
import {
  applyDiscussionRoundResults,
  createDiscussionScheduler,
  currentMaxRepliesPerAgent,
  planDiscussionRound,
  syncDiscussionTotalBudget,
} from '../../src/orchestration/discussion-scheduler.js';

function scheduler(input: {
  mode?: 'normal' | 'yolo';
  responders: AgentId[];
  roomAgents?: AgentId[];
  handoffPool?: AgentId[];
  maxRepliesPerAgent?: number;
  maxTotalReplies?: number;
}) {
  return createDiscussionScheduler({
    mode: input.mode ?? 'normal',
    responders: input.responders,
    roomAgents: input.roomAgents ?? input.responders,
    ...(input.handoffPool !== undefined ? { handoffPool: input.handoffPool } : {}),
    maxRepliesPerAgent: input.maxRepliesPerAgent ?? 1,
    ...(input.maxTotalReplies !== undefined ? { maxTotalReplies: input.maxTotalReplies } : {}),
  });
}

describe('discussion scheduler', () => {
  it('selects initial responders within per-agent and total budgets', () => {
    const state = scheduler({
      mode: 'yolo',
      responders: ['claude', 'codex', 'gemini'],
      handoffPool: ['claude', 'codex', 'gemini'],
      maxRepliesPerAgent: 100,
      maxTotalReplies: 2,
    });
    const plan = planDiscussionRound(state, { round: 1, laneAgents: [] });

    expect(plan.eligibleAgents).toEqual(['claude', 'codex']);
    expect(plan.remainingTotal).toBe(2);
    expect(currentMaxRepliesPerAgent(state)).toBe(2);
  });

  it('rotates a normal multi-agent thread away from the lone active speaker', () => {
    const state = scheduler({
      responders: ['claude', 'codex'],
      roomAgents: ['claude', 'codex'],
      maxRepliesPerAgent: 1,
    });

    const outcome = applyDiscussionRoundResults(state, {
      roomYoloAgents: [],
      results: [
        {
          agentId: 'claude',
          progressed: true,
          hasMessage: true,
          failed: false,
          handoffs: [],
          workDispatches: [],
          runId: 'run-1',
          error: '',
        },
      ],
    });

    expect(outcome.nextCandidates).toEqual(['codex']);
    expect(state.candidates).toEqual(['codex']);
  });

  it('routes hidden work dispatches as directed next-round candidates', () => {
    const state = scheduler({
      responders: ['codex-project-manager'],
      roomAgents: ['codex-project-manager', 'claude-technical-lead'],
      maxRepliesPerAgent: 1,
    });

    const outcome = applyDiscussionRoundResults(state, {
      roomYoloAgents: [],
      results: [
        {
          agentId: 'codex-project-manager',
          progressed: true,
          hasMessage: false,
          failed: false,
          handoffs: [],
          workDispatches: ['claude-technical-lead'],
          runId: 'run-1',
          error: '',
        },
      ],
    });

    expect(outcome.directedAgents).toEqual(['claude-technical-lead']);
    expect(outcome.nextCandidates).toEqual(['claude-technical-lead']);
  });

  it('splits directed YOLO handoffs out of normal next-round candidates', () => {
    const state = scheduler({
      responders: ['codex'],
      roomAgents: ['codex', 'claude'],
      maxRepliesPerAgent: 2,
    });

    const outcome = applyDiscussionRoundResults(state, {
      roomYoloAgents: ['claude'],
      results: [
        {
          agentId: 'codex',
          progressed: true,
          hasMessage: true,
          failed: false,
          handoffs: ['claude'],
          workDispatches: [],
          runId: 'run-1',
          error: '',
        },
      ],
    });

    expect(outcome.directedYoloAgents).toEqual(['claude']);
    expect(outcome.directedNormalAgents).toEqual([]);
    expect(outcome.nextCandidates).toEqual([]);
  });

  it('quarantines failed YOLO agents and keeps other agents eligible', () => {
    const state = scheduler({
      mode: 'yolo',
      responders: ['claude', 'codex'],
      roomAgents: ['claude', 'codex'],
      handoffPool: ['claude', 'codex'],
      maxRepliesPerAgent: 100,
      maxTotalReplies: 100,
    });

    const outcome = applyDiscussionRoundResults(state, {
      roomYoloAgents: ['claude', 'codex'],
      results: [
        {
          agentId: 'claude',
          progressed: false,
          hasMessage: false,
          failed: true,
          handoffs: [],
          workDispatches: [],
          runId: 'run-1',
          error: 'context exhausted',
        },
        {
          agentId: 'codex',
          progressed: true,
          hasMessage: true,
          failed: false,
          handoffs: [],
          workDispatches: [],
          runId: 'run-2',
          error: '',
        },
      ],
    });

    expect(outcome.failedYoloAgents).toMatchObject([
      { agentId: 'claude', runId: 'run-1' },
    ]);
    expect(state.quarantinedAgents.has('claude')).toBe(true);
    expect(outcome.nextCandidates).toEqual(['codex']);
  });

  it('does not reintroduce quarantined YOLO agents through directed work dispatches', () => {
    const state = scheduler({
      mode: 'yolo',
      responders: ['claude', 'codex'],
      roomAgents: ['claude', 'codex'],
      handoffPool: ['claude', 'codex'],
      maxRepliesPerAgent: 100,
      maxTotalReplies: 100,
    });

    const outcome = applyDiscussionRoundResults(state, {
      roomYoloAgents: ['claude', 'codex'],
      results: [
        {
          agentId: 'claude',
          progressed: false,
          hasMessage: false,
          failed: true,
          handoffs: [],
          workDispatches: [],
          runId: 'run-1',
          error: 'prompt too long',
        },
        {
          agentId: 'codex',
          progressed: true,
          hasMessage: true,
          failed: false,
          handoffs: [],
          workDispatches: ['claude'],
          runId: 'run-2',
          error: '',
        },
      ],
    });

    expect(state.quarantinedAgents.has('claude')).toBe(true);
    expect(outcome.directedAgents).toEqual(['claude']);
    expect(outcome.nextCandidates).toEqual(['codex']);
  });

  it('stops a YOLO thread after a no-progress pulse', () => {
    const state = scheduler({
      mode: 'yolo',
      responders: ['claude', 'codex'],
      roomAgents: ['claude', 'codex'],
      handoffPool: ['claude', 'codex'],
      maxRepliesPerAgent: 100,
      maxTotalReplies: 100,
    });

    const outcome = applyDiscussionRoundResults(state, {
      roomYoloAgents: ['claude', 'codex'],
      results: [
        {
          agentId: 'claude',
          progressed: false,
          hasMessage: false,
          failed: false,
          handoffs: [],
          workDispatches: [],
          runId: 'run-1',
          error: '',
        },
      ],
    });

    expect(outcome.shouldStop).toBe(true);
    expect(outcome.stopReason).toBe('idle:no-progress-round');
  });

  it('does not keep YOLO alive for visible status chatter without progress or handoff', () => {
    const state = scheduler({
      mode: 'yolo',
      responders: ['codex'],
      roomAgents: ['codex'],
      handoffPool: ['codex'],
      maxRepliesPerAgent: 100,
      maxTotalReplies: 100,
    });

    const outcome = applyDiscussionRoundResults(state, {
      roomYoloAgents: ['codex'],
      results: [
        {
          agentId: 'codex',
          progressed: false,
          hasMessage: true,
          failed: false,
          handoffs: [],
          workDispatches: [],
          runId: 'run-1',
          error: '',
        },
      ],
    });

    expect(outcome.shouldStop).toBe(true);
    expect(outcome.nextCandidates).toEqual([]);
    expect(state.totalReplies).toBe(0);
  });

  it('accepts a larger live YOLO budget between rounds', () => {
    const state = scheduler({
      mode: 'yolo',
      responders: ['claude'],
      roomAgents: ['claude'],
      handoffPool: ['claude'],
      maxRepliesPerAgent: 100,
      maxTotalReplies: 100,
    });

    syncDiscussionTotalBudget(state, 200);

    expect(state.maxTotalReplies).toBe(200);
    expect(currentMaxRepliesPerAgent(state)).toBe(200);
  });
});
