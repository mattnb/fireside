// server/src/http-server.ts
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Database } from 'better-sqlite3';
import path from 'node:path';
import { createRoom, getRoom, listRooms, updateRoomProject } from './repos/rooms.js';
import { createProject, getProject, listProjects, updateProject } from './repos/projects.js';
import { getPermissionRequest, listPermissionRequests } from './repos/permission-requests.js';
import type { AgentId } from './agents/types.js';
import type { TaskStatus } from './repos/tasks.js';
import type { TaskChecklistStatus } from './repos/task-checklist.js';
import type { TaskPhaseStatus } from './repos/task-phases.js';
import type { TaskPlanStatus } from './repos/task-plans.js';
import type { PermissionMode } from './permissions.js';
import type { Broker } from './broker.js';
import { pickFile, pickFolder } from './folder-picker.js';
import { logger } from './logger.js';
import type { ConversationArtifactFile } from './context-files.js';
import { buildStatusSnapshot } from './status-snapshot.js';

export interface HttpDeps {
  db: Database;
  broker: Broker;
  uiDir: string;
}

export type HttpServer = ReturnType<typeof buildHttpServer>;

const TASK_STATUSES = ['active', 'paused', 'blocked', 'verifying', 'done'] as const;
const CAPABILITY_PROFILES = ['plan', 'edit', 'full-auto'] as const;
const TASK_PHASE_STATUSES = ['planned', 'active', 'blocked', 'done'] as const;
const TASK_CHECKLIST_STATUSES = ['open', 'blocked', 'done', 'skipped'] as const;
const TASK_PLAN_STATUSES = ['draft', 'active', 'superseded', 'archived'] as const;

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

function isCapabilityProfile(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (CAPABILITY_PROFILES as readonly string[]).includes(value);
}

function isTaskPhaseStatus(value: unknown): value is TaskPhaseStatus {
  return typeof value === 'string' && (TASK_PHASE_STATUSES as readonly string[]).includes(value);
}

function isTaskChecklistStatus(value: unknown): value is TaskChecklistStatus {
  return (
    typeof value === 'string' && (TASK_CHECKLIST_STATUSES as readonly string[]).includes(value)
  );
}

function isTaskPlanStatus(value: unknown): value is TaskPlanStatus {
  return typeof value === 'string' && (TASK_PLAN_STATUSES as readonly string[]).includes(value);
}

