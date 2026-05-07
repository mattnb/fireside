import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

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
  quota?: AgentQuotaUsage;
  quotaOnly?: boolean;
  source: string;
}

export interface AgentQuotaWindowUsage {
  percent?: number;
  windowMinutes?: number;
  resetsAt?: number;
  status?: string;
}

export interface AgentQuotaUsage {
  fiveHour?: AgentQuotaWindowUsage;
  sevenDay?: AgentQuotaWindowUsage;
  daily?: AgentQuotaWindowUsage;
  planType?: string;
  rateLimitReachedType?: string | null;
  representativeClaim?: string;
  overageStatus?: string;
  source: string;
}

interface CodexConfig {
  model?: string;
  reasoningEffort?: string;
  contextWindow?: number;
  autoCompactAtTokens?: number;
  source: string;
}

interface CodexRolloutTokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens: number;
  contextWindow?: number;
  quota?: AgentQuotaUsage;
  source: string;
}

const CODEX_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/^gpt-5\.5$/i, 400_000],
  [/^gpt-5(?:\.[0-9]+)?(?:-[a-z0-9]+)*$/i, 400_000],
  [/^gpt-5(?:\.[1-5])?-codex$/i, 400_000],
];

const GEMINI_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/^gemini-3(?:\.\d+)?-(?:pro|flash|flash-lite)-preview$/i, 1_000_000],
  [/^gemini-/i, 1_000_000],
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boundedPercent(value: unknown): number | undefined {
  const number = numberValue(value) ?? positiveInteger(value);
  if (number === undefined) return undefined;
  return Math.max(0, Math.min(100, number));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

function effectiveCodexUsedTokens(
  inputTokens: number,
  cachedInputTokens: number | undefined,
  outputTokens: number,
  contextWindow: number | undefined,
): {
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
  const home = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function codexStatePath(codexHome = defaultCodexHome()): string {
  return path.join(codexHome, 'state_5.sqlite');
}

function codexSessionsDir(codexHome = defaultCodexHome()): string {
  return path.join(codexHome, 'sessions');
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

function readCodexRolloutPathFromState(
  threadId: string,
  codexHome = defaultCodexHome(),
): string | null {
  const statePath = codexStatePath(codexHome);
  if (!fs.existsSync(statePath)) return null;
  try {
    const db = new Database(statePath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare(`SELECT rollout_path FROM threads WHERE id = ?`).get(threadId) as
        | { rollout_path?: unknown }
        | undefined;
      return typeof row?.rollout_path === 'string' && row.rollout_path ? row.rollout_path : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function findCodexRolloutPath(threadId: string, codexHome = defaultCodexHome()): string | null {
  const fromState = readCodexRolloutPathFromState(threadId, codexHome);
  if (fromState && fs.existsSync(fromState)) return fromState;

  const root = codexSessionsDir(codexHome);
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.includes(threadId) &&
        entry.name.startsWith('rollout-') &&
        entry.name.endsWith('.jsonl')
      ) {
        return fullPath;
      }
    }
  }
  return null;
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  return numberValue(record[key]) ?? positiveInteger(record[key]);
}

function epochMs(value: unknown): number | undefined {
  const number = numberValue(value) ?? positiveInteger(value);
  if (number === undefined) return undefined;
  return number > 10_000_000_000 ? number : number * 1000;
}

function parseQuotaWindow(
  raw: unknown,
  percentKeys: string[],
  windowMinutes?: number,
): AgentQuotaWindowUsage | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  let percent: number | undefined;
  for (const key of percentKeys) {
    percent = boundedPercent(record[key]);
    if (percent !== undefined) break;
  }
  if (percent === undefined) return undefined;
  const configuredWindow =
    positiveInteger(record.window_minutes) ??
    positiveInteger(record.windowMinutes) ??
    windowMinutes;
  const resetsAt = epochMs(record.resets_at ?? record.resetsAt);
  return {
    percent,
    ...(configuredWindow !== undefined ? { windowMinutes: configuredWindow } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function parseCodexQuota(raw: unknown, source: string): AgentQuotaUsage | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const primary = parseQuotaWindow(record.primary, ['used_percent', 'usedPercentage'], 300);
  const secondary = parseQuotaWindow(record.secondary, ['used_percent', 'usedPercentage'], 10_080);
  if (!primary && !secondary) return undefined;
  const planType = typeof record.plan_type === 'string' ? record.plan_type : undefined;
  const rateLimitReachedType =
    typeof record.rate_limit_reached_type === 'string'
      ? record.rate_limit_reached_type
      : record.rate_limit_reached_type === null
        ? null
        : undefined;
  return {
    ...(primary ? { fiveHour: primary } : {}),
    ...(secondary ? { sevenDay: secondary } : {}),
    ...(planType ? { planType } : {}),
    ...(rateLimitReachedType !== undefined ? { rateLimitReachedType } : {}),
    source,
  };
}

function parseClaudeQuota(raw: unknown, source: string): AgentQuotaUsage | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const fiveHour = parseQuotaWindow(record.five_hour ?? record.fiveHour, ['used_percentage'], 300);
  const sevenDay = parseQuotaWindow(
    record.seven_day ?? record.sevenDay,
    ['used_percentage'],
    10_080,
  );
  if (!fiveHour && !sevenDay) return undefined;
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    source,
  };
}

function parseClaudeRateLimitInfo(raw: unknown, source: string): AgentQuotaUsage | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const rateLimitType =
    typeof record.rateLimitType === 'string'
      ? record.rateLimitType
      : typeof record.rate_limit_type === 'string'
        ? record.rate_limit_type
        : '';
  const resetsAt = epochMs(record.resetsAt ?? record.resets_at);
  const status = typeof record.status === 'string' ? record.status : undefined;
  const window: AgentQuotaWindowUsage = {
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(status ? { status } : {}),
  };
  if (Object.keys(window).length === 0) return undefined;
  if (rateLimitType === 'five_hour') {
    return { fiveHour: { ...window, windowMinutes: 300 }, source };
  }
  if (rateLimitType === 'seven_day') {
    return { sevenDay: { ...window, windowMinutes: 10_080 }, source };
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function debugHeaderValue(raw: string, header: string): string | undefined {
  const headerPattern = escapeRegExp(header);
  const jsonMatch = raw.match(new RegExp(`"${headerPattern}"\\s*:\\s*"([^"]+)"`, 'i'));
  if (jsonMatch?.[1]) return jsonMatch[1].trim();
  const bareMatch = raw.match(
    new RegExp(`(?:^|[\\s,{])${headerPattern}\\s*[:=]\\s*"?([^"\\s,}]+)"?`, 'im'),
  );
  return bareMatch?.[1]?.trim();
}

function utilizationPercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const percent = parsed <= 1 ? parsed * 100 : parsed;
  return Math.max(0, Math.min(100, percent));
}

function parseClaudeDebugQuotaWindow(
  raw: string,
  key: '5h' | '7d',
  windowMinutes: number,
): AgentQuotaWindowUsage | undefined {
  const prefix = `anthropic-ratelimit-unified-${key}`;
  const percent = utilizationPercent(debugHeaderValue(raw, `${prefix}-utilization`));
  const resetsAt = epochMs(debugHeaderValue(raw, `${prefix}-reset`));
  const status = stringValue(debugHeaderValue(raw, `${prefix}-status`));
  if (percent === undefined && resetsAt === undefined && status === undefined) return undefined;
  return {
    ...(percent !== undefined ? { percent } : {}),
    windowMinutes,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(status ? { status } : {}),
  };
}

function parseClaudeDebugQuotaHeaders(raw: string, source: string): AgentQuotaUsage | undefined {
  if (!raw.includes('anthropic-ratelimit-unified-')) return undefined;
  const fiveHour = parseClaudeDebugQuotaWindow(raw, '5h', 300);
  const sevenDay = parseClaudeDebugQuotaWindow(raw, '7d', 10_080);
  if (!fiveHour && !sevenDay) return undefined;
  const representativeClaim = stringValue(
    debugHeaderValue(raw, 'anthropic-ratelimit-unified-representative-claim'),
  );
  const overageStatus = stringValue(
    debugHeaderValue(raw, 'anthropic-ratelimit-unified-overage-status'),
  );
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(representativeClaim ? { representativeClaim } : {}),
    ...(overageStatus ? { overageStatus } : {}),
    source,
  };
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/[\u2500-\u257f]/g, ' ')
    .replace(/\r/g, '\n');
}

