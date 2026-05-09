import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { ProviderId } from '../../agents/types.js';
import type { PermissionGrant } from '../../permissions.js';
import type { Task } from '../../repos/tasks.js';
import { getTask } from '../../repos/tasks.js';
import type { MissionTaskApplyResult } from '../../mission-state/mission-task-applicator.js';
import { executeToolCall } from '../execute-tool-call.js';
import { ensureDefaultToolsRegistered } from '../default-tools.js';
import { defaultToolRegistry, type ToolRegistry } from '../registry.js';
import type { AgentToolCall, ExecuteToolCallOutcome } from '../types.js';

interface NativeProviderToolCall {
  providerToolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface DecodeProviderToolCallsInput {
  providerId: ProviderId;
  stdout: string;
  roomId: string;
  missionId: string | null;
  runId: string | null;
  messageId?: string | null;
  agentId: string;
  registry?: ToolRegistry;
  now?: () => number;
  newCallId?: () => string;
}

export interface ProviderToolRoutingContext {
  db: Database;
  providerId: ProviderId;
  stdout: string;
  roomId: string;
  mission: Task | null;
  runId: string;
  messageId?: string | null;
  agentId: string;
  permission?: PermissionGrant | null;
  registry?: ToolRegistry;
  now?: () => number;
  newCallId?: () => string;
  onTaskUpdated?: (task: Task) => void;
}

export interface ProviderToolRoutingOutcome {
  toolCalls: ExecuteToolCallOutcome[];
  toolNames: Set<string>;
  hiddenFallbackKeys: Set<string>;
  missionTaskResult: MissionTaskApplyResult;
}

export function decodeProviderToolCalls(input: DecodeProviderToolCallsInput): AgentToolCall[] {
  ensureDefaultToolsRegistered();
  const registry = input.registry ?? defaultToolRegistry;
  const now = input.now ?? Date.now;
  const newCallId = input.newCallId ?? (() => nanoid(16));
  const calls = extractNativeProviderToolCalls(input.providerId, input.stdout).flatMap((call) => {
    const canonicalName = resolveProviderToolName(call.name, registry);
    return canonicalName ? [{ ...call, name: canonicalName }] : [];
  });

  return calls.map((call) => {
    const idempotencyKey = providerToolIdempotencyKey(input.runId, call.providerToolCallId);
    return {
      id: newCallId(),
      tool: call.name,
      idempotencyKey,
      args: call.args,
      source: 'provider-tool-call',
      roomId: input.roomId,
      missionId: input.missionId,
      runId: input.runId,
      messageId: input.messageId ?? null,
      agentId: input.agentId,
      createdAt: now(),
    };
  });
}

export async function routeProviderToolCalls(
  ctx: ProviderToolRoutingContext,
): Promise<ProviderToolRoutingOutcome> {
  const calls = decodeProviderToolCalls({
    providerId: ctx.providerId,
    stdout: ctx.stdout,
    roomId: ctx.roomId,
    missionId: ctx.mission?.id ?? null,
    runId: ctx.runId,
    messageId: ctx.messageId ?? null,
    agentId: ctx.agentId,
    ...(ctx.registry ? { registry: ctx.registry } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
    ...(ctx.newCallId ? { newCallId: ctx.newCallId } : {}),
  });
  const toolCalls: ExecuteToolCallOutcome[] = [];
  const toolNames = new Set<string>();
  const hiddenFallbackKeys = new Set<string>();
  const missionTaskResult: MissionTaskApplyResult = {
    applied: 0,
    progressed: 0,
    dispatchCandidates: [],
  };

  for (const call of calls) {
    toolNames.add(call.tool);
    const hiddenFallbackKey = hiddenFallbackKeyForProviderCall(call);
    if (hiddenFallbackKey) hiddenFallbackKeys.add(hiddenFallbackKey);
    const outcome = await executeToolCall({
      db: ctx.db,
      call,
      ...(ctx.registry ? { registry: ctx.registry } : {}),
      ...(ctx.permission
        ? { permission: ctx.permission }
        : {
            statePermissions: [
              'mission:read',
              'mission:write',
              'mission:admin',
              'collab:write',
              'permission:request',
              'agent:write-self',
              'search:read',
            ],
          }),
      ...(ctx.now ? { now: ctx.now } : {}),
    });
    toolCalls.push(outcome);
    accumulateMissionTaskOutcome(missionTaskResult, call.tool, outcome);
    if (
      outcome.status === 'applied' &&
      call.tool.startsWith('mission.') &&
      ctx.mission &&
      ctx.onTaskUpdated
    ) {
      const refreshed = getTask(ctx.db, ctx.mission.id);
      if (refreshed) ctx.onTaskUpdated(refreshed);
    }
  }

  return { toolCalls, toolNames, hiddenFallbackKeys, missionTaskResult };
}

export function providerToolIdempotencyKey(
  runId: string | null,
  providerToolCallId: string,
): string {
  return `${runId ?? 'runless'}:provider-tool-call:${providerToolCallId}`;
}

function extractNativeProviderToolCalls(
  providerId: ProviderId,
  stdout: string,
): NativeProviderToolCall[] {
  const rawCalls: NativeProviderToolCall[] = [];
  for (const obj of parseJsonLines(stdout)) {
    if (providerId === 'claude') {
      rawCalls.push(...extractClaudeToolCalls(obj));
    } else if (providerId === 'codex') {
      rawCalls.push(...extractCodexToolCalls(obj));
    }
  }
  return dedupeProviderCalls(rawCalls);
}

function resolveProviderToolName(name: string, registry: ToolRegistry): string | null {
  if (registry.has(name)) return name;
  const unprefixed = name.includes('__') ? name.split('__').at(-1)! : name;
  for (const tool of registry.list()) {
    const providerName = tool.name.replace(/\./g, '_');
    if (name === providerName || unprefixed === providerName) return tool.name;
  }
  return null;
}

function extractClaudeToolCalls(obj: Record<string, unknown>): NativeProviderToolCall[] {
  const calls: NativeProviderToolCall[] = [];
  // This bridge observes Claude CLI stdout only; tool_result continuation belongs
  // in the future API/MCP execution loop that actively drives provider turns.
  // We pull tool_use blocks ONLY from the final `assistant` event — never from
  // streaming `content_block_start`, which always carries an empty `input: {}`
  // (the args arrive incrementally via input_json_delta). Attempting to route
  // the partial state through executeToolCall produced empty-args rejection
  // rows for every MCP-routed turn until 2026-05-09.
  const type = stringValue(obj.type);
  if (type === 'assistant') {
    const message = asRecord(obj.message);
    calls.push(...extractClaudeContentBlocks(message?.content ?? obj.content));
  }
  return calls;
}

function extractClaudeContentBlocks(value: unknown): NativeProviderToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: NativeProviderToolCall[] = [];
  for (const block of value) {
    const obj = asRecord(block);
    if (!obj || stringValue(obj.type) !== 'tool_use') continue;
    const name = stringValue(obj.name);
    if (!name) continue;
    // MCP-routed tool calls (`mcp__<server>__<tool>`) are already executed
    // end-to-end through the MCP HTTP endpoint by the spawned Claude CLI;
    // re-routing the same tool_use record through executeToolCall would
    // double-execute on success or, when args fail validation here despite
    // succeeding via MCP, log a misleading rejection row. Skip them so the
    // provider-tool-call path stays scoped to native (non-MCP) tools only.
    if (name.startsWith('mcp__')) continue;
    const args = argsRecord(obj.input);
    const providerToolCallId =
      stringValue(obj.id) || fallbackProviderToolCallId('claude', name, args);
    calls.push({ providerToolCallId, name, args });
  }
  return calls;
}

function extractCodexToolCalls(obj: Record<string, unknown>): NativeProviderToolCall[] {
  const calls: NativeProviderToolCall[] = [];
  const item = asRecord(obj.item);
  if (item) calls.push(...extractOpenAiStyleToolCalls(item));
  calls.push(...extractOpenAiStyleToolCalls(obj));
  return calls;
}

function extractOpenAiStyleToolCalls(obj: Record<string, unknown>): NativeProviderToolCall[] {
  const calls: NativeProviderToolCall[] = [];
  const toolCalls = obj.tool_calls ?? asRecord(obj.message)?.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const raw of toolCalls) {
      const toolCall = asRecord(raw);
      const fn = asRecord(toolCall?.function);
      const name = stringValue(fn?.name) || stringValue(toolCall?.name);
      if (!toolCall || !name) continue;
      const args = argsRecord(fn?.arguments ?? toolCall.arguments);
      const providerToolCallId =
        stringValue(toolCall.id) ||
        stringValue(toolCall.call_id) ||
        fallbackProviderToolCallId('codex', name, args);
      calls.push({ providerToolCallId, name, args });
    }
  }

  const itemType = stringValue(obj.type);
  if (
    itemType === 'function_call' ||
    itemType === 'tool_call' ||
    itemType === 'custom_tool_call' ||
    itemType.endsWith('_tool_call')
  ) {
    const fn = asRecord(obj.function);
    const name = stringValue(obj.name) || stringValue(fn?.name);
    if (name) {
      const args = argsRecord(obj.arguments ?? fn?.arguments ?? obj.input);
      const providerToolCallId =
        stringValue(obj.call_id) ||
        stringValue(obj.id) ||
        stringValue(obj.tool_call_id) ||
        fallbackProviderToolCallId('codex', name, args);
      calls.push({ providerToolCallId, name, args });
    }
  }

  return calls;
}

