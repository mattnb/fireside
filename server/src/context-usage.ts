import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AgentContextUsage {
  provider: string;
  model: string;
  reasoningEffort?: string;
  usedTokens: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
  autoCompactAtTokens?: number;
  remainingTokens?: number;
  percentUsed?: number;
  reportedUsedTokens?: number;
  estimated?: boolean;
  source: string;
}

interface CodexConfig {
  model?: string;
  reasoningEffort?: string;
  contextWindow?: number;
  autoCompactAtTokens?: number;
  source: string;
}

const CODEX_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/^gpt-5\.5$/i, 400_000],
  [/^gpt-5(?:\.[1-5])?-codex$/i, 400_000],
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

function addWindowFields<T extends AgentContextUsage>(usage: T): T {
  if (!usage.contextWindow || usage.contextWindow <= 0) return usage;
  const remainingTokens = Math.max(0, usage.contextWindow - usage.usedTokens);
  const percentUsed = Math.max(0, Math.min(100, (usage.usedTokens / usage.contextWindow) * 100));
  return { ...usage, remainingTokens, percentUsed };
}

function effectiveCodexUsedTokens(inputTokens: number, cachedInputTokens: number | undefined, outputTokens: number, contextWindow: number | undefined): {
  usedTokens: number;
  reportedUsedTokens?: number;
  estimated?: boolean;
} {
  const reportedUsedTokens = Math.max(0, inputTokens + outputTokens);
  if (!contextWindow || reportedUsedTokens <= contextWindow || cachedInputTokens === undefined) {
    return { usedTokens: reportedUsedTokens };
  }
  const adjustedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  return {
    usedTokens: Math.max(0, adjustedInputTokens + outputTokens),
    reportedUsedTokens,
    estimated: true,
  };
}

function effectiveClaudeUsedTokens(input: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow?: number;
}): { usedTokens: number; reportedUsedTokens?: number; estimated?: boolean } {
  const reportedUsedTokens = Math.max(
    0,
    input.inputTokens +
      input.outputTokens +
      input.cacheReadInputTokens +
      input.cacheCreationInputTokens,
  );
  if (!input.contextWindow || reportedUsedTokens <= input.contextWindow) {
    return { usedTokens: reportedUsedTokens };
  }
  return {
    usedTokens: Math.max(
      0,
      input.inputTokens + input.outputTokens + input.cacheCreationInputTokens,
    ),
    reportedUsedTokens,
    estimated: true,
  };
}

function defaultCodexConfigPath(): string {
  const home = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

function stripInlineComment(value: string): string {
  let quote: '"' | "'" | '' = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === '"' || char === "'") && value[i - 1] !== '\\') {
      quote = quote === char ? '' : quote || char;
      continue;
    }
    if (char === '#' && !quote) return value.slice(0, i).trim();
  }
  return value.trim();
}

function parseRootTomlValue(raw: string): string | number | undefined {
  const value = stripInlineComment(raw);
  const stringMatch = value.match(/^(['"])(.*)\1$/);
  if (stringMatch) return stringMatch[2] ?? '';
  const number = Number(value.replace(/_/g, ''));
  if (Number.isFinite(number)) return number;
  return undefined;
}

function readRootToml(content: string): Map<string, string | number> {
  const values = new Map<string, string | number>();
  let inRoot = true;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^\[.+\]$/.test(line)) {
      inRoot = false;
      continue;
    }
    if (!inRoot) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!match) continue;
    const key = match[1];
    const value = parseRootTomlValue(match[2] ?? '');
    if (key && value !== undefined) values.set(key, value);
  }
  return values;
}

export function readCodexConfig(configPath = defaultCodexConfigPath()): CodexConfig {
  const envModel = process.env.FIRESIDE_CODEX_MODEL;
  const envReasoning = process.env.FIRESIDE_CODEX_REASONING_EFFORT;
  const envContextWindow = positiveInteger(process.env.FIRESIDE_CODEX_CONTEXT_WINDOW);
  const envAutoCompact = positiveInteger(process.env.FIRESIDE_CODEX_AUTO_COMPACT_TOKENS);

  let fileValues = new Map<string, string | number>();
  let source = 'default';
  if (fs.existsSync(configPath)) {
    try {
      fileValues = readRootToml(fs.readFileSync(configPath, 'utf8'));
      source = `config:${configPath}`;
    } catch {
      source = `unreadable:${configPath}`;
    }
  }

  const fileModel = fileValues.get('model');
  const fileReasoning = fileValues.get('model_reasoning_effort');
  const fileContextWindow = fileValues.get('model_context_window');
  const fileAutoCompact = fileValues.get('model_auto_compact_token_limit');
  const model = envModel ?? (typeof fileModel === 'string' ? fileModel : undefined);
  const reasoningEffort =
    envReasoning ?? (typeof fileReasoning === 'string' ? fileReasoning : undefined);
  const contextWindow = envContextWindow ?? positiveInteger(fileContextWindow);
  const autoCompactAtTokens = envAutoCompact ?? positiveInteger(fileAutoCompact);

  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(autoCompactAtTokens !== undefined ? { autoCompactAtTokens } : {}),
    source:
      envModel || envReasoning || envContextWindow || envAutoCompact
        ? `${source}+env`
        : source,
  };
}

