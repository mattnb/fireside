import type { AgentRunStatus } from './repos/agent-runs.js';

export const RUN_LIFECYCLE_ACTIVE_STATES = [
  'preparing_workspace',
  'building_prompt',
  'launching_agent_process',
  'initializing_session',
  'streaming_turn',
  'finishing',
] as const;

export const RUN_LIFECYCLE_OUTCOME_STATES = [
  'succeeded',
  'failed',
  'timed_out',
  'stalled',
  'canceled_by_reconciliation',
  'canceled_by_user',
] as const;

export const RUN_LIFECYCLE_DISPOSITION_STATES = ['retry_queued', 'released'] as const;

export type RunLifecycleStartState = 'start';
export type RunLifecycleActiveState = (typeof RUN_LIFECYCLE_ACTIVE_STATES)[number];
export type RunLifecycleOutcomeState = (typeof RUN_LIFECYCLE_OUTCOME_STATES)[number];
export type RunLifecycleDispositionState = (typeof RUN_LIFECYCLE_DISPOSITION_STATES)[number];
export type RunLifecycleState =
  | RunLifecycleStartState
  | RunLifecycleActiveState
  | RunLifecycleOutcomeState
  | RunLifecycleDispositionState;

export type RunLifecycleReason =
  | 'run_started'
  | 'workspace_prepared'
  | 'prompt_built'
  | 'agent_process_launched'
  | 'session_initialized'
  | 'turn_streaming'
  | 'turn_finished'
  | 'run_succeeded'
  | 'run_failed'
  | 'run_timed_out'
  | 'run_stalled'
  | 'reconciliation_canceled'
  | 'user_canceled'
  | 'retry_scheduled'
  | 'retry_already_queued'
  | 'retry_limit_reached'
  | 'retry_not_applicable'
  | 'active_mission_continues'
  | 'active_mission_retry'
  | 'mission_not_active'
  | 'mission_waiting_for_human'
  | 'run_in_progress'
  | 'released';

export interface RunLifecycle {
  state: RunLifecycleState;
  outcome: RunLifecycleOutcomeState | null;
  attempt: number;
  startedAt: number;
  enteredAt: number;
  lastSignalAt: number | null;
  reason: RunLifecycleReason;
  error?: string;
}

export interface StartRunLifecycleInput {
  now?: number;
  attempt?: number;
  reason?: RunLifecycleReason;
}

export interface TransitionRunLifecycleInput {
  now?: number;
  reason?: RunLifecycleReason;
  signalAt?: number;
  error?: string;
}

export interface RunLifecycleTransitionValidation {
  ok: boolean;
  from: RunLifecycleState;
  to: RunLifecycleState;
  allowed: readonly RunLifecycleState[];
  message: string;
}

export interface RunLifecycleStallOptions {
  now?: number;
  stallAfterMs?: number;
}

export interface RunLifecycleStallDetection {
  stalled: boolean;
  state: RunLifecycleState;
  referenceAt: number;
  silenceMs: number;
  thresholdMs: number;
  reason: RunLifecycleReason | null;
}

export interface RetryBackoffInput {
  attempt: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
}

export interface RunRetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
}

export interface RunRetryDecision {
  shouldRetry: boolean;
  nextState: RunLifecycleDispositionState;
  reason: RunLifecycleReason;
  delayMs: number;
  nextAttempt: number | null;
  attemptsRemaining: number;
}

export type ActiveMissionStatus = 'active' | 'blocked' | 'verifying' | 'paused' | 'done';

export interface ActiveMissionState {
  status: ActiveMissionStatus;
  hasOpenWork?: boolean;
  waitingForHuman?: boolean;
}

export type RunContinuationAction = 'wait' | 'continue' | 'retry' | 'release';

export interface RunContinuationDecision {
  action: RunContinuationAction;
  shouldContinue: boolean;
  shouldRetry: boolean;
  nextState: RunLifecycleDispositionState | null;
  reason: RunLifecycleReason;
  delayMs: number;
  nextAttempt: number | null;
}

