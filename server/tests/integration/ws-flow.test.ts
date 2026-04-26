// server/tests/integration/ws-flow.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { AddressInfo } from 'node:net';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { Broker } from '../../src/broker.js';
import { attachWebSocketServer } from '../../src/ws-server.js';
import type { AgentId, AgentSpec } from '../../src/agents/types.js';

function spec(id: AgentId): AgentSpec {
  return {
    id,
    displayName: id,
    command: 'fake',
    defaultTimeoutMs: 1000,
    buildArgs: () => [],
    parseOutput: () => ({ text: '', sessionId: null, raw: { stdout: '', stderr: '' } }),
  };
}

describe('WebSocket fanout', () => {
  let httpServer: HttpServer;
  let port: number;
  let db: ReturnType<typeof openDatabase>;
  let broker: Broker;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    broker = new Broker({
      db,
      runAgent: async (s) => ({
        text: `${s.id}-reply`,
        sessionId: `${s.id}-sess`,
        raw: { stdout: '', stderr: '' },
      }),
      getSpec: (id) => spec(id),
    });
    httpServer = createServer();
    attachWebSocketServer(httpServer, broker);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('broadcasts new messages to subscribed clients', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude'] });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const received: Array<{ type: string; message?: { text: string; authorId: string } }> = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString())));

    // Wait for the server to confirm the subscription before posting, otherwise
    // the synchronous `messageAppended` emit can fire before the server has
    // processed the subscribe frame and we lose events.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('subscribe timed out')), 5000);
      const onSubscribed = (data: import('ws').RawData) => {
        const msg = JSON.parse(data.toString()) as { type: string; roomId?: string };
        if (msg.type === 'subscribed' && msg.roomId === room.id) {
          clearTimeout(timer);
          ws.off('message', onSubscribed);
          resolve();
        }
      };
      ws.on('message', onSubscribed);
      ws.send(JSON.stringify({ type: 'subscribe', roomId: room.id }));
    });

    await broker.postHumanMessage(room.id, 'matt', 'hi');

    // Wait for 2 messageAppended events to land (matt + claude).
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (received.filter((r) => r.type === 'messageAppended').length >= 2) {
          clearInterval(timer);
          resolve();
        }
      }, 25);
    });

    const appended = received.filter((r) => r.type === 'messageAppended');
    expect(appended.map((r) => r.message!.authorId)).toEqual(['matt', 'claude']);
    ws.close();
  });

  it('only broadcasts to clients subscribed to that room', async () => {
    const a = createRoom(db, { name: 'A', agents: [] });
    const b = createRoom(db, { name: 'B', agents: [] });

    const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((r) => wsA.once('open', () => r()));
    wsA.send(JSON.stringify({ type: 'subscribe', roomId: a.id }));

    const recvA: Array<{ type: string }> = [];
    wsA.on('message', (d) => recvA.push(JSON.parse(d.toString())));

    await broker.postHumanMessage(b.id, 'x', 'in B');
    await new Promise((r) => setTimeout(r, 100));
    expect(recvA.filter((r) => r.type === 'messageAppended')).toHaveLength(0);

    wsA.close();
  });
});
