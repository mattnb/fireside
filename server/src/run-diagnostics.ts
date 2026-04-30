import type { AgentId } from './agents/types.js';
import { extractTopLevelJsonObject } from './agents/json-extract.js';
import { isVisibleProviderSignal, readableProviderSignalDetail } from './provider-signals.js';

export interface RunSignal {
  kind: 'event' | 'tool' | 'usage' | 'stderr';
  label: string;
  detail: string;
}

export interface RunDiagnostics {
  stdoutChars: number;
  stderrChars: number;
  signals: RunSignal[];
}

function excerpt(text: unknown, maxChars = 320): string {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}...`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function codexSignals(stdout: string): RunSignal[] {
  const signals: RunSignal[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof event.type === 'string' ? event.type : 'event';
    const item = asRecord(event.item);
    if (item) {
      const itemType = typeof item.type === 'string' ? item.type : 'item';
      const name = typeof item.name === 'string' ? ` ${item.name}` : '';
      const detail = excerpt(item.text) || excerpt(item.arguments) || excerpt(item.output);
      signals.push({
        kind: itemType.includes('tool') || itemType.includes('call') ? 'tool' : 'event',
        label: `${type}: ${itemType}${name}`,
        detail: readableProviderSignalDetail(detail) || detail,
      });
    } else {
      const detail = typeof event.thread_id === 'string' ? event.thread_id : '';
      signals.push({ kind: 'event', label: type, detail });
    }
    if (signals.length >= 40) break;
  }
  return signals;
}

function jsonSignals(agentId: AgentId, stdout: string): RunSignal[] {
  const obj = asRecord(extractTopLevelJsonObject(stdout));
  if (!obj) return [];
  const signals: RunSignal[] = [];

  for (const key of ['stop_reason', 'terminal_reason', 'subtype']) {
    const value = obj[key];
    if (typeof value === 'string' && value) {
      signals.push({ kind: 'event', label: `${agentId} ${key}`, detail: value });
    }
  }

  const usage = asRecord(obj.usage);
  const serverToolUse = asRecord(usage?.server_tool_use);
  if (serverToolUse) {
    for (const [key, value] of Object.entries(serverToolUse)) {
      if (typeof value === 'number' && value > 0) {
        signals.push({ kind: 'tool', label: key, detail: String(value) });
      }
    }
  }

  const denials = obj.permission_denials;
  if (Array.isArray(denials) && denials.length > 0) {
    signals.push({
      kind: 'event',
      label: 'permission denials',
      detail: `${denials.length}`,
    });
  }

  for (const key of ['duration_ms', 'num_turns', 'total_cost_usd']) {
    const value = obj[key];
    if (typeof value === 'number') {
      signals.push({ kind: 'usage', label: key, detail: String(value) });
    }
  }
  return signals;
}

export function buildRunDiagnostics(agentId: AgentId, stdout: string, stderr: string): RunDiagnostics {
  const signals =
    agentId === 'codex' ? codexSignals(stdout) : jsonSignals(agentId, stdout);
  if (stderr.trim()) {
    signals.push({ kind: 'stderr', label: 'stderr', detail: excerpt(stderr, 500) });
  }
  const visibleSignals = signals.filter(isVisibleProviderSignal);
  return {
    stdoutChars: stdout.length,
    stderrChars: stderr.length,
    signals: visibleSignals.slice(0, 50),
  };
}
