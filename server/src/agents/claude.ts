// server/src/agents/claude.ts
import type { AgentReply, AgentRunContext, AgentSpec, AgentStreamEvent } from './types.js';
import { AgentParseError } from './types.js';
import { extractTopLevelJsonObject } from './json-extract.js';
import {
  claudeContextUsage,
  claudeDebugQuotaUsage,
  claudeQuotaUsage,
  formatContextUsage,
} from '../context-usage.js';
import { permissionTargetDirectory } from '../permissions.js';

// Field names captured from Phase 2 fixture (claude-headless.json):
//   top-level `result` carries the assistant text
//   top-level `session_id` carries the session id
const RESULT_FIELD = 'result';
const SESSION_FIELD = 'session_id';
const CLAUDE_QUOTA_DEBUG_INTERVAL_MS = 10 * 60 * 1000;
const CLAUDE_DEBUG_REDACTION =
  '[claude debug log redacted; quota headers parsed into telemetry]';

let nextClaudeQuotaDebugAt = 0;

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

function shouldCaptureClaudeQuotaHeaders(): boolean {
  if (process.env.FIRESIDE_CLAUDE_QUOTA_DEBUG_HEADERS === '0') return false;
  if (process.env.ANTHROPIC_LOG === 'debug') return false;
  const now = Date.now();
  if (now < nextClaudeQuotaDebugAt) return false;
  nextClaudeQuotaDebugAt = now + CLAUDE_QUOTA_DEBUG_INTERVAL_MS;
  return true;
}

function isClaudeStreamJsonLine(line: string): boolean {
  const obj = parseJsonLine(line);
  if (!obj) return false;
  const type = typeof obj.type === 'string' ? obj.type : '';
  if (['system', 'assistant', 'result', 'stream_event', 'rate_limit_event'].includes(type)) {
    return true;
  }
  return typeof obj[RESULT_FIELD] === 'string' || typeof obj[SESSION_FIELD] === 'string';
}

function hasClaudeDebugOutput(stdout: string, stderr: string): boolean {
  return /anthropic-ratelimit-unified-|anthropic_log|response headers|request headers|x-api-key|authorization/i.test(
    `${stdout}\n${stderr}`,
  );
}

function isClaudeDebugLine(line: string): boolean {
  return /anthropic-ratelimit-unified-|anthropic_log|response headers|request headers|x-api-key|authorization|anthropic-version|anthropic-beta|api-key/i.test(
    line,
  );
}

function sanitizeClaudeDebugOutput(text: string): string {
  const kept: string[] = [];
  let removed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (isClaudeStreamJsonLine(line)) {
      kept.push(line);
      continue;
    }
    removed += 1;
  }
  if (removed > 0) kept.push(CLAUDE_DEBUG_REDACTION);
  return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}

function sanitizeClaudeRaw(stdout: string, stderr: string): { stdout: string; stderr: string } {
  if (!hasClaudeDebugOutput(stdout, stderr)) return { stdout, stderr };
  return {
    stdout: sanitizeClaudeDebugOutput(stdout),
    stderr: sanitizeClaudeDebugOutput(stderr),
  };
}

function textFromContent(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    const obj = asRecord(item);
    if (obj && typeof obj.text === 'string') parts.push(obj.text);
  }
  return parts.length > 0 ? parts.join('') : null;
}

function textFromAssistantEvent(obj: Record<string, unknown>): string | null {
  const message = asRecord(obj.message);
  return textFromContent(message?.content) ?? textFromContent(obj.content);
}

function claudePromptTooLongReason(stdout: string): string {
  for (const line of stdout.split('\n')) {
    const obj = parseJsonLine(line);
    if (!obj) continue;
    const type = typeof obj.type === 'string' ? obj.type : '';
    const terminalReason =
      typeof obj.terminal_reason === 'string' ? obj.terminal_reason : '';
    const result = typeof obj[RESULT_FIELD] === 'string' ? obj[RESULT_FIELD] : '';
    if (
      (type === 'result' || result) &&
      (terminalReason === 'prompt_too_long' || /^prompt is too long$/i.test(result.trim()))
    ) {
      return terminalReason || 'prompt_too_long';
    }
  }
  return '';
}

