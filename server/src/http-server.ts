// server/src/http-server.ts
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Database } from 'better-sqlite3';
import path from 'node:path';
import { createRoom, getRoom, listRooms } from './repos/rooms.js';
import { listMessages } from './repos/messages.js';
import type { AgentId } from './agents/types.js';
import type { Broker } from './broker.js';
import { logger } from './logger.js';

export interface HttpDeps {
  db: Database;
  broker: Broker;
  uiDir: string;
}

export type HttpServer = ReturnType<typeof buildHttpServer>;

export function buildHttpServer(deps: HttpDeps) {
  const app = Fastify({ loggerInstance: logger });

  app.register(fastifyStatic, {
    root: path.resolve(deps.uiDir),
    prefix: '/',
    decorateReply: false,
  });

  app.get('/api/rooms', async () => {
    return listRooms(deps.db);
  });

  app.post<{ Body: { name: string; agents: AgentId[] } }>('/api/rooms', async (req, reply) => {
    const { name, agents } = req.body ?? ({} as { name: string; agents: AgentId[] });
    if (!name || !Array.isArray(agents)) {
      return reply.code(400).send({ error: 'name and agents are required' });
    }
    return createRoom(deps.db, { name, agents });
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    return room;
  });

  app.delete<{ Params: { id: string } }>('/api/rooms/:id', async (req, reply) => {
    const ok = deps.broker.deleteRoom(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  app.patch<{ Params: { id: string }; Body: { agents: AgentId[] } }>(
    '/api/rooms/:id',
    async (req, reply) => {
      const { agents } = req.body ?? ({} as { agents: AgentId[] });
      if (!Array.isArray(agents)) {
        return reply.code(400).send({ error: 'agents must be an array' });
      }
      const updated = deps.broker.setAgents(req.params.id, agents);
      if (!updated) return reply.code(404).send({ error: 'not found' });
      return updated;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/rooms/:id/messages',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      return listMessages(deps.db, req.params.id, limit ? { limit } : {});
    },
  );

  app.post<{ Params: { id: string }; Body: { authorId: string; text: string } }>(
    '/api/rooms/:id/messages',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const { authorId, text } = req.body;
      if (!authorId || typeof text !== 'string') {
        return reply.code(400).send({ error: 'authorId and text required' });
      }
      const message = await deps.broker.postHumanMessage(req.params.id, authorId, text);
      return message;
    },
  );

  return app;
}


