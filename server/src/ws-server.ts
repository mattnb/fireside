// server/src/ws-server.ts
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type {
  Broker,
  MessageDeliveryUpdate,
  MessageReadReceiptUpdate,
  MessageRetractionUpdate,
  YoloStatus,
} from './broker.js';
import type { Message } from './repos/messages.js';
import type { Room } from './repos/rooms.js';
import type { PermissionRequest, YoloPermissionProfile } from './permissions.js';
import type { Task } from './repos/tasks.js';
import type { AgentRunSummary } from './repos/agent-runs.js';
import type { CollaborationItem } from './repos/collaboration.js';
import type { AgentRunAction } from './repos/run-actions.js';
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

interface InboundStartYolo {
  type: 'startYolo';
  roomId: string;
  authorId: string;
  profile?: YoloPermissionProfile;
}

interface InboundCancelYolo {
  type: 'cancelYolo';
  roomId: string;
  authorId: string;
}

interface InboundStopRuns {
  type: 'stopRuns';
  roomId: string;
  authorId: string;
}

interface InboundAddYoloTurns {
  type: 'addYoloTurns';
  roomId: string;
  authorId: string;
  turns: number;
}

type Inbound =
  | InboundSubscribe
  | InboundUnsubscribe
  | InboundPostMessage
  | InboundStartYolo
  | InboundCancelYolo
  | InboundStopRuns
  | InboundAddYoloTurns;

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

  const broadcastPermissionRequest = (
    type: 'permissionRequestCreated' | 'permissionRequestUpdated',
    request: PermissionRequest,
  ): void => {
    const payload = JSON.stringify({ type, request });
    for (const [client, state] of clients.entries()) {
      if (client.readyState === client.OPEN && state.rooms.has(request.roomId)) {
        client.send(payload);
      }
    }
  };

  broker.on('permissionRequestCreated', (request: PermissionRequest) => {
    broadcastPermissionRequest('permissionRequestCreated', request);
  });

  broker.on('permissionRequestUpdated', (request: PermissionRequest) => {
    broadcastPermissionRequest('permissionRequestUpdated', request);
  });

  broker.on('taskUpdated', (task: Task) => {
    const payload = JSON.stringify({ type: 'taskUpdated', task });
    for (const [client, state] of clients.entries()) {
      if (client.readyState === client.OPEN && state.rooms.has(task.roomId)) {
        client.send(payload);
      }
    }
  });

  broker.on('messageUpdated', (msg: Message) => {
    const payload = JSON.stringify({ type: 'messageUpdated', message: msg });
    for (const [client, state] of clients.entries()) {
      if (client.readyState === client.OPEN && state.rooms.has(msg.roomId)) {
        client.send(payload);
      }
    }
  });

  broker.on('messageRetracted', (update: MessageRetractionUpdate) => {
    const payload = JSON.stringify({ type: 'messageRetracted', update });
    for (const [client, state] of clients.entries()) {
      if (client.readyState === client.OPEN && state.rooms.has(update.roomId)) {
        client.send(payload);
      }
    }
  });

  broker.on('messageDeliveryUpdated', (update: MessageDeliveryUpdate) => {
    const payload = JSON.stringify({ type: 'messageDeliveryUpdated', update });
    for (const [client, state] of clients.entries()) {
      if (client.readyState === client.OPEN && state.rooms.has(update.roomId)) {
        client.send(payload);
      }
    }
  });

  broker.on('messageReadReceiptUpdated', (update: MessageReadReceiptUpdate) => {
    const payload = JSON.stringify({ type: 'messageReadReceiptUpdated', update });
    for (const [client, state] of clients.entries()) {
      if (client.readyState === client.OPEN && state.rooms.has(update.roomId)) {
        client.send(payload);
      }
    }
  });

  broker.on('agentRunUpdated', (run: AgentRunSummary) => {
    const payload = JSON.stringify({ type: 'agentRunUpdated', run });
    for (const [client, state] of clients.entries()) {
      if (client.readyState === client.OPEN && state.rooms.has(run.roomId)) {
        client.send(payload);
      }
    }
  });

  broker.on('collaborationItemCreated', (item: CollaborationItem) => {
    const payload = JSON.stringify({ type: 'collaborationItemCreated', item });
    for (const [client, state] of clients.entries()) {
      if (client.readyState === client.OPEN && state.rooms.has(item.roomId)) {
        client.send(payload);
      }
    }
  });

  broker.on('agentRunActionCreated', (action: AgentRunAction) => {
    const payload = JSON.stringify({ type: 'agentRunActionCreated', action });
    for (const [client, state] of clients.entries()) {
      if (client.readyState === client.OPEN && state.rooms.has(action.roomId)) {
        client.send(payload);
      }
    }
  });

  broker.on('yoloStatusUpdated', (status: YoloStatus) => {
    const roomId = status.roomId;
    const payload = JSON.stringify({ type: 'yoloStatusUpdated', status });
    for (const [client, state] of clients.entries()) {
      if (client.readyState === client.OPEN && state.rooms.has(roomId)) {
        client.send(payload);
      }
    }
  });

  broker.on('artifactsUpdated', (evt: { roomId: string }) => {
    const payload = JSON.stringify({ type: 'artifactsUpdated', roomId: evt.roomId });
    for (const [client, state] of clients.entries()) {
      if (client.readyState === client.OPEN && state.rooms.has(evt.roomId)) {
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

  broker.on('roomUpdated', (room: Room) => {
    const payload = JSON.stringify({ type: 'roomUpdated', room });
    for (const [client] of clients.entries()) {
      // Broadcast to ALL clients — they need to update their cached room
      // state (e.g. agents list) regardless of which room they're viewing.
      if (client.readyState === client.OPEN) client.send(payload);
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
      } else if (parsed.type === 'startYolo') {
        try {
          await broker.startYoloDiscussion(parsed.roomId, parsed.authorId, parsed.profile);
        } catch (err) {
          logger.error({ err }, 'broker.startYoloDiscussion failed');
          client.send(JSON.stringify({ type: 'error', error: (err as Error).message }));
        }
      } else if (parsed.type === 'cancelYolo') {
        try {
          broker.cancelYoloDiscussion(parsed.roomId, parsed.authorId);
        } catch (err) {
          logger.error({ err }, 'broker.cancelYoloDiscussion failed');
          client.send(JSON.stringify({ type: 'error', error: (err as Error).message }));
        }
      } else if (parsed.type === 'stopRuns') {
        try {
          broker.stopRoomRuns(parsed.roomId, parsed.authorId);
        } catch (err) {
          logger.error({ err }, 'broker.stopRoomRuns failed');
          client.send(JSON.stringify({ type: 'error', error: (err as Error).message }));
        }
      } else if (parsed.type === 'addYoloTurns') {
        try {
          broker.addYoloTurns(parsed.roomId, parsed.authorId, parsed.turns);
        } catch (err) {
          logger.error({ err }, 'broker.addYoloTurns failed');
          client.send(JSON.stringify({ type: 'error', error: (err as Error).message }));
        }
      }
    });

    client.on('close', () => clients.delete(client));
    client.on('error', () => clients.delete(client));
  });

  return wss;
}