function parseDurationToMs(raw: string): number | undefined {
  const normalized = raw.toLowerCase().replace(/,/g, ' ').trim();
  if (!normalized || /^now\b/.test(normalized)) return 0;
  const pattern = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/g;
  let total = 0;
  let matched = false;
  for (const match of normalized.matchAll(pattern)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) continue;
    const unit = match[2] ?? '';
    matched = true;
    if (unit.startsWith('d')) total += amount * 86_400_000;
    else if (unit.startsWith('h')) total += amount * 3_600_000;
    else if (unit.startsWith('m')) total += amount * 60_000;
    else if (unit.startsWith('s')) total += amount * 1000;
  }
  return matched ? Math.max(0, Math.trunc(total)) : undefined;
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

function boundedPercentNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(100, parsed));
}

function resetFromText(text: string, now: number): number | undefined {
  const duration = firstMatch(text, [
    /resets?\s+(?:in|after)\s+([0-9.,\sA-Za-z]+?)(?:\b(?:status|quota|model|requests?)\b|$)/i,
    /reset\s*time\s*[:=]\s*([0-9.,\sA-Za-z]+?)(?:\b(?:status|quota|model|requests?)\b|$)/i,
  ]);
  const durationMs = parseDurationToMs(duration ?? '');
  return durationMs === undefined ? undefined : now + durationMs;
}