function parseClaudeStreamReply(stdout: string): { text: string; sessionId: string | null } | null {
  let resultText: string | null = null;
  let assistantText: string | null = null;
  let deltaText = '';
  let sessionId: string | null = null;

  for (const line of stdout.split('\n')) {
    const obj = parseJsonLine(line);
    if (!obj) continue;
    if (typeof obj[SESSION_FIELD] === 'string') sessionId = obj[SESSION_FIELD] as string;

    const type = typeof obj.type === 'string' ? obj.type : '';
    if (type === 'result' || typeof obj[RESULT_FIELD] === 'string') {
      if (typeof obj[RESULT_FIELD] === 'string') resultText = obj[RESULT_FIELD] as string;
      continue;
    }
    if (type === 'assistant') {
      assistantText = textFromAssistantEvent(obj) ?? assistantText;
      continue;
    }
    if (type === 'stream_event') {
      const event = asRecord(obj.event);
      const delta = asRecord(event?.delta);
      if (typeof delta?.text === 'string') deltaText += delta.text;
    }
  }

  const text = resultText ?? assistantText ?? (deltaText ? deltaText : null);
  return text === null ? null : { text, sessionId };
}

function claudeResultDetail(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['duration_ms', 'num_turns', 'total_cost_usd']) {
    const value = obj[key];
    if (typeof value === 'number') parts.push(`${key}: ${value}`);
  }
  return parts.join(', ');
}

function claudeStreamEvents(line: string): AgentStreamEvent[] {
  const obj = parseJsonLine(line);
  if (!obj) return [];
  const type = typeof obj.type === 'string' ? obj.type : 'event';

  if (type === 'system') {
    const subtype = typeof obj.subtype === 'string' ? obj.subtype : 'system';
    if (subtype.startsWith('hook')) {
      return [
        {
          kind: 'event',
          status: 'running',
          label: 'claude hook event',
          detail: 'hook context received; details suppressed',
        },
      ];
    }
    if (subtype === 'init') {
      const model = typeof obj.model === 'string' ? obj.model : '';
      const cwd = typeof obj.cwd === 'string' ? obj.cwd : '';
      return [
        {
          kind: 'event',
          status: 'running',
          label: 'claude initialized',
          detail: [model, cwd].filter(Boolean).join(' / '),
        },
      ];
    }
    if (subtype === 'status') {
      return [
        {
          kind: 'event',
          status: 'running',
          label: 'claude status',
          detail: typeof obj.status === 'string' ? obj.status : '',
        },
      ];
    }
    return [{ kind: 'event', status: 'running', label: `claude ${subtype}` }];
  }

  if (type === 'stream_event') {
    const event = asRecord(obj.event);
    const eventType = typeof event?.type === 'string' ? event.type : 'stream event';
    const delta = asRecord(event?.delta);
    if (eventType === 'content_block_delta' && typeof delta?.text === 'string') {
      return [
        {
          kind: 'message',
          status: 'running',
          label: 'claude assistant text streaming',
          detail: excerpt(delta.text),
        },
      ];
    }
    const contentBlock = asRecord(event?.content_block);
    if (contentBlock && typeof contentBlock.type === 'string' && contentBlock.type.includes('tool')) {
      return [
        {
          kind: 'tool',
          status: 'running',
          label: `claude ${contentBlock.type}`,
          detail: excerpt(contentBlock.name),
        },
      ];
    }
    if (eventType === 'message_delta') {
      return [{ kind: 'usage', status: 'running', label: 'claude message delta' }];
    }
    return [{ kind: 'event', status: 'running', label: `claude ${eventType}` }];
  }

  if (type === 'assistant') {
    return [
      {
        kind: 'message',
        status: 'completed',
        label: 'claude assistant message ready',
        detail: excerpt(textFromAssistantEvent(obj) ?? ''),
      },
    ];
  }

  if (type === 'result') {
    const contextUsage = claudeContextUsage(obj);
    return [
      {
        kind: 'usage',
        status: 'completed',
        label: 'claude result received',
        detail: contextUsage ? formatContextUsage(contextUsage) : claudeResultDetail(obj),
        ...(contextUsage ? { contextUsage } : {}),
      },
    ];
  }

  if (type === 'rate_limit_event') {
    const contextUsage = claudeQuotaUsage(obj);
    return [
      {
        kind: 'usage',
        status: 'info',
        label: 'claude rate limit update',
        ...(contextUsage ? { detail: formatContextUsage(contextUsage), contextUsage } : {}),
      },
    ];
  }

  return [{ kind: 'event', status: 'running', label: `claude ${type}` }];
}

function claudePermissionMode(context?: AgentRunContext): string {
  if (isScopedCommandGrant(context)) return 'default';
  switch (context?.permission?.mode ?? 'plan') {
    case 'edit':
      return 'acceptEdits';
    case 'full-auto':
      return 'bypassPermissions';
    case 'plan':
      return 'plan';
  }
}

