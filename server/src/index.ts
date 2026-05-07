// server/src/index.ts
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from './config.js';
import { logger } from './logger.js';
import { openDatabase } from './db.js';
import { Broker } from './broker.js';
import { buildHttpServer } from './http-server.js';
import { attachWebSocketServer } from './ws-server.js';
import { runAgentTurn } from './agents/runner.js';
import { getAgentSpec } from './agents/registry.js';
import { trimTerminalAgentJobPayloads } from './repos/agent-jobs.js';
import type { AgentId } from './agents/types.js';

export interface FiresideServer {
  /** Stop accepting new connections, close DB, and resolve when done. */
  shutdown(): Promise<void>;
  /** The host:port the server is bound to. */
  address: { host: string; port: number };
}

/**
 * Boots Fireside: opens the database, wires the broker, registers HTTP routes,
 * attaches the WebSocket server, and starts listening. Resolves once the
 * server is accepting connections.
 *
 * Caller is responsible for invoking `shutdown()` when done. The exported
 * `main()` wires SIGINT/SIGTERM to call `shutdown()` automatically.
 */
export async function start(config: Config = loadConfig()): Promise<FiresideServer> {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(config.dbFile);
  const trimmedAgentJobs = trimTerminalAgentJobPayloads(db);
  if (trimmedAgentJobs > 0) {
    logger.info({ count: trimmedAgentJobs }, 'trimmed terminal agent job payloads');
  }

  const broker = new Broker({
    db,
    runAgent: (
      spec,
      prompt,
      sessionId,
      permission,
      cancelSignal,
      onStreamEvent,
      timeoutMs,
      turnKind,
      modelSettings,
    ) =>
      runAgentTurn({
        spec,
        prompt,
        sessionId,
        ...(permission !== undefined ? { permission } : {}),
        ...(turnKind !== undefined ? { turnKind } : {}),
        ...(modelSettings !== undefined ? { model: modelSettings } : {}),
        ...(cancelSignal !== undefined ? { cancelSignal } : {}),
        ...(onStreamEvent !== undefined ? { onStreamEvent } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }),
    contextDir: `${config.dataDir}/agent-context`,
    maxPromptChars: config.maxPromptChars,
    largeMessageThresholdChars: config.largeMessageThresholdChars,
    resumeCliSessions: config.resumeCliSessions,
    autoCompactEnabled: config.autoCompactEnabled,
    autoCompactPercent: config.autoCompactPercent,
    autoCompactTokenLimit: config.autoCompactTokenLimit,
    leadResetPercent: config.leadResetPercent,
    leadResetDisabled: config.leadResetDisabled,
    getSpec: (id: AgentId) => {
      try {
        return getAgentSpec(id);
      } catch {
        return undefined;
      }
    },
  });

  const app = buildHttpServer({ db, broker, uiDir: config.uiDir });
  await app.ready();
  attachWebSocketServer(app.server, broker);

  await app.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port }, 'fireside listening');

  return {
    address: { host: config.host, port: config.port },
    async shutdown() {
      await app.close();
      db.close();
    },
  };
}

export async function main(): Promise<void> {
  const server = await start();

  let shuttingDown = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, 'shutting down');
    void server
      .shutdown()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, onSignal);
  }
}

// Only run main() when invoked directly (not when imported by tests).
const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryUrl) {
  main().catch((err) => {
    logger.fatal({ err }, 'failed to start fireside');
    process.exit(1);
  });
}
