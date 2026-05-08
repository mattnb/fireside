// server/src/config.ts
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  uiDir: string;
  maxPromptChars: number;
  largeMessageThresholdChars: number;
  resumeCliSessions: boolean;
  autoCompactEnabled: boolean;
  autoCompactPercent: number;
  autoCompactTokenLimit: number;
  /** Percentage of the standard auto-compact threshold at which the room
   *  lead deterministically resets its CLI session. Defaults to 60. */
  leadResetPercent: number;
  /** Kill-switch for the deterministic lead reset path. When true, leads fall
   *  back to the legacy `/compact` flow. */
  leadResetDisabled: boolean;
  /** Optional path to an MCP config JSON file forwarded to spawned
   *  `claude` subprocesses via `--mcp-config`. When unset, the spawned
   *  CLI inherits the operator's interactive Claude MCP configuration. */
  claudeMcpConfigPath: string | null;
  /** Default off. When true, Fireside registers `POST /api/mcp` so external
   *  MCP clients can invoke the structured tool layer. See
   *  docs/phase-6-mcp-endpoint-design-2026-05-07.md. */
  enableMcp: boolean;
  /** Optional bearer token. Required for non-loopback `/api/mcp` calls.
   *  When unset, non-loopback calls are refused even if `enableMcp` is on. */
  mcpApiKey: string | null;
}

function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function envNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseDotEnvValue(raw: string): string {
  let value = raw.trim();
  if (!value) return '';

  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (quoted) {
    value = value.slice(1, -1);
    if (raw.trim().startsWith('"')) {
      return value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    return value;
  }

  return value.replace(/\s+#.*$/, '').trim();
}

export function loadDotEnvFile(filePath = path.resolve(process.cwd(), '.env')): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = parseDotEnvValue(match[2] ?? '');
  }
}

export function loadConfig(): Config {
  loadDotEnvFile();
  const dataDir = process.env.FIRESIDE_DATA_DIR ?? path.resolve(process.cwd(), 'data');
  const angularUiDir = path.resolve(process.cwd(), 'dist/client/browser');
  const fallbackUiDir = path.resolve(process.cwd(), 'ui');
  const uiDir = process.env.FIRESIDE_UI_DIR ?? (existsSync(angularUiDir) ? angularUiDir : fallbackUiDir);
  return {
    port: Number(process.env.FIRESIDE_PORT ?? '8787'),
    host: process.env.FIRESIDE_HOST ?? '127.0.0.1',
    dataDir,
    dbFile: path.join(dataDir, 'fireside.sqlite'),
    uiDir: path.resolve(uiDir),
    maxPromptChars: envNumber('FIRESIDE_MAX_PROMPT_CHARS', 16_000),
    largeMessageThresholdChars: envNumber('FIRESIDE_LARGE_MESSAGE_CHARS', 6_000),
    resumeCliSessions: envFlag('FIRESIDE_RESUME_CLI_SESSIONS', true),
    autoCompactEnabled: envFlag('FIRESIDE_AUTO_COMPACT_ENABLED', true),
    autoCompactPercent: envNumber('FIRESIDE_AUTO_COMPACT_PERCENT', 70),
    autoCompactTokenLimit: envNumber('FIRESIDE_AUTO_COMPACT_TOKEN_LIMIT', 220_000),
    leadResetPercent: envNumber('FIRESIDE_LEAD_RESET_PERCENT', 60),
    leadResetDisabled: envFlag('FIRESIDE_LEAD_RESET_DISABLED', false),
    claudeMcpConfigPath: process.env.FIRESIDE_MCP_CONFIG?.trim() || null,
    enableMcp: envFlag('FIRESIDE_ENABLE_MCP', false),
    mcpApiKey: process.env.FIRESIDE_MCP_API_KEY?.trim() || null,
  };
}
