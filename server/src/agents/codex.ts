// server/src/agents/codex.ts
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentReply, AgentRunContext, AgentSpec, AgentStreamEvent } from './types.js';
import { AgentParseError } from './types.js';
import { codexContextUsage, formatContextUsage } from '../context-usage.js';
import { permissionTargetDirectory } from '../permissions.js';

interface JsonlEvent {
  type?: string;
  [k: string]: unknown;
}

function parseJsonl(input: string): JsonlEvent[] {
  const events: JsonlEvent[] = [];
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as JsonlEvent);
    } catch {
      // Ignore non-JSON lines; some CLIs print plain status text.
    }
  }
  return events;
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

function codexUsageDetail(usage: unknown): string {
  const obj = asRecord(usage);
  if (!obj) return '';
  const parts: string[] = [];
  for (const key of ['input_tokens', 'output_tokens', 'reasoning_output_tokens']) {
    const value = obj[key];
    if (typeof value === 'number') parts.push(`${key}: ${value}`);
  }
  return parts.join(', ');
}

function codexStreamEvents(line: string): AgentStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }

  const type = typeof event.type === 'string' ? event.type : 'event';
  const item = asRecord(event.item);
  if (type === 'thread.started') {
    return [
      {
        kind: 'event',
        status: 'running',
        label: 'codex thread started',
        detail: typeof event.thread_id === 'string' ? event.thread_id : '',
      },
    ];
  }
  if (type === 'turn.started') {
    return [{ kind: 'event', status: 'running', label: 'codex turn started' }];
  }
  if (type === 'turn.completed') {
    const contextUsage = codexContextUsage(event.usage);
    return [
      {
        kind: 'usage',
        status: 'completed',
        label: 'codex turn completed',
        detail: contextUsage ? formatContextUsage(contextUsage) : codexUsageDetail(event.usage),
        ...(contextUsage ? { contextUsage } : {}),
      },
    ];
  }
  if (item) {
    const itemType = typeof item.type === 'string' ? item.type : 'item';
    const text = excerpt(item.text) || excerpt(item.output) || excerpt(item.arguments);
    const isAssistant = itemType === 'agent_message';
    const isTool = itemType.includes('tool') || itemType.includes('call');
    return [
      {
        kind: isAssistant ? 'message' : isTool ? 'tool' : 'event',
        status: type.endsWith('.completed') ? 'completed' : 'running',
        label: isAssistant ? 'codex assistant message ready' : `codex ${itemType}`,
        detail: text,
      },
    ];
  }
  return [{ kind: 'event', status: 'running', label: `codex ${type}` }];
}

// Codex emits the session id as `thread_id` on the `thread.started` event.
// Keep fallback field names in case the CLI renames it in a future release.
function findSessionId(events: JsonlEvent[]): string | null {
  for (const e of events) {
    const obj = e as Record<string, unknown>;
    const tid = obj['thread_id'] ?? obj['session_id'] ?? obj['sessionId'];
    if (typeof tid === 'string') return tid;
  }
  return null;
}

// The final assistant text appears on an `item.completed` event whose nested
// `item.type` is `agent_message`; the text lives at `item.text`. With
// `--output-schema`, that text is a JSON string like `{"message":"pong"}`.
// Resume does not support `--output-schema`, so raw text must keep working.
function findAssistantText(events: JsonlEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as Record<string, unknown>;
    if (e['type'] !== 'item.completed') continue;

    const item = e['item'];
    if (!item || typeof item !== 'object') continue;

    const itemObj = item as Record<string, unknown>;
    if (itemObj['type'] !== 'agent_message' || typeof itemObj['text'] !== 'string') continue;

    const raw = itemObj['text'] as string;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'message' in (parsed as Record<string, unknown>) &&
        typeof (parsed as Record<string, unknown>)['message'] === 'string'
      ) {
        return (parsed as Record<string, unknown>)['message'] as string;
      }
    } catch {
      // Raw text is expected on resumed turns because schema is unsupported.
    }
    return raw;
  }
  return null;
}

