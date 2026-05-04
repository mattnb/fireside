import type {
  AgentContextUsage,
} from '../context-usage.js';
import { isVisibleProviderSignal, readableProviderSignalDetail } from '../provider-signals.js';
import type {
  AgentStreamEvent,
  AgentStreamEventStatus,
  ProviderId,
} from './types.js';

export const PROVIDER_EVENT_KINDS = [
  'assistant_message',
  'tool_use',
  'context_usage',
  'quota_update',
  'command_started',
  'command_finished',
  'lifecycle',
  'stderr',
  'error',
  'unknown',
] as const;

export type ProviderEventKind = (typeof PROVIDER_EVENT_KINDS)[number];

export interface ProviderContractEvent {
  provider: ProviderId;
  kind: ProviderEventKind;
  status: AgentStreamEventStatus;
  label: string;
  detail: string;
  lowSignal: boolean;
  contextUsage?: AgentContextUsage;
}

export function normalizeProviderStreamEvent(
  provider: ProviderId,
  event: AgentStreamEvent,
): ProviderContractEvent {
  const kind = classifyProviderEvent(event);
  const detail = readableProviderSignalDetail(event.detail, 500);
  return {
    provider,
    kind,
    status: event.status,
    label: event.label,
    detail,
    lowSignal: !isVisibleProviderSignal(event),
    ...(event.contextUsage ? { contextUsage: event.contextUsage } : {}),
  };
}

export function normalizeProviderStreamEvents(
  provider: ProviderId,
  events: AgentStreamEvent[],
): ProviderContractEvent[] {
  return events.map((event) => normalizeProviderStreamEvent(provider, event));
}

export function classifyProviderEvent(event: AgentStreamEvent): ProviderEventKind {
  if (event.status === 'failed' || event.kind === 'stderr') return event.kind === 'stderr' ? 'stderr' : 'error';
  if (event.contextUsage?.quota) return 'quota_update';
  if (event.contextUsage || event.kind === 'usage') return 'context_usage';
  if (event.kind === 'message') return 'assistant_message';
  if (event.kind === 'tool') return 'tool_use';

  const label = event.label.toLowerCase();
  if (/process started|command_execution.*running|turn started|thread started|initialized/.test(label)) {
    return 'command_started';
  }
  if (/process completed|command_execution.*completed|turn completed|result received/.test(label)) {
    return 'command_finished';
  }
  if (event.kind === 'event') return 'lifecycle';
  return 'unknown';
}
