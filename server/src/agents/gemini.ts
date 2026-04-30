// server/src/agents/gemini.ts
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentReply, AgentRunContext, AgentSpec, AgentStreamEvent } from './types.js';
import { AgentParseError } from './types.js';
import { extractTopLevelJsonObject } from './json-extract.js';
import { permissionTargetDirectory } from '../permissions.js';

// Field names captured from Phase 2 fixture (gemini-headless.json):
//   top-level `response` carries the assistant text
//   top-level `session_id` carries the session id
// We keep the lookup arrays ordered with the captured names first; later
// names act as forward-compat fallbacks should the CLI evolve.
const RESPONSE_FIELDS = ['response', 'result', 'text', 'output'];
const SESSION_FIELDS = ['session_id', 'sessionId', 'session'];

function pickString(obj: Record<string, unknown>, fields: string[]): string | null {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === 'string') return v;
  }
  return null;
}

function excerpt(text: unknown, maxChars = 320): string {
  if (typeof text !== 'string') return '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}...`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseGeminiStreamReply(stdout: string): { text: string; sessionId: string | null } | null {
  let assistantText: string | null = null;
  let assistantDeltaText = '';
  let sessionId: string | null = null;
  for (const line of stdout.split('\n')) {
    const obj = parseJsonLine(line);
    if (!obj) continue;
    const pickedSession = pickString(obj, SESSION_FIELDS);
    if (pickedSession) sessionId = pickedSession;
    const directResponse = pickString(obj, RESPONSE_FIELDS);
    if (directResponse) assistantText = directResponse;
    if (obj.type === 'message' && obj.role === 'assistant' && typeof obj.content === 'string') {
      if (obj.delta === true) assistantDeltaText += obj.content;
      else assistantText = obj.content;
    }
  }
  const text = assistantText ?? (assistantDeltaText ? assistantDeltaText : null);
  return text === null ? null : { text, sessionId };
}

function geminiStatsDetail(stats: unknown): string {
  const obj = asRecord(stats);
  if (!obj) return '';
  const parts: string[] = [];
  for (const key of ['duration_ms', 'tool_calls', 'api_calls', 'total_tokens']) {
    const value = obj[key];
    if (typeof value === 'number') parts.push(`${key}: ${value}`);
  }
  return parts.join(', ');
}

function geminiStreamEvents(line: string): AgentStreamEvent[] {
  const obj = parseJsonLine(line);
  if (!obj) return [];
  const type = typeof obj.type === 'string' ? obj.type : 'event';
  if (type === 'init') {
    const model = typeof obj.model === 'string' ? obj.model : '';
    const sessionId = typeof obj.session_id === 'string' ? obj.session_id : '';
    return [
      {
        kind: 'event',
        status: 'running',
        label: 'gemini initialized',
        detail: [model, sessionId].filter(Boolean).join(' / '),
      },
    ];
  }
  if (type === 'message') {
    const role = typeof obj.role === 'string' ? obj.role : '';
    if (role === 'assistant') {
      return [
        {
          kind: 'message',
          status: obj.delta === true ? 'running' : 'completed',
          label: obj.delta === true ? 'gemini assistant text streaming' : 'gemini assistant message',
          detail: excerpt(obj.content),
        },
      ];
    }
    return [{ kind: 'event', status: 'running', label: `gemini ${role || 'message'}` }];
  }
  if (type === 'result') {
    const failed = obj.status === 'error' || obj.status === 'failed';
    return [
      {
        kind: 'usage',
        status: failed ? 'failed' : 'completed',
        label: 'gemini result received',
        detail: geminiStatsDetail(obj.stats),
      },
    ];
  }
  return [{ kind: 'event', status: 'running', label: `gemini ${type}` }];
}

function createEmptyCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fireside-gemini-cwd-'));
}

function geminiApprovalMode(context?: AgentRunContext): string {
  switch (context?.permission?.mode ?? 'plan') {
    case 'edit':
      return 'auto_edit';
    case 'full-auto':
      return 'yolo';
    case 'plan':
      return 'plan';
  }
}

export const geminiSpec: AgentSpec = {
  id: 'gemini',
  displayName: 'Gemini',
  command: 'gemini',
  defaultTimeoutMs: 600_000,
  // Gemini-cli auto-detects context from cwd and mishandles multi-line prompt
  // text passed as the `-p` argv value on Windows. Keep `-p` present to force
  // headless mode, send the real prompt through stdin, and run each turn in a
  // fresh empty cwd so stale temp files cannot become project context.
  buildCwd: createEmptyCwd,
  buildArgs(_prompt, sessionId, context) {
    const args = [
      '-p',
      '',
      '--output-format',
      'stream-json',
      '--approval-mode',
      geminiApprovalMode(context),
    ];
    const includeDir = context?.permission
      ? permissionTargetDirectory(context.permission.target)
      : null;
    if (includeDir) args.push('--include-directories', includeDir);
    if (sessionId) args.push('--resume', sessionId);
    return args;
  },
  buildStdin(prompt) {
    return prompt;
  },
  parseStreamLine(line, stream): AgentStreamEvent[] {
    if (stream === 'stderr') return [];
    return geminiStreamEvents(line);
  },
  parseOutput(stdout, stderr): AgentReply {
    if (!stdout.trim()) throw new AgentParseError('gemini', 'empty stdout', stdout, stderr);
    const streamed = parseGeminiStreamReply(stdout);
    if (streamed) {
      return { text: streamed.text, sessionId: streamed.sessionId, raw: { stdout, stderr } };
    }
    // Gemini may emit a preamble on stdout before the JSON object. Tolerate it.
    const parsed = extractTopLevelJsonObject(stdout);
    if (!parsed || typeof parsed !== 'object') {
      throw new AgentParseError(
        'gemini',
        'no top-level JSON object found in stdout',
        stdout,
        stderr,
      );
    }
    const obj = parsed as Record<string, unknown>;
    const text = pickString(obj, RESPONSE_FIELDS);
    const sessionId = pickString(obj, SESSION_FIELDS);
    if (text === null) {
      throw new AgentParseError('gemini', 'no response field found', stdout, stderr);
    }
    return { text, sessionId, raw: { stdout, stderr } };
  },
};
