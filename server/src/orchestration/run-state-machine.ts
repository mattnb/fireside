import type { AgentJob, AgentJobStatus } from '../repos/agent-jobs.js';
import type { AgentRun, AgentRunLifecycleState, AgentRunStatus } from '../repos/agent-runs.js';

export const RUN_EXECUTION_STATES = [
  'queued',
  'leased',
  'running',
  'waiting_on_permission',
  'retrying',
  'completed',
  'failed',
  'canceled',
  'dismissed',
  'superseded',
] as const;

export type RunExecutionState = (typeof RUN_EXECUTION_STATES)[number];

export interface RunExecutionSnapshot {
  state: RunExecutionState;
  reason: string;
  jobStatus: AgentJobStatus | null;
  runStatus: AgentRunStatus | null;
  lifecycleState: AgentRunLifecycleState | null;
  attempt: number;
  maxAttempts: number;
  retryAfter: number | null;
  terminal: boolean;
}

export interface RunExecutionTransitionValidation {
  ok: boolean;
  from: RunExecutionState;
  to: RunExecutionState;
  allowed: readonly RunExecutionState[];
  message: string;
}

export const RUN_EXECUTION_TRANSITIONS = {
  queued: ['leased', 'running', 'canceled', 'superseded'],
  leased: ['running', 'queued', 'canceled', 'superseded'],
  running: [
    'waiting_on_permission',
    'retrying',
    'completed',
    'failed',
    'canceled',
    'dismissed',
    'superseded',
  ],
  waiting_on_permission: ['running', 'completed', 'canceled', 'dismissed', 'superseded'],
  retrying: ['running', 'failed', 'canceled', 'dismissed', 'superseded'],
  completed: ['dismissed'],
  failed: ['dismissed'],
  canceled: ['dismissed'],
  dismissed: [],
  superseded: ['dismissed'],
} satisfies Record<RunExecutionState, readonly RunExecutionState[]>;

const TERMINAL_STATES = new Set<RunExecutionState>([
  'completed',
  'failed',
  'canceled',
  'dismissed',
  'superseded',
]);

export function inferRunExecutionSnapshot(input: {
  job?: AgentJob | null;
  run?: AgentRun | null;
}): RunExecutionSnapshot {
  const job = input.job ?? null;
  const run = input.run ?? null;
  const state = inferRunExecutionState(job, run);
  return {
    state,
    reason: explainRunExecutionState(state, job, run),
    jobStatus: job?.status ?? null,
    runStatus: run?.status ?? null,
    lifecycleState: run?.lifecycleState ?? null,
    attempt: run?.attempt ?? job?.attempt ?? 1,
    maxAttempts: job?.maxAttempts ?? 1,
    retryAfter: run?.retryAfter ? run.retryAfter : null,
    terminal: TERMINAL_STATES.has(state),
  };
}

export function getAllowedRunExecutionTransitions(
  state: RunExecutionState,
): readonly RunExecutionState[] {
  return RUN_EXECUTION_TRANSITIONS[state];
}

export function canTransitionRunExecutionState(
  from: RunExecutionState,
  to: RunExecutionState,
): boolean {
  return getAllowedRunExecutionTransitions(from).includes(to);
}

export function validateRunExecutionTransition(
  from: RunExecutionState,
  to: RunExecutionState,
): RunExecutionTransitionValidation {
  const allowed = getAllowedRunExecutionTransitions(from);
  if (allowed.includes(to)) {
    return {
      ok: true,
      from,
      to,
      allowed,
      message: `Run execution can transition from ${from} to ${to}.`,
    };
  }
  const allowedText = allowed.length > 0 ? allowed.join(', ') : 'none';
  return {
    ok: false,
    from,
    to,
    allowed,
    message: `Illegal run execution transition from ${from} to ${to}. Allowed next states: ${allowedText}.`,
  };
}

function inferRunExecutionState(job: AgentJob | null, run: AgentRun | null): RunExecutionState {
  if (job?.status === 'superseded') return 'superseded';
  if (job?.status === 'canceled') return 'canceled';
  if (job?.status === 'queued') return 'queued';
  if (job?.status === 'leased' && !run) return 'leased';

  if (run?.status === 'permission-requested') return 'waiting_on_permission';
  if (run?.lifecycleState === 'retry_queued') return 'retrying';
  if (run?.status === 'running') return 'running';
  if (
    run?.lifecycleState === 'canceled_by_reconciliation' ||
    run?.lifecycleState === 'canceled_by_user'
  ) {
    return 'canceled';
  }
  if (run?.status === 'failed' || job?.status === 'failed') return 'failed';
  if (run?.status === 'completed' || run?.status === 'empty' || job?.status === 'completed') {
    return 'completed';
  }
  if (job?.status === 'running') return 'running';
  if (job?.status === 'leased') return 'leased';
  return 'completed';
}

function explainRunExecutionState(
  state: RunExecutionState,
  job: AgentJob | null,
  run: AgentRun | null,
): string {
  switch (state) {
    case 'queued':
      return 'agent job is queued and has not been leased yet';
    case 'leased':
      return 'agent job is leased but no provider process is attached yet';
    case 'running':
      return run?.lifecycleReason || 'provider turn is active';
    case 'waiting_on_permission':
      return run?.lifecycleReason || 'agent requested permission and is waiting on a human';
    case 'retrying':
      return run?.retryAfter
        ? `provider turn failed and retry is scheduled for ${run.retryAfter}`
        : 'provider turn failed and retry is scheduled';
    case 'completed':
      return run?.lifecycleReason || 'provider turn completed';
    case 'failed':
      return run?.error || job?.error || run?.lifecycleReason || 'provider turn failed';
    case 'canceled':
      return job?.error || run?.lifecycleReason || 'provider turn was canceled';
    case 'dismissed':
      return run?.lifecycleReason || 'human dismissed the visible run cue';
    case 'superseded':
      return job?.error || 'agent job was superseded by newer work';
  }
}