export const DEFAULT_STALL_AFTER_MS = 2 * 60_000;
export const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
export const DEFAULT_RETRY_MULTIPLIER = 2;

const FAILURE_OUTCOME_STATES = ['failed', 'timed_out', 'stalled'] as const;

const ACTIVE_STATE_SET = new Set<RunLifecycleState>(RUN_LIFECYCLE_ACTIVE_STATES);
const OUTCOME_STATE_SET = new Set<RunLifecycleState>(RUN_LIFECYCLE_OUTCOME_STATES);
const DISPOSITION_STATE_SET = new Set<RunLifecycleState>(RUN_LIFECYCLE_DISPOSITION_STATES);
const FAILURE_OUTCOME_STATE_SET = new Set<RunLifecycleState>(FAILURE_OUTCOME_STATES);

export const RUN_LIFECYCLE_TRANSITIONS = {
  start: ['preparing_workspace', 'canceled_by_reconciliation', 'canceled_by_user'],
  preparing_workspace: [
    'building_prompt',
    'failed',
    'timed_out',
    'stalled',
    'canceled_by_reconciliation',
    'canceled_by_user',
  ],
  building_prompt: [
    'launching_agent_process',
    'failed',
    'timed_out',
    'stalled',
    'canceled_by_reconciliation',
    'canceled_by_user',
  ],
  launching_agent_process: [
    'initializing_session',
    'streaming_turn',
    'failed',
    'timed_out',
    'stalled',
    'canceled_by_reconciliation',
    'canceled_by_user',
  ],
  initializing_session: [
    'streaming_turn',
    'failed',
    'timed_out',
    'stalled',
    'canceled_by_reconciliation',
    'canceled_by_user',
  ],
  streaming_turn: [
    'finishing',
    'succeeded',
    'failed',
    'timed_out',
    'stalled',
    'canceled_by_reconciliation',
    'canceled_by_user',
  ],
  finishing: [
    'succeeded',
    'failed',
    'timed_out',
    'stalled',
    'canceled_by_reconciliation',
    'canceled_by_user',
  ],
  succeeded: ['released'],
  failed: ['retry_queued', 'released'],
  timed_out: ['retry_queued', 'released'],
  stalled: ['retry_queued', 'released'],
  canceled_by_reconciliation: ['released'],
  canceled_by_user: ['released'],
  retry_queued: [],
  released: [],
} satisfies Record<RunLifecycleState, readonly RunLifecycleState[]>;

const NEXT_RUN_LIFECYCLE_STEP: Partial<Record<RunLifecycleState, RunLifecycleState>> = {
  start: 'preparing_workspace',
  preparing_workspace: 'building_prompt',
  building_prompt: 'launching_agent_process',
  launching_agent_process: 'initializing_session',
  initializing_session: 'streaming_turn',
  streaming_turn: 'finishing',
  finishing: 'succeeded',
} satisfies Partial<Record<RunLifecycleState, RunLifecycleState>>;

const DEFAULT_REASON_BY_STATE = {
  start: 'run_started',
  preparing_workspace: 'run_started',
  building_prompt: 'workspace_prepared',
  launching_agent_process: 'prompt_built',
  initializing_session: 'agent_process_launched',
  streaming_turn: 'turn_streaming',
  finishing: 'turn_finished',
  succeeded: 'run_succeeded',
  failed: 'run_failed',
  timed_out: 'run_timed_out',
  stalled: 'run_stalled',
  canceled_by_reconciliation: 'reconciliation_canceled',
  canceled_by_user: 'user_canceled',
  retry_queued: 'retry_scheduled',
  released: 'released',
} satisfies Record<RunLifecycleState, RunLifecycleReason>;

export class RunLifecycleTransitionError extends Error {
  readonly from: RunLifecycleState;
  readonly to: RunLifecycleState;
  readonly allowed: readonly RunLifecycleState[];