function statusFromGeminiStatsText(text: string): string | undefined {
  const lowered = text.toLowerCase();
  if (/\b(over\s+quota|quota\s+exceeded|exhausted|blocked|denied|rejected)\b/.test(lowered)) {
    return 'limited';
  }
  if (/\b(rate\s+limited|capacity|temporarily\s+unavailable)\b/.test(lowered)) {
    return 'limited';
  }
  if (/\b(allowed|available|ok)\b/.test(lowered)) return 'allowed';
  return undefined;
}

export function geminiStatsModelQuotaUsage(
  raw: string,
  opts: { now?: number; fallbackModel?: string } = {},
): AgentContextUsage | null {
  const text = stripAnsi(raw)
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (!text || !/(\/stats|model\s+stats|quota|remaining|requests?|rate\s+limit)/i.test(text)) {
    return null;
  }
  const compact = text.replace(/\s+/g, ' ');
  const model =
    firstMatch(compact, [
      /\bModel(?:\s+ID)?\s*[:=]\s*([A-Za-z0-9_.:-]*gemini[A-Za-z0-9_.:-]*)/i,
      /\b(gemini-[A-Za-z0-9_.:-]+)/i,
    ]) ??
    opts.fallbackModel ??
    'gemini';

  let percent = boundedPercentNumber(
    firstMatch(compact, [
      /\bquota(?:\s+usage|\s+used)?\s*[:=]\s*(\d+(?:\.\d+)?)\s*%/i,
      /\b(\d+(?:\.\d+)?)\s*%\s*(?:used|usage|of\s+(?:daily\s+)?quota)/i,
      /\bused\s*[:=]\s*(\d+(?:\.\d+)?)\s*%/i,
    ]),
  );

  const usedLimit = compact.match(/\b(\d[\d,]*)\s*(?:\/|of)\s*(\d[\d,]*)\s*(?:requests?|reqs?)\b/i);
  if (percent === undefined && usedLimit?.[1] && usedLimit[2]) {
    const used = Number(usedLimit[1].replace(/,/g, ''));
    const limit = Number(usedLimit[2].replace(/,/g, ''));
    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
      percent = Math.max(0, Math.min(100, (used / limit) * 100));
    }
  }

  const remainingLimit = compact.match(
    /\b(\d[\d,]*)\s*(?:requests?\s*)?remaining\b.{0,80}?\b(?:of|limit|quota)\D{0,20}(\d[\d,]*)\b/i,
  );
  if (percent === undefined && remainingLimit?.[1] && remainingLimit[2]) {
    const remaining = Number(remainingLimit[1].replace(/,/g, ''));
    const limit = Number(remainingLimit[2].replace(/,/g, ''));
    if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
      percent = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
    }
  }

  const now = opts.now ?? Date.now();
  const resetsAt = resetFromText(compact, now);
  const status = statusFromGeminiStatsText(compact);
  if (percent === undefined && resetsAt === undefined && status === undefined) return null;

  const daily: AgentQuotaWindowUsage = {
    windowMinutes: 1_440,
    ...(percent !== undefined ? { percent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(status ? { status } : {}),
  };
  return {
    provider: 'gemini',
    model,
    usedTokens: 0,
    quotaOnly: true,
    quota: {
      daily,
      source: 'gemini:stats-model',
    },
    source: 'gemini:stats-model',
  };
}

function parseCodexRolloutTokenLine(line: string, source: string): CodexRolloutTokenUsage | null {
  if (!line.includes('"token_count"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  const payload = asRecord(root?.payload);
  if (payload?.type !== 'token_count') return null;
  const info = asRecord(payload.info);
  const last = asRecord(info?.last_token_usage);
  if (!last) return null;

  const inputTokens = numberFromRecord(last, 'input_tokens');
  const cachedInputTokens = numberFromRecord(last, 'cached_input_tokens');
  const outputTokens = numberFromRecord(last, 'output_tokens');
  const reasoningOutputTokens = numberFromRecord(last, 'reasoning_output_tokens');
  const totalTokens =
    numberFromRecord(last, 'total_tokens') ?? Math.max(0, (inputTokens ?? 0) + (outputTokens ?? 0));
  const contextWindow = positiveInteger(info?.model_context_window);
  const quota = parseCodexQuota(payload.rate_limits, source);
  if (totalTokens <= 0 && contextWindow === undefined) return null;

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    totalTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(quota ? { quota } : {}),
    source,
  };
}

export function readLatestCodexRolloutTokenUsage(
  threadId: string | undefined,
  codexHome = defaultCodexHome(),
): CodexRolloutTokenUsage | null {
  if (!threadId) return null;
  const rolloutPath = findCodexRolloutPath(threadId, codexHome);
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return null;

  let latest: CodexRolloutTokenUsage | null = null;
  try {
    const content = fs.readFileSync(rolloutPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseCodexRolloutTokenLine(line, `rollout:${rolloutPath}`);
      if (parsed) latest = parsed;
    }
  } catch {
    return null;
  }
  return latest;
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
      envModel || envReasoning || envContextWindow || envAutoCompact ? `${source}+env` : source,
  };
}

export function codexContextWindowForModel(model: string | undefined): number | undefined {
  if (!model) return undefined;
  for (const [pattern, contextWindow] of CODEX_CONTEXT_WINDOWS) {
    if (pattern.test(model)) return contextWindow;
  }
  return undefined;
}

export function geminiContextWindowForModel(model: string | undefined): number | undefined {
  if (!model) return undefined;
  for (const [pattern, contextWindow] of GEMINI_CONTEXT_WINDOWS) {
    if (pattern.test(model)) return contextWindow;
  }
  return undefined;
}

export function codexContextUsage(
  rawUsage: unknown,
  opts: { threadId?: string; codexHome?: string } = {},
): AgentContextUsage | null {
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
  const rollout = readLatestCodexRolloutTokenUsage(opts.threadId, opts.codexHome);
  const quota = rollout?.quota ?? parseCodexQuota(usage.rate_limits, 'codex:usage');
  const configuredContextWindow = config.contextWindow ?? codexContextWindowForModel(model);
  if (rollout) {
    const reportedUsedTokens = Math.max(0, (inputTokens ?? 0) + (outputTokens ?? 0));
    return addWindowFields({
      provider: 'codex',
      model,
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      usedTokens: rollout.totalTokens,
      ...(reportedUsedTokens > 0 && reportedUsedTokens !== rollout.totalTokens
        ? { reportedUsedTokens }
        : {}),
      ...(rollout.inputTokens !== undefined ? { inputTokens: rollout.inputTokens } : {}),
      ...(rollout.cachedInputTokens !== undefined
        ? { cachedInputTokens: rollout.cachedInputTokens }
        : {}),
      ...(rollout.outputTokens !== undefined ? { outputTokens: rollout.outputTokens } : {}),
      ...(rollout.reasoningOutputTokens !== undefined
        ? { reasoningOutputTokens: rollout.reasoningOutputTokens }
        : {}),
      ...(quota ? { quota } : {}),
      ...(rollout.contextWindow !== undefined
        ? { contextWindow: rollout.contextWindow }
        : configuredContextWindow !== undefined
          ? { contextWindow: configuredContextWindow }
          : {}),
      ...(config.autoCompactAtTokens !== undefined
        ? { autoCompactAtTokens: config.autoCompactAtTokens }
        : {}),
      source: `${rollout.source}:last-token-usage`,
    });
  }

  const contextWindow = configuredContextWindow;
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
    ...(quota ? { quota } : {}),
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
  const quota = parseClaudeQuota(obj.rate_limits ?? obj.rateLimits, 'claude:rate_limits');
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
    ...(quota ? { quota } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    source: `claude:${asRecord(obj.usage) ? 'usage' : 'modelUsage'}${
      effective.estimated ? ':cache-adjusted' : ''
    }`,
  });
}

