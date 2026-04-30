export interface ProviderSignalLike {
  label: string;
  detail?: string;
}

const NOISY_LABEL_PATTERNS = [
  /\bmessage_start\b/i,
  /\bmessage_delta\b/i,
  /\bmessage_stop\b/i,
  /\bcontent_block_start\b/i,
  /\bcontent_block_stop\b/i,
  /\bcontent_block_delta\b/i,
  /\btool_use\b/i,
  /\bthread\.started\b/i,
  /\bthread started\b/i,
  /\bturn\.started\b/i,
  /\bturn started\b/i,
  /\bturn\.completed\b/i,
  /\bassistant message ready\b/i,
  /\bagent_message\b/i,
  /^(?:claude|codex|gemini)?\s*status$/i,
];

const TOOL_NAME_ONLY = new Set([
  'bash',
  'edit',
  'glob',
  'grep',
  'ls',
  'multiedit',
  'read',
  'todowrite',
  'webfetch',
  'websearch',
  'write',
]);

function oneLine(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}...`;
}

function readableJsonText(value: unknown): string {
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

export function readableProviderSignalDetail(detail: string | undefined, maxChars = 320): string {
  const rawDetail = detail?.trim() ?? '';
  if (!rawDetail) return '';
  try {
    const parsed = JSON.parse(rawDetail) as unknown;
    const readable = readableJsonText(parsed);
    return readable ? oneLine(readable, maxChars) : '';
  } catch {
    return oneLine(rawDetail, maxChars);
  }
}

function isAssistantMessageLabel(label: string): boolean {
  return /assistant message ready|agent_message/i.test(label);
}

function isSubstantiveProviderText(text: string): boolean {
  if (!text) return false;
  const normalized = text.trim();
  const lowered = normalized.toLowerCase();
  if (TOOL_NAME_ONLY.has(lowered)) return false;
  if (/^[0-9a-f-]{20,}$/i.test(normalized)) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.length >= 4 || normalized.length >= 40;
}

export function isNoisyProviderSignalLabel(label: string): boolean {
  return NOISY_LABEL_PATTERNS.some((pattern) => pattern.test(label));
}

export function isVisibleProviderSignal(signal: ProviderSignalLike): boolean {
  const label = signal.label.trim();
  if (!isNoisyProviderSignalLabel(label)) return true;
  const detail = readableProviderSignalDetail(signal.detail);
  if (!detail) return false;
  if (isAssistantMessageLabel(label)) return true;
  return isSubstantiveProviderText(detail);
}