  constructor(validation: RunLifecycleTransitionValidation) {
    super(validation.message);
    this.name = 'RunLifecycleTransitionError';
    this.from = validation.from;
    this.to = validation.to;
    this.allowed = validation.allowed;
  }
}

export function startRunLifecycle(input: StartRunLifecycleInput = {}): RunLifecycle {
  const now = input.now ?? Date.now();
  return {
    state: 'start',
    outcome: null,
    attempt: normalizeAttempt(input.attempt ?? 1),
    startedAt: now,
    enteredAt: now,
    lastSignalAt: null,
    reason: input.reason ?? 'run_started',
  };
}

export function isRunLifecycleActiveState(
  state: RunLifecycleState,
): state is RunLifecycleActiveState {
  return ACTIVE_STATE_SET.has(state);
}

export function isRunLifecycleOutcomeState(
  state: RunLifecycleState,
): state is RunLifecycleOutcomeState {
  return OUTCOME_STATE_SET.has(state);
}

export function isRunLifecycleDispositionState(
  state: RunLifecycleState,
): state is RunLifecycleDispositionState {
  return DISPOSITION_STATE_SET.has(state);
}

export function isRunLifecycleTerminalState(
  state: RunLifecycleState,
): state is RunLifecycleOutcomeState | RunLifecycleDispositionState {
  return isRunLifecycleOutcomeState(state) || isRunLifecycleDispositionState(state);
}

export function isRetryableRunLifecycleState(
  state: RunLifecycleState,
): state is (typeof FAILURE_OUTCOME_STATES)[number] {
  return FAILURE_OUTCOME_STATE_SET.has(state);
}

export function getAllowedNextRunLifecycleStates(
  state: RunLifecycleState,
): readonly RunLifecycleState[] {
  return RUN_LIFECYCLE_TRANSITIONS[state];
}

export function canTransitionRunLifecycle(from: RunLifecycleState, to: RunLifecycleState): boolean {
  return getAllowedNextRunLifecycleStates(from).includes(to);
}

export function validateRunLifecycleTransition(
  from: RunLifecycleState,
  to: RunLifecycleState,
): RunLifecycleTransitionValidation {
  const allowed = getAllowedNextRunLifecycleStates(from);
  if (allowed.includes(to)) {
    return {
      ok: true,
      from,
      to,
      allowed,
      message: `Run lifecycle can transition from ${from} to ${to}.`,
    };
  }
  const allowedText = allowed.length > 0 ? allowed.join(', ') : 'none';
  return {
    ok: false,
    from,
    to,
    allowed,
    message: `Illegal run lifecycle transition from ${from} to ${to}. Allowed next states: ${allowedText}.`,
  };
}

export function nextRunLifecycleStep(state: RunLifecycleState): RunLifecycleState | null {
  return NEXT_RUN_LIFECYCLE_STEP[state] ?? null;
}

export function advanceRunLifecycle(
  lifecycle: RunLifecycle,
  input: TransitionRunLifecycleInput = {},
): RunLifecycle {
  const nextState = nextRunLifecycleStep(lifecycle.state);
  if (!nextState) {
    throw new RunLifecycleTransitionError(
      validateRunLifecycleTransition(lifecycle.state, lifecycle.state),
    );
  }
  return transitionRunLifecycle(lifecycle, nextState, input);
}

export function transitionRunLifecycle(
  lifecycle: RunLifecycle,
  nextState: RunLifecycleState,
  input: TransitionRunLifecycleInput = {},
): RunLifecycle {
  const validation = validateRunLifecycleTransition(lifecycle.state, nextState);
  if (!validation.ok) {
    throw new RunLifecycleTransitionError(validation);
  }

  const now = input.now ?? Date.now();
  const nextOutcome = isRunLifecycleOutcomeState(nextState) ? nextState : lifecycle.outcome;
  const nextLifecycle: RunLifecycle = {
    ...lifecycle,
    state: nextState,
    outcome: nextOutcome,
    enteredAt: now,
    reason: input.reason ?? DEFAULT_REASON_BY_STATE[nextState],
  };
  if (input.signalAt !== undefined) {
    nextLifecycle.lastSignalAt = input.signalAt;
  }
  if (input.error !== undefined) {
    nextLifecycle.error = input.error;
  }
  return nextLifecycle;
}

