import { createRequire } from 'node:module';
import path from 'node:path';
import type { AgentContextUsage } from '../context-usage.js';
import { geminiStatsModelQuotaUsage } from '../context-usage.js';

export const GEMINI_STATS_SAMPLE_INTERVAL_MS = 30 * 60 * 1000;
const GEMINI_STATS_TIMEOUT_MS = 20_000;
const GEMINI_STATS_COMMAND_DELAY_MS = 1_000;
const GEMINI_STATS_QUIT_DELAY_MS = 4_000;

interface PtyProcess {
  onData(callback: (data: string) => void): void;
  onExit(callback: () => void): void;
  write(data: string): void;
  kill(): void;
}

interface NodePtyModule {
  spawn(
    command: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ): PtyProcess;
}

interface GeminiStatsSampleOptions {
  force?: boolean;
  now?: () => number;
  runStatsModel?: () => Promise<string | null>;
  fallbackModel?: string;
}

let lastGeminiStatsSampleAt = 0;
let inFlight: Promise<AgentContextUsage | null> | null = null;
let cachedPtyModule: NodePtyModule | false | undefined;

export function resetGeminiStatsSamplerForTesting(): void {
  lastGeminiStatsSampleAt = 0;
  inFlight = null;
  cachedPtyModule = undefined;
}

function optionalRequireNodePty(): NodePtyModule | null {
  if (cachedPtyModule !== undefined) return cachedPtyModule || null;
  const req = createRequire(import.meta.url);
  const attempts = ['node-pty'];
  const appData = process.env.APPDATA;
  if (appData) {
    attempts.push(
      path.join(
        appData,
        'npm',
        'node_modules',
        '@google',
        'gemini-cli',
        'node_modules',
        'node-pty',
      ),
    );
  }
  for (const attempt of attempts) {
    try {
      cachedPtyModule = req(attempt) as NodePtyModule;
      return cachedPtyModule;
    } catch {
      // PTY support is optional; Gemini token usage from stream-json still works.
    }
  }
  cachedPtyModule = false;
  return null;
}

function geminiInteractiveCommand(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'gemini --screen-reader --skip-trust'],
    };
  }
  return {
    command: 'gemini',
    args: ['--screen-reader', '--skip-trust'],
  };
}

export async function runGeminiStatsModelPty(): Promise<string | null> {
  const pty = optionalRequireNodePty();
  if (!pty) return null;
  const { command, args } = geminiInteractiveCommand();
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let statsTimer: NodeJS.Timeout | undefined;
    let quitTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const child = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env, CI: '1' },
    });

    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (statsTimer) clearTimeout(statsTimer);
      if (quitTimer) clearTimeout(quitTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(value);
    };

    child.onData((data) => {
      output += data;
    });
    child.onExit(() => {
      settle(output);
    });

    statsTimer = setTimeout(() => {
      child.write('/stats model\r');
    }, GEMINI_STATS_COMMAND_DELAY_MS);
    quitTimer = setTimeout(() => {
      child.write('/quit\r');
    }, GEMINI_STATS_QUIT_DELAY_MS);
    timeoutTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best-effort cleanup only; the sample is optional.
      }
      settle(output || null);
    }, GEMINI_STATS_TIMEOUT_MS);
    statsTimer.unref?.();
    quitTimer.unref?.();
    timeoutTimer.unref?.();
  });
}

export async function maybeSampleGeminiStatsModelQuota(
  options: GeminiStatsSampleOptions = {},
): Promise<AgentContextUsage | null> {
  if (!options.runStatsModel && process.env.VITEST) return null;
  const now = options.now?.() ?? Date.now();
  if (!options.force && now - lastGeminiStatsSampleAt < GEMINI_STATS_SAMPLE_INTERVAL_MS) {
    return null;
  }
  if (inFlight) return inFlight;
  lastGeminiStatsSampleAt = now;
  const runStatsModel = options.runStatsModel ?? runGeminiStatsModelPty;
  inFlight = (async () => {
    try {
      const output = await runStatsModel();
      if (!output) return null;
      return geminiStatsModelQuotaUsage(output, {
        now,
        ...(options.fallbackModel ? { fallbackModel: options.fallbackModel } : {}),
      });
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