function accumulateMissionTaskOutcome(
  target: MissionTaskApplyResult,
  toolName: string,
  outcome: ExecuteToolCallOutcome,
): void {
  if (outcome.status !== 'applied') return;
  if (toolName === 'mission.task.update') {
    const data = outcome.result?.data as MissionTaskApplyResult | undefined;
    if (!data) return;
    target.applied += data.applied;
    target.progressed += data.progressed;
    target.dispatchCandidates.push(...data.dispatchCandidates);
  } else if (toolName === 'mission.task.add_note') {
    target.applied += 1;
  }
}

function hiddenFallbackKeyForProviderCall(call: AgentToolCall): string | null {
  if (call.tool === 'mission.task.add_note') {
    const target = firstStringArg(call.args, 'taskId', 'task_id', 'id', 'itemId', 'item_id');
    return target ? `${call.tool}\n${target}` : null;
  }
  if (call.tool === 'mission.task.update') {
    const target = firstStringArg(
      call.args,
      'taskId',
      'task_id',
      'id',
      'itemId',
      'item_id',
      'title',
    );
    return target ? `${call.tool}\n${target}` : null;
  }
  return null;
}

function firstStringArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      const obj = asRecord(value);
      if (obj) parsed.push(obj);
    } catch {
      // Provider stdout may contain non-protocol lines; they are not tool calls.
    }
  }
  return parsed;
}

function argsRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      const obj = asRecord(parsed);
      return obj ? obj : {};
    } catch {
      return {};
    }
  }
  return asRecord(value) ?? {};
}

function dedupeProviderCalls(calls: NativeProviderToolCall[]): NativeProviderToolCall[] {
  const seen = new Set<string>();
  const deduped: NativeProviderToolCall[] = [];
  for (const call of calls) {
    const key = `${call.providerToolCallId}\n${call.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(call);
  }
  return deduped;
}

function fallbackProviderToolCallId(
  providerId: ProviderId,
  name: string,
  args: Record<string, unknown>,
): string {
  const hash = createHash('sha1')
    .update(`${providerId}\n${name}\n${stableStringify(args)}`)
    .digest('hex')
    .slice(0, 16);
  return `${providerId}:${hash}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