export function recordRunLifecycleSignal(
  lifecycle: RunLifecycle,
  signalAt = Date.now(),
): RunLifecycle {
  return {
    ...lifecycle,
    lastSignalAt: signalAt,
  };
}

export function detectRunLifecycleStall(
  lifecycle: Pick<RunLifecycle, 'state' | 'startedAt' | 'lastSignalAt'>,
  options: RunLifecycleStallOptions = {},
): RunLifecycleStallDetection {
  const now = options.now ?? Date.now();
  const thresholdMs = normalizeNonNegativeNumber(options.stallAfterMs, DEFAULT_STALL_AFTER_MS);
  const referenceAt = Math.max(lifecycle.startedAt, lifecycle.lastSignalAt ?? lifecycle.startedAt);
  const silenceMs = Math.max(0, now - referenceAt);
  const stalled = isRunLifecycleActiveState(lifecycle.state) && silenceMs >= thresholdMs;
  return {
    stalled,
    state: lifecycle.state,
    referenceAt,
    silenceMs,
    thresholdMs,
    reason: stalled ? 'run_stalled' : null,
  };
}

export function transitionRunLifecycleIfStalled(
  lifecycle: RunLifecycle,
  options: RunLifecycleStallOptions = {},
): RunLifecycle | null {
  const detection = detectRunLifecycleStall(lifecycle, options);
  if (!detection.stalled) return null;
  const transitionInput: TransitionRunLifecycleInput = { reason: 'run_stalled' };
  if (options.now !== undefined) transitionInput.now = options.now;
  return transitionRunLifecycle(lifecycle, 'stalled', transitionInput);
}

export function calculateRetryDelayMs(input: RetryBackoffInput): number {
  const attempt = normalizeAttempt(input.attempt);
  const baseDelayMs = normalizeNonNegativeNumber(input.baseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS);
  const maxDelayMs = normalizeNonNegativeNumber(input.maxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS);
  const multiplier = normalizeMultiplier(input.multiplier);
  const rawDelay = baseDelayMs * multiplier ** Math.max(0, attempt - 1);
  if (!Number.isFinite(rawDelay)) return maxDelayMs;
  return Math.min(maxDelayMs, Math.round(rawDelay));
}

export function decideRunRetry(
  lifecycle: Pick<RunLifecycle, 'state' | 'attempt'>,
  policy: RunRetryPolicy = {},
): RunRetryDecision {
  const attempt = normalizeAttempt(lifecycle.attempt);
  const maxAttempts = normalizeAttempt(policy.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS);
  const attemptsRemaining = Math.max(0, maxAttempts - attempt);

  if (!isRetryableRunLifecycleState(lifecycle.state)) {
    return retryReleaseDecision('retry_not_applicable', attemptsRemaining);
  }

  if (attempt >= maxAttempts) {
    return retryReleaseDecision('retry_limit_reached', 0);
  }

  const retryBackoffInput: RetryBackoffInput = { attempt };
  if (policy.baseDelayMs !== undefined) retryBackoffInput.baseDelayMs = policy.baseDelayMs;
  if (policy.maxDelayMs !== undefined) retryBackoffInput.maxDelayMs = policy.maxDelayMs;
  if (policy.multiplier !== undefined) retryBackoffInput.multiplier = policy.multiplier;

  return {
    shouldRetry: true,
    nextState: 'retry_queued',
    reason: 'retry_scheduled',
    delayMs: calculateRetryDelayMs(retryBackoffInput),
    nextAttempt: attempt + 1,
    attemptsRemaining,
  };
}