export function codexContextWindowForModel(model: string | undefined): number | undefined {
  if (!model) return undefined;
  for (const [pattern, contextWindow] of CODEX_CONTEXT_WINDOWS) {
    if (pattern.test(model)) return contextWindow;
  }
  return undefined;
}

export function codexContextUsage(rawUsage: unknown): AgentContextUsage | null {
  const usage = asRecord(rawUsage);
  if (!usage) return null;
  const inputTokens = numberValue(usage.input_tokens);
  const outputTokens = numberValue(usage.output_tokens);
  const reasoningOutputTokens = numberValue(usage.reasoning_output_tokens);
  const cachedInputTokens = numberValue(usage.cached_input_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined
  ) {
    return null;
  }

  const config = readCodexConfig();
  const model = config.model ?? 'codex';
  const contextWindow = config.contextWindow ?? codexContextWindowForModel(model);
  const effective = effectiveCodexUsedTokens(
    inputTokens ?? 0,
    cachedInputTokens,
    outputTokens ?? 0,
    contextWindow,
  );
  return addWindowFields({
    provider: 'codex',
    model,
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    usedTokens: effective.usedTokens,
    ...(effective.reportedUsedTokens !== undefined
      ? { reportedUsedTokens: effective.reportedUsedTokens }
      : {}),
    ...(effective.estimated ? { estimated: true } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(config.autoCompactAtTokens !== undefined
      ? { autoCompactAtTokens: config.autoCompactAtTokens }
      : {}),
    source: `${config.contextWindow ? config.source : `${config.source}:model-default`}${
      effective.estimated ? ':cached-adjusted' : ''
    }`,
  });
}

export function claudeContextUsage(obj: Record<string, unknown>): AgentContextUsage | null {
  const modelUsage = asRecord(obj.modelUsage);
  if (!modelUsage) return null;
  const firstEntry = Object.entries(modelUsage).find(([, value]) => asRecord(value));
  if (!firstEntry) return null;

  const [model, rawUsage] = firstEntry;
  const modelUsageRecord = asRecord(rawUsage);
  if (!modelUsageRecord) return null;
  const usage = asRecord(obj.usage) ?? modelUsageRecord;
  const inputTokens = numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens) ?? 0;
  const outputTokens = numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens) ?? 0;
  const cacheReadInputTokens =
    numberValue(usage.cache_read_input_tokens) ?? numberValue(usage.cacheReadInputTokens) ?? 0;
  const cacheCreationInputTokens =
    numberValue(usage.cache_creation_input_tokens) ??
    numberValue(usage.cacheCreationInputTokens) ??
    0;
  const contextWindow = numberValue(modelUsageRecord.contextWindow);
  const effective = effectiveClaudeUsedTokens({
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  });
  if (effective.usedTokens === 0 && contextWindow === undefined) return null;

  return addWindowFields({
    provider: 'claude',
    model,
    usedTokens: effective.usedTokens,
    ...(effective.reportedUsedTokens !== undefined
      ? { reportedUsedTokens: effective.reportedUsedTokens }
      : {}),
    ...(effective.estimated ? { estimated: true } : {}),
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    source: `claude:${asRecord(obj.usage) ? 'usage' : 'modelUsage'}${
      effective.estimated ? ':cache-adjusted' : ''
    }`,
  });
}

export function formatContextUsage(usage: AgentContextUsage): string {
  const used = `${usage.usedTokens}${usage.estimated ? ' estimated' : ''} used`;
  const window = usage.contextWindow ? `${usage.contextWindow} window` : 'window unknown';
  const model = usage.reasoningEffort
    ? `${usage.model}/${usage.reasoningEffort}`
    : usage.model;
  return `${model}: ${used} / ${window}`;
}
