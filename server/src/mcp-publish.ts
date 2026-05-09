// server/src/mcp-publish.ts
//
// Auto-publish Fireside as an MCP server to spawned provider CLIs at server
// startup. Each provider has its own config mechanism:
//
//   - Claude: writes `<dataDir>/fireside-mcp.json` and defaults
//     `FIRESIDE_MCP_CONFIG` to that path. The Claude adapter passes
//     `--mcp-config <path>` per turn (see server/src/agents/claude.ts).
//
//   - Codex: idempotently runs `codex mcp add fireside --url ...` once,
//     persisting the registration in `~/.codex/config.toml`. Subsequent
//     `codex exec` invocations auto-load it.
//
//   - Gemini: idempotently runs `gemini mcp add fireside <url> -t http -s user`
//     once, persisting the registration in `~/.gemini/settings.json`.
//     Subsequent `gemini -p` invocations auto-load it (the Gemini adapter
//     adds `--allowed-mcp-server-names fireside` per turn).
//
// All three CLIs reach Fireside via loopback (127.0.0.1), regardless of
// FIRESIDE_HOST, because the spawned subprocesses run on the same machine.
// Loopback is unauthenticated by design (single-tenant local-first trust
// model), so no bearer header is needed in the published config even when
// FIRESIDE_MCP_API_KEY is set for non-loopback callers.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

export interface PublishMcpInput {
  dataDir: string;
  port: number;
}

export interface PublishMcpResult {
  claudeConfigPath: string;
  codex: 'registered' | 'already-configured' | 'cli-missing' | 'failed';
  gemini: 'registered' | 'already-configured' | 'cli-missing' | 'failed';
}

const SERVER_NAME = 'fireside';

export async function publishFiresideMcp(input: PublishMcpInput): Promise<PublishMcpResult> {
  // Always advertise loopback to spawned CLIs — they're co-resident.
  const url = `http://127.0.0.1:${input.port}/api/mcp`;
  const claudeConfigPath = path.join(input.dataDir, 'fireside-mcp.json');

  writeClaudeConfig(claudeConfigPath, url);
  if (!process.env.FIRESIDE_MCP_CONFIG?.trim()) {
    process.env.FIRESIDE_MCP_CONFIG = claudeConfigPath;
  }

  const [codex, gemini] = await Promise.all([
    ensureCodexMcpRegistered(url),
    ensureGeminiMcpRegistered(url),
  ]);

  logger.info(
    { claudeConfigPath, codex, gemini, url },
    'fireside mcp server published to provider CLIs',
  );

  return { claudeConfigPath, codex, gemini };
}

function writeClaudeConfig(filePath: string, url: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const config = {
    mcpServers: {
      [SERVER_NAME]: {
        type: 'http',
        url,
      },
    },
  };
  writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

async function ensureCodexMcpRegistered(
  url: string,
): Promise<PublishMcpResult['codex']> {
  if (!(await hasCli('codex'))) return 'cli-missing';

  const list = await runCli('codex', ['mcp', 'list', '--json']);
  if (list.code !== 0) {
    logger.warn({ stderr: list.stderr }, 'codex mcp list failed; skipping fireside registration');
    return 'failed';
  }
  if (codexHasFiresideEntry(list.stdout)) {
    return 'already-configured';
  }

  const add = await runCli('codex', ['mcp', 'add', SERVER_NAME, '--url', url]);
  if (add.code !== 0) {
    logger.warn({ stderr: add.stderr }, 'codex mcp add fireside failed');
    return 'failed';
  }
  return 'registered';
}

function codexHasFiresideEntry(jsonOutput: string): boolean {
  // `codex mcp list --json` emits an array or object. We accept either shape
  // and look for an entry whose name matches our server name.
  try {
    const parsed: unknown = JSON.parse(jsonOutput);
    if (Array.isArray(parsed)) {
      return parsed.some((entry) => isCodexFiresideEntry(entry));
    }
    if (parsed && typeof parsed === 'object') {
      const map = parsed as Record<string, unknown>;
      if (SERVER_NAME in map) return true;
      const servers = (map as { servers?: unknown }).servers;
      if (Array.isArray(servers)) {
        return servers.some((entry) => isCodexFiresideEntry(entry));
      }
    }
    return false;
  } catch {
    // Older Codex versions emit plain text. Fall back to substring.
    return jsonOutput.includes(SERVER_NAME);
  }
}

function isCodexFiresideEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const name = (entry as { name?: unknown }).name;
  return typeof name === 'string' && name === SERVER_NAME;
}

async function ensureGeminiMcpRegistered(
  url: string,
): Promise<PublishMcpResult['gemini']> {
  if (!(await hasCli('gemini'))) return 'cli-missing';

  const list = await runCli('gemini', ['mcp', 'list']);
  if (list.code !== 0) {
    logger.warn({ stderr: list.stderr }, 'gemini mcp list failed; skipping fireside registration');
    return 'failed';
  }
  if (list.stdout.includes(SERVER_NAME)) {
    return 'already-configured';
  }

  // -s user persists at user scope (not the project cwd Fireside happens to
  // run from); -t http selects the streamable HTTP transport.
  const add = await runCli('gemini', [
    'mcp',
    'add',
    SERVER_NAME,
    url,
    '-t',
    'http',
    '-s',
    'user',
  ]);
  if (add.code !== 0) {
    logger.warn({ stderr: add.stderr }, 'gemini mcp add fireside failed');
    return 'failed';
  }
  return 'registered';
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function hasCli(command: string): Promise<boolean> {
  try {
    const result = await runCli(command, ['--version'], 5000);
    return result.code === 0;
  } catch {
    return false;
  }
}

function runCli(command: string, args: readonly string[], timeoutMs = 30_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, stdout, stderr: stderr + '\n[publishFiresideMcp: cli timeout]' });
    }, timeoutMs);
  });
}

// Exported only for unit tests.
export const __test__ = { codexHasFiresideEntry };
