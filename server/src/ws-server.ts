// server/src/ws-server.ts
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { Broker } from './broker.js';
import type { Message } from './repos/messages.js';
import { logger } from './logger.js';

interface ClientState {
  rooms: Set<string>;
}

interface InboundSubscribe {
  type: 'subscribe';
  roomId: string;
}

interface InboundUnsubscribe {
  type: 'unsubscribe';
  roomId: string;
}

interface InboundPostMessage {
  type: 'postMessage';
  roomId: string;
  authorId: string;
  text: string;
}

type Inbound = InboundSubscribe | InboundUnsubscribe | InboundPostMessage;

export function attachWebSocketServer(httpServer: HttpServer, broker: Broker): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Map<WebSocket, ClientState>();

  broker.on('messageAppended', (msg: Message) => {
    const payload = JSON.stringify({ type: 'messageAppended', message: msg });
    for (const [client, state] of clients.entries()) {
      if (client.readyState === client.OPEN && state.rooms.has(msg.roomId)) {
        client.send(payload);
      }
    }
  });

  broker.on('roomDeleted', (evt: { roomId: string }) => {
    const payload = JSON.stringify({ type: 'roomDeleted', roomId: evt.roomId });
    for (const [client, state] of clients.entries()) {
      // Broadcast to ALL clients (not just subscribers of that room) — they
      // need to remove it from their room list regardless of subscription.
      if (client.readyState === client.OPEN) client.send(payload);
      // Also drop the room from any client's subscription set.
      state.rooms.delete(evt.roomId);
    }
  });

  wss.on('connection', (client) => {
    clients.set(client, { rooms: new Set() });

    client.on('message', async (data) => {
      let parsed: Inbound;
      try {
        parsed = JSON.parse(data.toString()) as Inbound;
      } catch {
        client.send(JSON.stringify({ type: 'error', error: 'invalid json' }));
        return;
      }
      const state = clients.get(client);
      if (!state) return;

      if (parsed.type === 'subscribe') {
        state.rooms.add(parsed.roomId);
        client.send(JSON.stringify({ type: 'subscribed', roomId: parsed.roomId }));
      } else if (parsed.type === 'unsubscribe') {
        state.rooms.delete(parsed.roomId);
      } else if (parsed.type === 'postMessage') {
        try {
          await broker.postHumanMessage(parsed.roomId, parsed.authorId, parsed.text);
        } catch (err) {
          logger.error({ err }, 'broker.postHumanMessage failed');
          client.send(JSON.stringify({ type: 'error', error: (err as Error).message }));
        }
      }
    });

    client.on('close', () => clients.delete(client));
    client.on('error', () => clients.delete(client));
  });

  return wss;
}