function isScopedCommandGrant(context?: AgentRunContext): boolean {
  const permission = context?.permission;
  if (!permission || permission.mode !== 'full-auto') return false;
  const capabilities = permission.capabilities ?? [];
  const requestedMode = permission.requestedMode?.toLowerCase() ?? '';
  return (
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
    !capabilities.includes('delete-file')
  );
}

function claudePermissionToolArgs(context?: AgentRunContext): string[] {
  if (isScopedCommandGrant(context)) {
    const capabilities = context?.permission?.capabilities ?? [];
    const gitOnly = capabilities.includes('git-commit') || capabilities.includes('git-push');
    const allowed = gitOnly ? 'Bash(git *)' : 'Bash(*)';
    const args = ['--allowedTools', allowed];
    if (!capabilities.includes('git-push')) {
      args.push('--disallowedTools', 'Bash(git push*) Bash(git * push*)');
    }
    return args;
  }
  switch (context?.permission?.mode ?? 'plan') {
    case 'edit':
      // Fireside's normalized "edit" means workspace file mutation, including
      // creating a new file. Claude Code distinguishes Write from Edit, so
      // allow all file-mutation tools while keeping shell/tool escalation out
      // of this profile.
      return ['--allowedTools', 'Edit,MultiEdit,Write'];
    case 'full-auto':
    case 'plan':
      return [];
  }
}

export const claudeSpec: AgentSpec = {
  id: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  defaultTimeoutMs: 600_000,
  buildArgs(_prompt, sessionId, context) {
    const args = [
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-mode',
      claudePermissionMode(context),
      ...claudePermissionToolArgs(context),
    ];
    const addDir = context?.permission
      ? permissionTargetDirectory(context.permission.target)
      : null;
    if (addDir) args.push('--add-dir', addDir);
    if (sessionId) args.push('--resume', sessionId);
    return args;
  },
  buildStdin(prompt) {
    return prompt;
  },
  buildEnv() {
    return shouldCaptureClaudeQuotaHeaders() ? { ANTHROPIC_LOG: 'debug' } : {};
  },
  parseStreamLine(line, stream): AgentStreamEvent[] {
    const debugQuotaUsage = claudeDebugQuotaUsage(line);
    if (debugQuotaUsage) {
      return [
        {
          kind: 'usage',
          status: 'info',
          label: 'claude rate limit headers',
          detail: formatContextUsage(debugQuotaUsage),
          contextUsage: debugQuotaUsage,
        },
      ];
    }
    if (stream === 'stderr') {
      if (isClaudeDebugLine(line)) {
        return [{ kind: 'event', status: 'running', label: 'claude status' }];
      }
      return [];
    }
    return claudeStreamEvents(line);
  },
  parseOutput(stdout, stderr): AgentReply {
    const raw = sanitizeClaudeRaw(stdout, stderr);
    if (!stdout.trim()) {
      throw new AgentParseError('claude', 'empty stdout', raw.stdout, raw.stderr);
    }
    const promptTooLongReason = claudePromptTooLongReason(stdout);
    if (promptTooLongReason) {
      throw new AgentParseError(
        'claude',
        `prompt too long (${promptTooLongReason})`,
        raw.stdout,
        raw.stderr,
      );
    }
    const streamed = parseClaudeStreamReply(stdout);
    if (streamed) {
      return { text: streamed.text, sessionId: streamed.sessionId, raw };
    }
    // Claude can emit a session-startup greeting (per CLAUDE.md instructions)
    // before the JSON object on stdout. Use a tolerant extractor so the
    // adapter does not crash on that preamble.
    const parsed = extractTopLevelJsonObject(stdout);
    if (!parsed || typeof parsed !== 'object') {
      throw new AgentParseError(
        'claude',
        'no top-level JSON object found in stdout',
        raw.stdout,
        raw.stderr,
      );
    }
    const obj = parsed as Record<string, unknown>;
    const text = typeof obj[RESULT_FIELD] === 'string' ? (obj[RESULT_FIELD] as string) : null;
    const sessionId =
      typeof obj[SESSION_FIELD] === 'string' ? (obj[SESSION_FIELD] as string) : null;
    if (text === null) {
      throw new AgentParseError(
        'claude',
        `missing field "${RESULT_FIELD}" in output`,
        raw.stdout,
        raw.stderr,
      );
    }
    return { text, sessionId, raw };
  },
};