const CODEX_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description:
        'The text of your next chat message. Do not include role labels, JSON wrappers, markdown, or explanations. Just the literal text of what you would say.',
    },
  },
  required: ['message'],
  additionalProperties: false,
};

let schemaPath: string | null = null;
function ensureSchemaFile(): string {
  if (schemaPath !== null && fs.existsSync(schemaPath)) return schemaPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fireside-codex-schema-'));
  const filePath = path.join(dir, 'reply-schema.json');
  fs.writeFileSync(filePath, JSON.stringify(CODEX_REPLY_SCHEMA), 'utf8');
  schemaPath = filePath;
  return filePath;
}

export function _resetSchemaPathForTests(): void {
  schemaPath = null;
}

function codexPermissionArgs(context?: AgentRunContext): string[] {
  const addDir = context?.permission
    ? permissionTargetDirectory(context.permission.target)
    : null;
  const writableRootArgs = addDir
    ? [
        '-c',
        `sandbox_workspace_write.writable_roots=["${addDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`,
      ]
    : [];
  const capabilities = context?.permission?.capabilities ?? [];
  const requestedMode = context?.permission?.requestedMode?.toLowerCase() ?? '';
  const scopedCommandGrant =
    context?.permission?.mode === 'full-auto' &&
    capabilities.includes('run-command') &&
    [
      'bash',
      'shell',
      'command',
      'commands',
      'run',
      'run-command',
      'terminal',
      'exec',
      'execute',
      'git',
      'commit',
      'git-commit',
    ].includes(requestedMode) &&
    !capabilities.includes('delete-file');
  switch (context?.permission?.mode ?? 'plan') {
    case 'edit':
      return [
        '-c',
        'sandbox_mode="workspace-write"',
        ...writableRootArgs,
        '-c',
        'approval_policy="never"',
      ];
    case 'full-auto':
      if (scopedCommandGrant) {
        return [
          '-c',
          'sandbox_mode="workspace-write"',
          ...writableRootArgs,
          '-c',
          'approval_policy="never"',
        ];
      }
      return ['--dangerously-bypass-approvals-and-sandbox'];
    case 'plan':
      return ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'];
  }
}

export const codexSpec: AgentSpec = {
  id: 'codex',
  displayName: 'Codex',
  command: 'codex',
  defaultTimeoutMs: 600_000,
  buildArgs(_prompt, sessionId, context) {
    // Use stdin for the broker prompt. Codex with an argv prompt plus
    // non-TTY stdin can append a second stdin block after the prompt and
    // respond as if the transcript were missing.
    if (sessionId) {
      // `codex exec resume` does not accept `--output-schema`; rely on the
      // parser's raw-text fallback for resumed turns. Avoid --last so rooms do
      // not cross-resume each other.
      return ['exec', 'resume', ...codexPermissionArgs(context), '--json', sessionId, '-'];
    }
    const schema = ensureSchemaFile();
    return ['exec', ...codexPermissionArgs(context), '--json', '--output-schema', schema, '-'];
  },
  buildStdin(prompt) {
    return prompt;
  },
  parseStreamLine(line, stream): AgentStreamEvent[] {
    if (stream === 'stderr') return [];
    return codexStreamEvents(line);
  },
  parseOutput(stdout, stderr): AgentReply {
    const events = parseJsonl(stdout);
    if (events.length === 0) {
      const detail = stderr.trim().split('\n')[0];
      const suffix = detail ? `: ${detail}` : '';
      throw new AgentParseError('codex', `no JSONL events on stdout${suffix}`, stdout, stderr);
    }
    const text = findAssistantText(events);
    if (text === null) {
      throw new AgentParseError(
        'codex',
        'no assistant message event found in stream',
        stdout,
        stderr,
      );
    }
    const sessionId = findSessionId(events);
    return { text, sessionId, raw: { stdout, stderr } };
  },
};