function optionalOrder(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

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

  app.get('/api/projects', async () => {
    return listProjects(deps.db);
  });

  app.get('/api/state', async () => {
    return buildStatusSnapshot({ db: deps.db });
  });

  app.post<{ Body: { initialPath?: string } }>('/api/system/folder-picker', async (req, reply) => {
    if (req.headers['x-fireside-request'] !== '1') {
      return reply.code(403).send({ error: 'missing Fireside request header' });
    }
    const initialPath =
      typeof req.body?.initialPath === 'string' ? req.body.initialPath.slice(0, 1000) : '';
    const path = await pickFolder({ initialPath });
    return { path };
  });

  app.post<{ Body: { initialPath?: string } }>('/api/system/file-picker', async (req, reply) => {
    if (req.headers['x-fireside-request'] !== '1') {
      return reply.code(403).send({ error: 'missing Fireside request header' });
    }
    const initialPath =
      typeof req.body?.initialPath === 'string' ? req.body.initialPath.slice(0, 1000) : '';
    const path = await pickFile({ initialPath });
    return { path };
  });

  app.post<{ Body: { name: string; description?: string } }>(
    '/api/projects',
    async (req, reply) => {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 160) : '';
      const description =
        typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 1000) : '';
      if (!name) return reply.code(400).send({ error: 'name is required' });
      return createProject(deps.db, { name, description });
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string } }>(
    '/api/projects/:id',
    async (req, reply) => {
      const name =
        typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 160) : undefined;
      const description =
        typeof req.body?.description === 'string'
          ? req.body.description.trim().slice(0, 1000)
          : undefined;
      const updated = updateProject(deps.db, req.params.id, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      if (!updated) return reply.code(404).send({ error: 'not found' });
      return updated;
    },
  );

  app.post<{
    Body: { name: string; agents: AgentId[]; yoloAgents?: AgentId[]; projectId?: string };
  }>('/api/rooms', async (req, reply) => {
    const { name, agents, yoloAgents, projectId } =
      req.body ??
      ({} as { name: string; agents: AgentId[]; yoloAgents?: AgentId[]; projectId?: string });
    if (!name || !Array.isArray(agents)) {
      return reply.code(400).send({ error: 'name and agents are required' });
    }
    if (yoloAgents !== undefined && !Array.isArray(yoloAgents)) {
      return reply.code(400).send({ error: 'yoloAgents must be an array' });
    }
    if (projectId && !getProject(deps.db, projectId)) {
      return reply.code(400).send({ error: 'project not found' });
    }
      return createRoom(deps.db, {
        name,
        agents,
        yoloAgents: yoloAgents ?? [],
        ...(projectId !== undefined ? { projectId } : {}),
      });
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    return room;
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id/state', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    return buildStatusSnapshot({ db: deps.db, roomId: req.params.id });
  });

  app.get<{ Querystring: { limit?: string } }>('/api/briefings', async (req) => {
    const limit = req.query.limit ? Math.max(1, Math.min(500, Number(req.query.limit))) : 100;
    return deps.broker.listMissionBriefings(limit);
  });

  app.get<{ Params: { briefingId: string } }>('/api/briefings/:briefingId', async (req, reply) => {
    const briefing = deps.broker.getMissionBriefing(req.params.briefingId);
    if (!briefing) return reply.code(404).send({ error: 'not found' });
    return briefing;
  });

  app.delete<{ Params: { id: string } }>('/api/rooms/:id', async (req, reply) => {
    const ok = deps.broker.deleteRoom(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  app.patch<{
    Params: { id: string };
    Body: { agents?: AgentId[]; yoloAgents?: AgentId[]; projectId?: string };
  }>('/api/rooms/:id', async (req, reply) => {
    const { agents, yoloAgents, projectId } =
      req.body ?? ({} as { agents?: AgentId[]; yoloAgents?: AgentId[]; projectId?: string });
    let updated = getRoom(deps.db, req.params.id);
    if (!updated) return reply.code(404).send({ error: 'not found' });
    if (agents !== undefined && !Array.isArray(agents)) {
      return reply.code(400).send({ error: 'agents must be an array' });
    }
    if (yoloAgents !== undefined && !Array.isArray(yoloAgents)) {
      return reply.code(400).send({ error: 'yoloAgents must be an array' });
    }
    if (agents !== undefined) {
      updated = deps.broker.setAgents(req.params.id, agents, yoloAgents);
      if (!updated) return reply.code(404).send({ error: 'not found' });
    }
    if (projectId !== undefined) {
      const moved = updateRoomProject(deps.db, req.params.id, projectId);
      if (!moved) return reply.code(400).send({ error: 'project not found' });
      updated = moved;
    }
    return updated;
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/rooms/:id/messages',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      return deps.broker.listMessages(req.params.id, limit ? { limit } : {});
    },
  );

  app.get<{ Params: { id: string } }>('/api/rooms/:id/permission-requests', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    return listPermissionRequests(deps.db, req.params.id);
  });

  app.post<{
    Params: { id: string };
    Body: { taskId?: string | null; title?: string; summary?: string; createdBy?: string };
  }>('/api/rooms/:id/briefings', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    const { taskId, title, summary, createdBy } = req.body ?? {};
    const input: {
      roomId: string;
      taskId?: string | null;
      title?: string;
      summary?: string;
      createdBy: string;
    } = {
      roomId: req.params.id,
      taskId: typeof taskId === 'string' ? taskId : null,
      createdBy:
        typeof createdBy === 'string' && createdBy.trim() ? createdBy.slice(0, 120) : 'human',
    };
    if (typeof title === 'string') input.title = title.slice(0, 220);
    if (typeof summary === 'string') input.summary = summary.slice(0, 1000);
    const briefing = deps.broker.createMissionBriefing(input);
    if (!briefing) return reply.code(404).send({ error: 'not found' });
    return briefing;
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id/tasks', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    return deps.broker.listTasks(req.params.id);
  });

  app.post<{
    Params: { id: string };
    Body: {
      title: string;
      goal?: string;
      repoPath?: string;
      acceptanceCriteria?: string;
      agents?: AgentId[];
      capabilityProfile?: PermissionMode;
      summary?: string;
    };
  }>('/api/rooms/:id/tasks', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    const { title, goal, repoPath, acceptanceCriteria, agents, capabilityProfile, summary } =
      req.body ?? {};
    if (!title || typeof title !== 'string') {
      return reply.code(400).send({ error: 'title required' });
    }
    if (agents !== undefined && !Array.isArray(agents)) {
      return reply.code(400).send({ error: 'agents must be an array' });
    }
    if (capabilityProfile !== undefined && !isCapabilityProfile(capabilityProfile)) {
      return reply.code(400).send({ error: 'invalid capability profile' });
    }
    const task = deps.broker.createTask(req.params.id, {
      title: title.slice(0, 160),
      goal: typeof goal === 'string' ? goal.slice(0, 4000) : '',
      repoPath: typeof repoPath === 'string' ? repoPath.slice(0, 1000) : '',
      acceptanceCriteria:
        typeof acceptanceCriteria === 'string' ? acceptanceCriteria.slice(0, 4000) : '',
      agents: agents ?? room.agents,
      capabilityProfile: capabilityProfile ?? 'plan',
      summary: typeof summary === 'string' ? summary.slice(0, 4000) : '',
    });
    if (!task) return reply.code(404).send({ error: 'not found' });
    return task;
  });

  app.patch<{
    Params: { id: string; taskId: string };
    Body: {
      title?: string;
      goal?: string;
      repoPath?: string;
      acceptanceCriteria?: string;
      agents?: AgentId[];
      status?: TaskStatus;
      capabilityProfile?: PermissionMode;
      summary?: string;
    };
  }>('/api/rooms/:id/tasks/:taskId', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    const {
      title,
      goal,
      repoPath,
      acceptanceCriteria,
      agents,
      status,
      capabilityProfile,
      summary,
    } = req.body ?? {};
    if (agents !== undefined && !Array.isArray(agents)) {
      return reply.code(400).send({ error: 'agents must be an array' });
    }
    if (status !== undefined && !isTaskStatus(status)) {
      return reply.code(400).send({ error: 'invalid status' });
    }
    if (capabilityProfile !== undefined && !isCapabilityProfile(capabilityProfile)) {
      return reply.code(400).send({ error: 'invalid capability profile' });
    }
    const task = deps.broker.updateTask(req.params.id, req.params.taskId, {
      ...(title !== undefined ? { title: String(title).slice(0, 160) } : {}),
      ...(goal !== undefined ? { goal: String(goal).slice(0, 4000) } : {}),
      ...(repoPath !== undefined ? { repoPath: String(repoPath).slice(0, 1000) } : {}),
      ...(acceptanceCriteria !== undefined
        ? { acceptanceCriteria: String(acceptanceCriteria).slice(0, 4000) }
        : {}),
      ...(agents !== undefined ? { agents } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(capabilityProfile !== undefined ? { capabilityProfile } : {}),
      ...(summary !== undefined ? { summary: String(summary).slice(0, 4000) } : {}),
    });
    if (!task) return reply.code(404).send({ error: 'not found' });
    return task;
  });

  app.get<{ Params: { id: string; taskId: string } }>(
    '/api/rooms/:id/tasks/:taskId/control',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const control = deps.broker.getTaskControl(req.params.id, req.params.taskId);
      if (!control) return reply.code(404).send({ error: 'not found' });
      return control;
    },
  );

  app.post<{
    Params: { id: string; taskId: string };
    Body: {
      planId?: string | null;
      title: string;
      description?: string;
      status?: TaskPhaseStatus;
      gate?: string;
      sortOrder?: number;
    };
  }>('/api/rooms/:id/tasks/:taskId/phases', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    const { planId, title, description, status, gate, sortOrder } = req.body ?? {};
    if (!title || typeof title !== 'string')
      return reply.code(400).send({ error: 'title required' });
    if (status !== undefined && !isTaskPhaseStatus(status)) {
      return reply.code(400).send({ error: 'invalid status' });
    }
    const phase = deps.broker.createTaskPhase(req.params.id, req.params.taskId, {
      title: title.slice(0, 200),
      ...(planId !== undefined ? { planId } : {}),
      ...(description !== undefined ? { description: String(description).slice(0, 2000) } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(gate !== undefined ? { gate: String(gate).slice(0, 1000) } : {}),
      ...(sortOrder !== undefined ? { sortOrder: optionalOrder(sortOrder) ?? 0 } : {}),
    });
    if (!phase) return reply.code(404).send({ error: 'not found' });
    return phase;
  });

  app.patch<{
    Params: { id: string; taskId: string; phaseId: string };
    Body: {
      planId?: string | null;
      title?: string;
      description?: string;
      status?: TaskPhaseStatus;
      gate?: string;
      sortOrder?: number;
    };
  }>('/api/rooms/:id/tasks/:taskId/phases/:phaseId', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    const { planId, title, description, status, gate, sortOrder } = req.body ?? {};
    if (status !== undefined && !isTaskPhaseStatus(status)) {
      return reply.code(400).send({ error: 'invalid status' });
    }
    const phase = deps.broker.updateTaskPhase(
      req.params.id,
      req.params.taskId,
      req.params.phaseId,
      {
        ...(planId !== undefined ? { planId } : {}),
        ...(title !== undefined ? { title: String(title).slice(0, 200) } : {}),
        ...(description !== undefined ? { description: String(description).slice(0, 2000) } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(gate !== undefined ? { gate: String(gate).slice(0, 1000) } : {}),
        ...(sortOrder !== undefined ? { sortOrder: optionalOrder(sortOrder) ?? 0 } : {}),
      },
    );
    if (!phase) return reply.code(404).send({ error: 'not found' });
    return phase;
  });

  app.post<{
    Params: { id: string; taskId: string };
    Body: {
      planId?: string | null;
      phaseId?: string | null;
      title: string;
      detail?: string;
      status?: TaskChecklistStatus;
      dependencyIds?: string[];
      ownerAgentId?: string;
      statusNote?: string;
      blockedReason?: string;
      councilRequired?: boolean;
      sortOrder?: number;
    };
  }>('/api/rooms/:id/tasks/:taskId/checklist', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    const {
      phaseId,
      planId,
      title,
      detail,
      status,
      dependencyIds,
      ownerAgentId,
      statusNote,
      blockedReason,
      councilRequired,
      sortOrder,
    } = req.body ?? {};
    if (!title || typeof title !== 'string')
      return reply.code(400).send({ error: 'title required' });
    if (status !== undefined && !isTaskChecklistStatus(status)) {
      return reply.code(400).send({ error: 'invalid status' });
    }
    if (dependencyIds !== undefined && !Array.isArray(dependencyIds)) {
      return reply.code(400).send({ error: 'dependencyIds must be an array' });
    }
    const item = deps.broker.createTaskChecklistItem(req.params.id, req.params.taskId, {
      planId: planId ?? null,
      phaseId: phaseId ?? null,
      title: title.slice(0, 240),
      ...(detail !== undefined ? { detail: String(detail).slice(0, 2000) } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(dependencyIds !== undefined ? { dependencyIds: dependencyIds.map(String) } : {}),
      ...(ownerAgentId !== undefined ? { ownerAgentId: String(ownerAgentId).slice(0, 80) } : {}),
      ...(statusNote !== undefined ? { statusNote: String(statusNote).slice(0, 2000) } : {}),
      ...(blockedReason !== undefined
        ? { blockedReason: String(blockedReason).slice(0, 2000) }
        : {}),
      ...(councilRequired !== undefined ? { councilRequired: councilRequired === true } : {}),
      ...(sortOrder !== undefined ? { sortOrder: optionalOrder(sortOrder) ?? 0 } : {}),
    });
    if (!item) return reply.code(404).send({ error: 'not found' });
    return item;
  });

  app.patch<{
    Params: { id: string; taskId: string; itemId: string };
    Body: {
      planId?: string | null;
      phaseId?: string | null;
      title?: string;
      detail?: string;
      status?: TaskChecklistStatus;
      dependencyIds?: string[];
      ownerAgentId?: string;
      statusNote?: string;
      blockedReason?: string;
      councilRequired?: boolean;
      sortOrder?: number;
    };
  }>('/api/rooms/:id/tasks/:taskId/checklist/:itemId', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    const {
      phaseId,
      planId,
      title,
      detail,
      status,
      dependencyIds,
      ownerAgentId,
      statusNote,
      blockedReason,
      councilRequired,
      sortOrder,
    } = req.body ?? {};
    if (status !== undefined && !isTaskChecklistStatus(status)) {
      return reply.code(400).send({ error: 'invalid status' });
    }
    if (dependencyIds !== undefined && !Array.isArray(dependencyIds)) {
      return reply.code(400).send({ error: 'dependencyIds must be an array' });
    }
    const item = deps.broker.updateTaskChecklistItem(
      req.params.id,
      req.params.taskId,
      req.params.itemId,
      {
        ...(planId !== undefined ? { planId } : {}),
        ...(phaseId !== undefined ? { phaseId } : {}),
        ...(title !== undefined ? { title: String(title).slice(0, 240) } : {}),
        ...(detail !== undefined ? { detail: String(detail).slice(0, 2000) } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(dependencyIds !== undefined ? { dependencyIds: dependencyIds.map(String) } : {}),
        ...(ownerAgentId !== undefined ? { ownerAgentId: String(ownerAgentId).slice(0, 80) } : {}),
        ...(statusNote !== undefined ? { statusNote: String(statusNote).slice(0, 2000) } : {}),
        ...(blockedReason !== undefined
          ? { blockedReason: String(blockedReason).slice(0, 2000) }
          : {}),
        ...(councilRequired !== undefined ? { councilRequired: councilRequired === true } : {}),
        ...(sortOrder !== undefined ? { sortOrder: optionalOrder(sortOrder) ?? 0 } : {}),
      },
    );
    if (!item) return reply.code(404).send({ error: 'not found' });
    return item;
  });

  app.post<{
    Params: { id: string; taskId: string };
    Body: { title: string; body?: string; status?: TaskPlanStatus };
  }>('/api/rooms/:id/tasks/:taskId/plans', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    const { title, body, status } = req.body ?? {};
    if (!title || typeof title !== 'string')
      return reply.code(400).send({ error: 'title required' });
    if (status !== undefined && !isTaskPlanStatus(status)) {
      return reply.code(400).send({ error: 'invalid status' });
    }
    const plan = deps.broker.createTaskPlan(req.params.id, req.params.taskId, {
      title: title.slice(0, 200),
      ...(body !== undefined ? { body: String(body).slice(0, 12000) } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    if (!plan) return reply.code(404).send({ error: 'not found' });
    return plan;
  });

  app.patch<{
    Params: { id: string; taskId: string; planId: string };
    Body: { title?: string; body?: string; status?: TaskPlanStatus };
  }>('/api/rooms/:id/tasks/:taskId/plans/:planId', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    const { title, body, status } = req.body ?? {};
    if (status !== undefined && !isTaskPlanStatus(status)) {
      return reply.code(400).send({ error: 'invalid status' });
    }
    const plan = deps.broker.updateTaskPlan(req.params.id, req.params.taskId, req.params.planId, {
      ...(title !== undefined ? { title: String(title).slice(0, 200) } : {}),
      ...(body !== undefined ? { body: String(body).slice(0, 12000) } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    if (!plan) return reply.code(404).send({ error: 'not found' });
    return plan;
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/rooms/:id/runs',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const limit = req.query.limit ? Number(req.query.limit) : 30;
      return deps.broker.listAgentRuns(req.params.id, Number.isFinite(limit) ? limit : 30);
    },
  );

  app.get<{ Params: { id: string; runId: string } }>(
    '/api/rooms/:id/runs/:runId',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const detail = deps.broker.getAgentRunDetail(req.params.id, req.params.runId);
      if (!detail) return reply.code(404).send({ error: 'not found' });
      return detail;
    },
  );

  app.post<{ Params: { id: string; runId: string }; Body: { authorId?: string } }>(
    '/api/rooms/:id/runs/:runId/dismiss',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const updated = deps.broker.dismissAgentRun(
        req.params.id,
        req.params.runId,
        typeof req.body?.authorId === 'string' ? req.body.authorId.slice(0, 80) : 'human',
      );
      if (!updated) return reply.code(404).send({ error: 'not found' });
      return updated;
    },
  );

  app.post<{ Params: { id: string; agentId: AgentId }; Body: { authorId?: string } }>(
    '/api/rooms/:id/agents/:agentId/compact',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const result = deps.broker.startAgentCompaction(
        req.params.id,
        req.params.agentId,
        typeof req.body?.authorId === 'string' ? req.body.authorId.slice(0, 80) : 'human',
      );
      if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });
      return reply.code(202).send(result.run);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; taskId?: string } }>(
    '/api/rooms/:id/collaboration',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : undefined;
      return deps.broker.listCollaborationItems(
        req.params.id,
        Number.isFinite(limit) ? limit : 50,
        taskId,
      );
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/rooms/:id/actions',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const limit = req.query.limit ? Number(req.query.limit) : 60;
      return deps.broker.listAgentRunActions(req.params.id, Number.isFinite(limit) ? limit : 60);
    },
  );

  app.get<{ Params: { id: string } }>('/api/rooms/:id/artifacts', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    return (
      deps.broker.listArtifacts(req.params.id) ?? {
        transcriptPath: '',
        recapPath: '',
        manifestPath: '',
        artifactsDir: '',
        fixtureManifestPath: '',
        fixturesDir: '',
        files: [],
      }
    );
  });

  app.delete<{
    Params: { id: string };
    Body: { kind?: ConversationArtifactFile['kind']; path?: string };
  }>('/api/rooms/:id/artifacts', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    const kind = req.body?.kind;
    const artifactPath = typeof req.body?.path === 'string' ? req.body.path.slice(0, 4000) : '';
    if (!kind || !artifactPath) {
      return reply.code(400).send({ error: 'kind and path required' });
    }
    try {
      const ok = deps.broker.removeArtifact(req.params.id, kind, artifactPath);
      if (!ok) return reply.code(503).send({ error: 'context artifacts disabled' });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /not found/i.test(message) ? 404 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  app.post<{ Params: { id: string }; Body: { sourcePath: string } }>(
    '/api/rooms/:id/fixtures',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const sourcePath =
        typeof req.body?.sourcePath === 'string' ? req.body.sourcePath.slice(0, 2000) : '';
      if (!sourcePath) return reply.code(400).send({ error: 'sourcePath required' });
      try {
        const fixture = deps.broker.attachFixture(req.params.id, sourcePath);
        if (!fixture) return reply.code(503).send({ error: 'context artifacts disabled' });
        return fixture;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  app.post<{
    Params: { id: string; requestId: string };
    Body: { decision: 'approved' | 'denied'; decidedBy: string };
  }>('/api/rooms/:id/permission-requests/:requestId/decision', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    const { decision, decidedBy } = req.body ?? {};
    if ((decision !== 'approved' && decision !== 'denied') || !decidedBy) {
      return reply.code(400).send({ error: 'decision and decidedBy required' });
    }
    const existing = getPermissionRequest(deps.db, req.params.requestId);
    if (!existing || existing.roomId !== req.params.id) {
      return reply.code(404).send({ error: 'not found' });
    }
    const request = deps.broker.resolvePermissionRequest(req.params.requestId, decision, decidedBy);
    if (!request) return reply.code(404).send({ error: 'not found' });
    return request;
  });

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