export function decideRunContinuation(input: {
  lifecycle: Pick<RunLifecycle, 'state' | 'attempt'>;
  mission: ActiveMissionState | null;
  retryPolicy?: RunRetryPolicy;
}): RunContinuationDecision {
  const { lifecycle, mission } = input;

  if (lifecycle.state === 'retry_queued') {
    return {
      action: 'retry',
      shouldContinue: false,
      shouldRetry: true,
      nextState: 'retry_queued',
      reason: 'retry_already_queued',
      delayMs: 0,
      nextAttempt: normalizeAttempt(lifecycle.attempt) + 1,
    };
  }

  if (lifecycle.state === 'released') {
    return releaseContinuationDecision(null, 'released');
  }

  if (!isRunLifecycleTerminalState(lifecycle.state)) {
    return {
      action: 'wait',
      shouldContinue: false,
      shouldRetry: false,
      nextState: null,
      reason: 'run_in_progress',
      delayMs: 0,
      nextAttempt: null,
    };
  }

  if (!isContinuableMission(mission)) {
    return releaseContinuationDecision('released', missionReleaseReason(mission));
  }

  if (lifecycle.state === 'succeeded') {
    return {
      action: 'continue',
      shouldContinue: true,
      shouldRetry: false,
      nextState: 'released',
      reason: 'active_mission_continues',
      delayMs: 0,
      nextAttempt: null,
    };
  }

  const retryDecision = decideRunRetry(lifecycle, input.retryPolicy);
  if (retryDecision.shouldRetry) {
    return {
      action: 'retry',
      shouldContinue: false,
      shouldRetry: true,
      nextState: retryDecision.nextState,
      reason: 'active_mission_retry',
      delayMs: retryDecision.delayMs,
      nextAttempt: retryDecision.nextAttempt,
    };
  }

  return releaseContinuationDecision('released', retryDecision.reason);
}

export function mapRunLifecycleToAgentRunStatus(
  input: RunLifecycleState | Pick<RunLifecycle, 'state' | 'outcome'>,
): AgentRunStatus {
  const state = typeof input === 'string' ? input : input.state;
  const outcome = typeof input === 'string' ? null : input.outcome;
  const effectiveState = state === 'released' && outcome ? outcome : state;

  if (
    effectiveState === 'start' ||
    isRunLifecycleActiveState(effectiveState) ||
    effectiveState === 'retry_queued'
  ) {
    return 'running';
  }
  if (effectiveState === 'succeeded') return 'completed';
  if (effectiveState === 'released') return 'completed';
  return 'failed';
}

function retryReleaseDecision(
  reason: RunLifecycleReason,
  attemptsRemaining: number,
): RunRetryDecision {
  return {
    shouldRetry: false,
    nextState: 'released',
    reason,
    delayMs: 0,
    nextAttempt: null,
    attemptsRemaining,
  };
}

function releaseContinuationDecision(
  nextState: RunLifecycleDispositionState | null,
  reason: RunLifecycleReason,
): RunContinuationDecision {
  return {
    action: 'release',
    shouldContinue: false,
    shouldRetry: false,
    nextState,
    reason,
    delayMs: 0,
    nextAttempt: null,
  };
}

function isContinuableMission(mission: ActiveMissionState | null): boolean {
  if (!mission) return false;
  if (mission.waitingForHuman === true) return false;
  if (mission.hasOpenWork === false) return false;
  return mission.status === 'active' || mission.status === 'verifying';
}

function missionReleaseReason(mission: ActiveMissionState | null): RunLifecycleReason {
  if (!mission) return 'mission_not_active';
  if (mission.waitingForHuman === true) return 'mission_waiting_for_human';
  return 'mission_not_active';
}

function normalizeAttempt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function normalizeMultiplier(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETRY_MULTIPLIER;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RETRY_MULTIPLIER;
}
