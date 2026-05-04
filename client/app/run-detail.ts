// client/app/run-detail.ts
// Pure helpers for parsing and presenting AgentRunAction.detail strings.
// Many call sites (mission graph, activity ledger, run rows) extract a human
// title or status out of detail blobs that may be raw text or stringified JSON.

import { oneLine } from './formatters';
import type { AgentRunAction } from './api.types';

export function readableJsonText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['message', 'text', 'content', 'summary', 'body']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && /[A-Za-z0-9]/.test(candidate)) {
      return candidate.trim();
    }
  }
  return '';
}

export function readableDetailText(detail: string | undefined, maxChars: number): string {
  const rawDetail = detail?.trim() ?? '';
  if (!rawDetail) return '';
  try {
    const parsed = JSON.parse(rawDetail) as unknown;
    const readable = readableJsonText(parsed);
    return readable ? oneLine(readable, maxChars) : '';
  } catch {
    // Plain text details are expected for most provider stream events.
  }
  return oneLine(rawDetail, maxChars);
}

export function actionDetailText(action: AgentRunAction, maxChars: number): string {
  return readableDetailText(action.detail, maxChars);
}

export function parseActivityDetail(
  detail: string | undefined,
): { title: string; status: string } | null {
  const text = readableDetailText(detail, 260);
  if (!text) return null;
  const match = text.match(/^(.*?)\s+\(([^()]+)\)$/);
  if (!match) return { title: text, status: '' };
  return {
    title: match[1]?.trim() || text,
    status: match[2]?.trim().toLowerCase() || '',
  };
}

export function activityTaskTitle(detail: string | undefined): string {
  const text = readableDetailText(detail, 220);
  return text
    .replace(/\s*\[id=[^\]]+\]\s*$/i, '')
    .replace(/\s+\([^()]+\)$/i, '')
    .trim();
}

export function normalizeMissionGraphTitle(value: string): string {
  return value
    .replace(/\s*\[id=[^\]]+\]\s*$/i, '')
    .replace(/\s+\([^()]+\)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
