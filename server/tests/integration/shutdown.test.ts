// server/tests/integration/shutdown.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { start } from '../../src/index.js';

function getJson(host: string, port: number, urlPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path: urlPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('start() / shutdown()', () => {
  it('serves rooms while running, persists the SQLite file, and refuses connections after shutdown', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fireside-shutdown-'));
    const port = 8799;
    try {
      const server = await start({
        port,
        host: '127.0.0.1',
        dataDir,
        dbFile: path.join(dataDir, 'fireside.sqlite'),
        uiDir: path.join(dataDir, 'ui-not-real'),
        maxPromptChars: 24_000,
        largeMessageThresholdChars: 6_000,
        resumeCliSessions: false,
      });

      // Server is up — REST returns the empty room list.
      const rooms = await getJson('127.0.0.1', port, '/api/rooms');
      expect(rooms).toEqual([]);

      await server.shutdown();

      // SQLite file exists on disk after shutdown (proves the DB was opened
      // against the configured path and not :memory:).
      expect(existsSync(path.join(dataDir, 'fireside.sqlite'))).toBe(true);

      // Listening socket is closed — new connections fail.
      await expect(getJson('127.0.0.1', port, '/api/rooms')).rejects.toThrow();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