export function claudeQuotaUsage(obj: Record<string, unknown>): AgentContextUsage | null {
  const quota =
    parseClaudeQuota(obj.rate_limits ?? obj.rateLimits, 'claude:rate_limits') ??
    parseClaudeRateLimitInfo(obj.rate_limit_info ?? obj.rateLimitInfo, 'claude:rate_limit_info');
  if (!quota) return null;
  const model =
    typeof obj.model === 'string'
      ? obj.model
      : typeof obj.model_id === 'string'
        ? obj.model_id
        : 'claude';
  return {
    provider: 'claude',
    model,
    usedTokens: 0,
    quota,
    quotaOnly: true,
    source: quota.source,
  };
}

export function claudeDebugQuotaUsage(raw: string, model = 'claude'): AgentContextUsage | null {
  const quota = parseClaudeDebugQuotaHeaders(raw, 'claude:debug-rate-limit-headers');
  if (!quota) return null;
  return {
    provider: 'claude',
    model,
    usedTokens: 0,
    quota,
    quotaOnly: true,
    source: quota.source,
  };
}

export function geminiContextUsage(obj: Record<string, unknown>): AgentContextUsage | null {
  const stats = asRecord(obj.stats) ?? obj;
  const usage = asRecord(stats.usage_metadata) ?? asRecord(stats.usageMetadata);
  const models = asRecord(stats.models);
  const firstModelEntry = models
    ? Object.entries(models).find(([, value]) => asRecord(value))
    : undefined;
  if (usage) {
    const inputTokens =
      numberFromRecord(usage, 'input_token_count') ?? numberFromRecord(usage, 'inputTokenCount');
    const outputTokens =
      numberFromRecord(usage, 'output_token_count') ?? numberFromRecord(usage, 'outputTokenCount');
    const cachedInputTokens =
      numberFromRecord(usage, 'cached_content_token_count') ??
      numberFromRecord(usage, 'cachedContentTokenCount');
    const usedTokens =
      numberFromRecord(usage, 'total_token_count') ??
      numberFromRecord(usage, 'totalTokenCount') ??
      Math.max(0, (inputTokens ?? 0) + (outputTokens ?? 0));
    if (usedTokens > 0) {
      const model = stringValue(stats.model) ?? stringValue(obj.model) ?? 'gemini';
      const contextWindow = geminiContextWindowForModel(model);
      return addWindowFields({
        provider: 'gemini',
        model,
        usedTokens,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        source: 'gemini:stats.usage_metadata',
      });
    }
  }

  const directInputTokens =
    numberFromRecord(stats, 'input_tokens') ??
    numberFromRecord(stats, 'inputTokenCount') ??
    numberFromRecord(stats, 'input');
  const directOutputTokens =
    numberFromRecord(stats, 'output_tokens') ??
    numberFromRecord(stats, 'outputTokenCount') ??
    numberFromRecord(stats, 'output');
  const directCachedInputTokens =
    numberFromRecord(stats, 'cached_content_token_count') ??
    numberFromRecord(stats, 'cachedContentTokenCount') ??
    numberFromRecord(stats, 'cached_input_tokens') ??
    numberFromRecord(stats, 'cachedInputTokens') ??
    numberFromRecord(stats, 'cached');
  const directUsedTokens =
    numberFromRecord(stats, 'total_tokens') ??
    numberFromRecord(stats, 'totalTokenCount') ??
    numberFromRecord(stats, 'total') ??
    Math.max(0, (directInputTokens ?? 0) + (directOutputTokens ?? 0));
  if (directUsedTokens > 0) {
    const model =
      stringValue(stats.model) ??
      stringValue(obj.model) ??
      (firstModelEntry ? firstModelEntry[0] : undefined) ??
      'gemini';
    const contextWindow = geminiContextWindowForModel(model);
    return addWindowFields({
      provider: 'gemini',
      model,
      usedTokens: directUsedTokens,
      ...(directInputTokens !== undefined ? { inputTokens: directInputTokens } : {}),
      ...(directCachedInputTokens !== undefined
        ? { cachedInputTokens: directCachedInputTokens }
        : {}),
      ...(directOutputTokens !== undefined ? { outputTokens: directOutputTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      source: 'gemini:stats.token_counts',
    });
  }

  if (!models) return null;
  for (const [model, rawModelStats] of Object.entries(models)) {
    const modelStats = asRecord(rawModelStats);
    const tokens = asRecord(modelStats?.tokens) ?? modelStats;
    if (!tokens) continue;
    const inputTokens =
      numberFromRecord(tokens, 'input') ?? numberFromRecord(tokens, 'input_tokens');
    const outputTokens =
      numberFromRecord(tokens, 'output') ?? numberFromRecord(tokens, 'output_tokens');
    const cachedInputTokens =
      numberFromRecord(tokens, 'cached') ?? numberFromRecord(tokens, 'cached_input_tokens');
    const usedTokens =
      numberFromRecord(tokens, 'total') ??
      numberFromRecord(tokens, 'total_tokens') ??
      Math.max(0, (inputTokens ?? 0) + (outputTokens ?? 0));
    if (usedTokens <= 0) continue;
    const contextWindow = geminiContextWindowForModel(model);
    return addWindowFields({
      provider: 'gemini',
      model,
      usedTokens,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      source: 'gemini:stats.models.tokens',
    });
  }
  return null;
}

export function formatContextUsage(usage: AgentContextUsage): string {
  const quota = usage.quota ? formatQuotaUsage(usage.quota) : '';
  if (usage.quotaOnly) return quota || `${usage.model}: quota update`;
  const used = `${usage.usedTokens}${usage.estimated ? ' estimated' : ''} used`;
  const window = usage.contextWindow ? `${usage.contextWindow} window` : 'window unknown';
  const model = usage.reasoningEffort ? `${usage.model}/${usage.reasoningEffort}` : usage.model;
  const cacheParts = [
    usage.cacheReadInputTokens ? `cache_read_input_tokens ${usage.cacheReadInputTokens}` : '',
    usage.cacheCreationInputTokens
      ? `cache_creation_input_tokens ${usage.cacheCreationInputTokens}`
      : '',
  ].filter(Boolean);
  const cache = cacheParts.length > 0 ? ` / ${cacheParts.join(' / ')}` : '';
  return `${model}: ${used} / ${window}${cache}${quota ? ` / ${quota}` : ''}`;
}

export function formatQuotaUsage(quota: AgentQuotaUsage): string {
  const parts: string[] = [];
  if (quota.fiveHour) {
    parts.push(
      quota.fiveHour.percent !== undefined
        ? `5h ${Math.round(quota.fiveHour.percent)}%`
        : '5h reset tracked',
    );
  }
  if (quota.sevenDay) {
    parts.push(
      quota.sevenDay.percent !== undefined
        ? `7d ${Math.round(quota.sevenDay.percent)}%`
        : '7d reset tracked',
    );
  }
  if (quota.daily) {
    parts.push(
      quota.daily.percent !== undefined
        ? `1d ${Math.round(quota.daily.percent)}%`
        : '1d reset tracked',
    );
  }
  if (quota.planType) parts.push(quota.planType);
  return parts.length > 0 ? `quota ${parts.join(' / ')}` : 'quota update';
}
