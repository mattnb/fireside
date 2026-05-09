import type { AgentStreamEvent } from '../agents/types.js';
import {
  isVisibleProviderSignal,
  readableProviderSignalDetail,
} from '../provider-signals.js';
import type { CreateAgentRunActionInput } from '../repos/run-actions.js';

export interface ProviderSignalProcessingState {
  lastMessageActionAt: number;
  lastLabel: string;
  lastDetail: string;
  lastDuplicateAt: number;
  lastRunSignalUpdateAt: number;
}

export interface ProviderSignalLifecycleUpdate {
  state: 'streaming_turn';
  reason: string;
  lastSignalAt: number;
}

export interface ProviderSignalAction {
  kind: CreateAgentRunActionInput['kind'];
  status: AgentStreamEvent['status'];
  label: string;
  detail: string;
  contextUsage?: AgentStreamEvent['contextUsage'];
}

export interface ProviderSignalProcessingResult {
  signalAt: number;
  lifecycleUpdate: ProviderSignalLifecycleUpdate | null;
  action: ProviderSignalAction | null;
}

/**
 * Tag a context-usage payload with the broker-known turnKind so downstream
 * consumers (and the UI) can distinguish mechanical bookkeeping turns
 * (workflow-repair, maintenance-compaction) from the agent's own
 * conversational turns. Mechanical turns use a different model (Haiku)
 * regardless of the agent profile, so their used/window/model are not
 * representative of the agent's actual context state. A pre-existing
 * `turnKind` on the payload is preserved (so adapters can override).
 */
export function annotateContextUsageWithTurnKind(
  contextUsage: AgentStreamEvent['contextUsage'],
  turnKind: string | undefined,
): AgentStreamEvent['contextUsage'] {
  if (!contextUsage || !turnKind || contextUsage.turnKind) return contextUsage;
  return { ...contextUsage, turnKind };
}

export interface ProviderSignalProcessingOptions {
  now?: number;
  runSignalUpdateThrottleMs?: number;
  streamMessageThrottleMs?: number;
  duplicateSuppressMs?: number;
}

export interface RunHeartbeatSnapshot {
  elapsedSeconds: number;
  idleMs: number;
  detail: string;
  stalled: boolean;
}

export function createProviderSignalProcessingState(): ProviderSignalProcessingState {
  return {
    lastMessageActionAt: 0,
    lastLabel: '',
    lastDetail: '',
    lastDuplicateAt: 0,
    lastRunSignalUpdateAt: 0,
  };
}

export function processProviderSignalEvent(
  state: ProviderSignalProcessingState,
  event: AgentStreamEvent,
  options: ProviderSignalProcessingOptions = {},
): ProviderSignalProcessingResult {
  const now = options.now ?? Date.now();
  const runSignalUpdateThrottleMs = options.runSignalUpdateThrottleMs ?? 2_500;
  const streamMessageThrottleMs = options.streamMessageThrottleMs ?? 1_000;
  const duplicateSuppressMs = options.duplicateSuppressMs ?? 750;
  const label = event.label.trim() || 'provider signal';
  const detail = (event.detail ?? '').trim();

  const lifecycleUpdate =
    now - state.lastRunSignalUpdateAt >= runSignalUpdateThrottleMs
      ? {
          state: 'streaming_turn' as const,
          reason: label,
          lastSignalAt: now,
        }
      : null;
  if (lifecycleUpdate) state.lastRunSignalUpdateAt = now;

  const visibleDetail = readableProviderSignalDetail(detail) || detail;
  const action = (() => {
    if (!isVisibleProviderSignal({ label, detail })) return null;
    if (event.kind === 'message' && event.status === 'running') {
      if (now - state.lastMessageActionAt < streamMessageThrottleMs) return null;
      state.lastMessageActionAt = now;
    }
    if (label === state.lastLabel && visibleDetail === state.lastDetail) {
      if (now - state.lastDuplicateAt < duplicateSuppressMs) return null;
    }
    state.lastLabel = label;
    state.lastDetail = visibleDetail;
    state.lastDuplicateAt = now;
    return {
      kind: actionKindForProviderSignal(event),
      status: event.status,
      label,
      detail: visibleDetail,
      ...(event.contextUsage ? { contextUsage: event.contextUsage } : {}),
    };
  })();

  return { signalAt: now, lifecycleUpdate, action };
}

export function actionKindForProviderSignal(
  event: Pick<AgentStreamEvent, 'kind'>,
): CreateAgentRunActionInput['kind'] {
  switch (event.kind) {
    case 'message':
      return 'message';
    case 'stderr':
      return 'diagnostic';
    case 'tool':
    case 'usage':
    case 'event':
      return 'adapter';
  }
}

export function describeRunHeartbeat(input: {
  startedAt: number;
  latestProviderSignalAt: number;
  now?: number;
  stallAfterMs?: number;
}): RunHeartbeatSnapshot {
  const now = input.now ?? Date.now();
  const stallAfterMs = input.stallAfterMs ?? 5 * 60 * 1000;
  const elapsedSeconds = Math.max(0, Math.round((now - input.startedAt) / 1000));
  const idleMs =
    input.latestProviderSignalAt > 0 ? now - input.latestProviderSignalAt : now - input.startedAt;
  const detail =
    input.latestProviderSignalAt > 0
      ? `last provider signal ${Math.max(0, Math.round((now - input.latestProviderSignalAt) / 1000))}s ago; process still running`
      : `${elapsedSeconds}s elapsed; no provider stream output yet`;
  return {
    elapsedSeconds,
    idleMs,
    detail,
    stalled: idleMs >= stallAfterMs,
  };
}
