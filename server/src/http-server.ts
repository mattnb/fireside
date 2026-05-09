// server/src/http-server.ts
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { dispatchMcpRequest, parseJsonRpcRequest } from './tools/adapters/mcp-adapter.js';
import { DEFAULT_YOLO_STATE_PERMISSIONS } from './tools/permissions/state-permissions.js';
import { ensureDefaultToolsRegistered } from './tools/default-tools.js';
import type { Database } from 'better-sqlite3';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRoom, getRoom, listRooms, updateRoomProject } from './repos/rooms.js';
import { createProject, getProject, listProjects, updateProject } from './repos/projects.js';
import { getPermissionRequest, listPermissionRequests } from './repos/permission-requests.js';
import type { AgentId, ProviderId, RoomAgentProfile } from './agents/types.js';
import type { TaskStatus } from './repos/tasks.js';
import type { TaskChecklistParallelism, TaskChecklistStatus } from './repos/task-checklist.js';
import type { TaskPhaseStatus } from './repos/task-phases.js';
import type { TaskPlanStatus } from './repos/task-plans.js';
import type { PermissionMode } from './permissions.js';
import { QueuedMessageMutationError, type Broker } from './broker.js';
import { pickFile, pickFolder } from './folder-picker.js';
import { logger } from './logger.js';
import type { ConversationArtifactFile } from './context-files.js';
import { buildStatusSnapshot } from './status-snapshot.js';
import { capacityBlockFromContextUsage } from './provider-capacity.js';
import { AGENT_PERSONAS, AGENT_PROVIDERS, isProviderId } from './agents/personas.js';
import {
  defaultAgentProfile,
  normalizeRoomAgentProfiles,
  validateRoomParticipantNames,
} from './agents/profiles.js';
import {
  scoreProvidersForSlot,
  type ProviderCapabilityTag,
  type ProviderHealth,
  type ProviderScoringSlot,
} from './agents/provider-scoring.js';

export interface HttpDeps {
  db: Database;
  broker: Broker;
  uiDir: string;
  /** Optional bearer token. Required for non-loopback `/api/mcp` calls.
   *  Loopback callers are unauthenticated by design. */
  mcpApiKey?: string | null;
}

export type HttpServer = ReturnType<typeof buildHttpServer>;

const TASK_STATUSES = ['active', 'paused', 'blocked', 'verifying', 'done'] as const;
const CAPABILITY_PROFILES = ['plan', 'edit', 'full-auto'] as const;
const TASK_PHASE_STATUSES = ['planned', 'active', 'blocked', 'done'] as const;
const TASK_CHECKLIST_STATUSES = ['open', 'blocked', 'done', 'skipped'] as const;
const TASK_CHECKLIST_PARALLELISM = ['parallel-safe', 'coordinate', 'exclusive'] as const;
const TASK_PLAN_STATUSES = ['draft', 'active', 'superseded', 'archived'] as const;

interface ProviderScoreSlotBody {
  id?: unknown;
  personaId?: unknown;
  providerId?: unknown;
  preferredProviders?: unknown;
  fallbackProviders?: unknown;
  avoidProviders?: unknown;
  capabilityTags?: unknown;
}

interface ProviderScoreBody {
  slots?: unknown;
}

function openInOs(absPath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', absPath];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [absPath];
  } else {
    cmd = 'xdg-open';
    args = [absPath];
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

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

function isTaskChecklistParallelism(value: unknown): value is TaskChecklistParallelism {
  return (
    typeof value === 'string' && (TASK_CHECKLIST_PARALLELISM as readonly string[]).includes(value)
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

function providerIds(value: unknown): ProviderId[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ProviderId => typeof item === 'string' && isProviderId(item));
}

function capabilityTags(value: unknown): ProviderCapabilityTag[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ProviderCapabilityTag => typeof item === 'string');
}

function quotaResetMillis(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 10_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
}

function mergeQuotaWindow(
  health: ProviderHealth,
  prefix: 'quota5h' | 'quota7d' | 'quotaDaily',
  quota: { percent?: number; resetsAt?: number; windowMinutes?: number } | undefined,
  now: number,
): void {
  if (!quota) return;
  const resetsAt = quotaResetMillis(quota.resetsAt);
  const expired = resetsAt !== undefined && resetsAt <= now;
  if (expired) return;

  const percentKey = `${prefix}Percent` as
    | 'quota5hPercent'
    | 'quota7dPercent'
    | 'quotaDailyPercent';
  const resetsAtKey = `${prefix}ResetsAt` as
    | 'quota5hResetsAt'
    | 'quota7dResetsAt'
    | 'quotaDailyResetsAt';
  const windowKey = `${prefix}WindowMinutes` as
    | 'quota5hWindowMinutes'
    | 'quota7dWindowMinutes'
    | 'quotaDailyWindowMinutes';
  if (quota.percent !== undefined && Number.isFinite(quota.percent)) {
    health[percentKey] = Math.max(
      health[percentKey] ?? 0,
      Math.max(0, Math.min(100, quota.percent)),
    );
  }
  if (resetsAt !== undefined) health[resetsAtKey] = resetsAt;
  if (
    quota.windowMinutes !== undefined &&
    Number.isFinite(quota.windowMinutes) &&
    quota.windowMinutes > 0
  ) {
    health[windowKey] = Math.trunc(quota.windowMinutes);
  }
}

function sanitizeProviderScoreSlot(
  raw: ProviderScoreSlotBody,
  index: number,
): { id: string; currentProviderId: ProviderId | null; slot: ProviderScoringSlot } {
  const id =
    typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 100) : `slot-${index + 1}`;
  const currentProviderId =
    typeof raw.providerId === 'string' && isProviderId(raw.providerId) ? raw.providerId : null;
  const slot: ProviderScoringSlot = { id };
  if (typeof raw.personaId === 'string' && raw.personaId.trim()) {
    slot.personaId = raw.personaId.trim().slice(0, 120);
  }
  const preferredProviders = providerIds(raw.preferredProviders);
  if (preferredProviders.length > 0) slot.preferredProviders = preferredProviders;
  const fallbackProviders = providerIds(raw.fallbackProviders);
  if (fallbackProviders.length > 0) slot.fallbackProviders = fallbackProviders;
  const avoidProviders = providerIds(raw.avoidProviders);
  if (avoidProviders.length > 0) slot.avoidProviders = avoidProviders;
  const tags = capabilityTags(raw.capabilityTags);
  if (tags.length > 0) slot.capabilityTags = tags;
  return { id, currentProviderId, slot };
}

function providerHealthFromSnapshot(
  snapshot: ReturnType<typeof buildStatusSnapshot>,
  db: Database,
): Partial<Record<ProviderId, ProviderHealth>> {
  const now = Date.now();
  const agentProviderById = new Map<AgentId, ProviderId>();
  for (const room of snapshot.rooms) {
    for (const profile of room.agentProfiles) {
      agentProviderById.set(profile.id, profile.providerId);
    }
  }

  const healthByProvider: Partial<Record<ProviderId, ProviderHealth>> = {};
  const ensure = (providerId: ProviderId): ProviderHealth => {
    const existing = healthByProvider[providerId];
    if (existing) return existing;
    const health: ProviderHealth = {};
    healthByProvider[providerId] = health;
    return health;
  };

  for (const entry of snapshot.contextUsage.byAgent) {
    const providerId = isProviderId(entry.usage.provider)
      ? entry.usage.provider
      : agentProviderById.get(entry.agentId);
    if (!providerId) continue;
    const health = ensure(providerId);
    if (entry.usage.percentUsed !== undefined) {
      health.contextPercent = Math.max(health.contextPercent ?? 0, entry.usage.percentUsed);
    }
    const quota = entry.usage.quota;
    mergeQuotaWindow(health, 'quota5h', quota?.fiveHour, now);
    mergeQuotaWindow(health, 'quota7d', quota?.sevenDay, now);
    mergeQuotaWindow(health, 'quotaDaily', quota?.daily, now);
    const quotaStatus =
      quota?.fiveHour?.status ??
      quota?.sevenDay?.status ??
      quota?.daily?.status ??
      quota?.rateLimitReachedType;
    const activeCapacityBlock = capacityBlockFromContextUsage(entry.usage, now, entry.createdAt);
    if (quotaStatus && (activeCapacityBlock || /allowed|ok|available/i.test(quotaStatus))) {
      health.quotaStatus = quotaStatus;
      if (activeCapacityBlock) health.available = false;
    }
  }

  const runRows = db
    .prepare(
      `SELECT agent_id, status
       FROM agent_runs
       ORDER BY started_at DESC, id DESC
       LIMIT 200`,
    )
    .all() as Array<{ agent_id: AgentId; status: string }>;
  for (const row of runRows) {
    const providerId = agentProviderById.get(row.agent_id);
    if (!providerId) continue;
    const health = ensure(providerId);
    health.recentRuns = (health.recentRuns ?? 0) + 1;
    if (row.status === 'failed') health.recentFailures = (health.recentFailures ?? 0) + 1;
  }
  for (const health of Object.values(healthByProvider)) {
    if (!health) continue;
    const runs = health.recentRuns ?? 0;
    if (runs > 0) health.recentFailureRate = (health.recentFailures ?? 0) / runs;
  }

  return healthByProvider;
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

  app.get('/api/agents/catalog', async () => {
    return {
      providers: AGENT_PROVIDERS,
      personas: AGENT_PERSONAS,
    };
  });

  app.post<{ Body: ProviderScoreBody }>('/api/agents/provider-score', async (req) => {
    const rawSlots = Array.isArray(req.body?.slots)
      ? (req.body.slots as ProviderScoreSlotBody[]).slice(0, 50)
      : [];
    const slots = rawSlots.map((raw, index) =>
      sanitizeProviderScoreSlot(
        raw && typeof raw === 'object' ? (raw as ProviderScoreSlotBody) : {},
        index,
      ),
    );
    const providerCounts: Partial<Record<ProviderId, number>> = {};
    for (const slot of slots) {
      if (!slot.currentProviderId) continue;
      providerCounts[slot.currentProviderId] = (providerCounts[slot.currentProviderId] ?? 0) + 1;
    }

    const snapshot = buildStatusSnapshot({ db: deps.db });
    const healthByProvider = providerHealthFromSnapshot(snapshot, deps.db);
    const providers = AGENT_PROVIDERS.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
    }));

    return {
      generatedAt: Date.now(),
      providerHealth: healthByProvider,
      slots: slots.map((slot) => {
        const teamCounts = { ...providerCounts };
        if (slot.currentProviderId) {
          teamCounts[slot.currentProviderId] = Math.max(
            0,
            (teamCounts[slot.currentProviderId] ?? 0) - 1,
          );
        }
        const result = scoreProvidersForSlot({
          providers,
          slot: slot.slot,
          healthByProvider,
          currentTeamProviderCounts: teamCounts,
        });
        return {
          id: slot.id,
          currentProviderId: slot.currentProviderId,
          recommendationMatchesCurrent:
            !!slot.currentProviderId && result.selectedProviderId === slot.currentProviderId,
          ...result,
        };
      }),
    };
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

  app.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; archivedAt?: number | null };
  }>('/api/projects/:id', async (req, reply) => {
    const name =
      typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 160) : undefined;
    const description =
      typeof req.body?.description === 'string'
        ? req.body.description.trim().slice(0, 1000)
        : undefined;
    let updated =
      name !== undefined || description !== undefined
        ? updateProject(deps.db, req.params.id, {
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
          })
        : null;

    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'archivedAt')) {
      const raw = req.body?.archivedAt;
      const archivedAt =
        raw === null || raw === undefined ? null : typeof raw === 'number' ? raw : Date.now();
      const archiveResult = deps.broker.setProjectArchived(req.params.id, archivedAt);
      if (!archiveResult) {
        return reply
          .code(req.params.id === 'general' ? 400 : 404)
          .send({
            error: req.params.id === 'general' ? 'cannot archive default project' : 'not found',
          });
      }
      updated = archiveResult;
    }

    if (!updated) {
      const existing = getProject(deps.db, req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not found' });
      return existing;
    }
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    if (req.params.id === 'general') {
      return reply.code(400).send({ error: 'cannot delete default project' });
    }
    const ok = deps.broker.deleteProject(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  app.post<{
    Body: {
      name: string;
      agents?: AgentId[];
      yoloAgents?: AgentId[];
      leadAgentId?: AgentId | null;
      agentProfiles?: RoomAgentProfile[];
      projectId?: string;
      humanName?: string;
    };
  }>('/api/rooms', async (req, reply) => {
    const { name, agents, yoloAgents, leadAgentId, agentProfiles, projectId, humanName } =
      req.body ??
      ({} as {
        name: string;
        agents?: AgentId[];
        yoloAgents?: AgentId[];
        leadAgentId?: AgentId | null;
        agentProfiles?: RoomAgentProfile[];
        projectId?: string;
        humanName?: string;
      });
    if (!name || (!Array.isArray(agents) && !Array.isArray(agentProfiles))) {
      return reply.code(400).send({ error: 'name and agents or agentProfiles are required' });
    }
    if (agents !== undefined && !Array.isArray(agents)) {
      return reply.code(400).send({ error: 'agents must be an array' });
    }
    if (agentProfiles !== undefined && !Array.isArray(agentProfiles)) {
      return reply.code(400).send({ error: 'agentProfiles must be an array' });
    }
    if (yoloAgents !== undefined && !Array.isArray(yoloAgents)) {
      return reply.code(400).send({ error: 'yoloAgents must be an array' });
    }
    if (projectId && !getProject(deps.db, projectId)) {
      return reply.code(400).send({ error: 'project not found' });
    }
    const normalizeInput: { agents?: AgentId[]; agentProfiles?: RoomAgentProfile[] } = {};
    if (agents !== undefined) normalizeInput.agents = agents;
    if (agentProfiles !== undefined) normalizeInput.agentProfiles = agentProfiles;
    const normalizedProfiles = normalizeRoomAgentProfiles(normalizeInput);
    const normalizedAgents = normalizedProfiles.map((profile) => profile.id);
    const normalizedLeadAgentId =
      typeof leadAgentId === 'string' && normalizedAgents.includes(leadAgentId)
        ? leadAgentId
        : null;
    if (leadAgentId && !normalizedLeadAgentId) {
      return reply.code(400).send({ error: 'leadAgentId must be one of the room agents' });
    }
    const validationInput: {
      agentProfiles: RoomAgentProfile[];
      humanName?: string | null;
    } = { agentProfiles: normalizedProfiles };
    if (humanName !== undefined) validationInput.humanName = humanName;
    const validationErrors = validateRoomParticipantNames(validationInput);
    if (validationErrors.length > 0) {
      return reply.code(400).send({ error: validationErrors[0], errors: validationErrors });
    }
    const createInput: Parameters<typeof createRoom>[1] = {
      name,
      yoloAgents: yoloAgents ?? [],
      leadAgentId: normalizedLeadAgentId,
      agentProfiles: normalizedProfiles,
    };
    if (projectId !== undefined) createInput.projectId = projectId;
    return createRoom(deps.db, createInput);
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
    Body: {
      agents?: AgentId[];
      yoloAgents?: AgentId[];
      leadAgentId?: AgentId | null;
      agentProfiles?: RoomAgentProfile[];
      projectId?: string;
      humanName?: string;
    };
  }>('/api/rooms/:id', async (req, reply) => {
    const { agents, yoloAgents, leadAgentId, agentProfiles, projectId, humanName } =
      req.body ??
      ({} as {
        agents?: AgentId[];
        yoloAgents?: AgentId[];
        leadAgentId?: AgentId | null;
        agentProfiles?: RoomAgentProfile[];
        projectId?: string;
        humanName?: string;
      });
    let updated = getRoom(deps.db, req.params.id);
    if (!updated) return reply.code(404).send({ error: 'not found' });
    const currentRoom = updated;
    if (agents !== undefined && !Array.isArray(agents)) {
      return reply.code(400).send({ error: 'agents must be an array' });
    }
    if (yoloAgents !== undefined && !Array.isArray(yoloAgents)) {
      return reply.code(400).send({ error: 'yoloAgents must be an array' });
    }
    if (agentProfiles !== undefined && !Array.isArray(agentProfiles)) {
      return reply.code(400).send({ error: 'agentProfiles must be an array' });
    }
    if (agents !== undefined || agentProfiles !== undefined) {
      const normalizedProfiles = normalizeRoomAgentProfiles({
        agents: agents ?? currentRoom.agents,
        agentProfiles:
          agentProfiles ??
          (agents !== undefined
            ? agents.map(
                (agentId) =>
                  currentRoom.agentProfiles.find((profile) => profile.id === agentId) ??
                  defaultAgentProfile(agentId),
              )
            : currentRoom.agentProfiles),
      });
      const validationInput: {
        agentProfiles: RoomAgentProfile[];
        humanName?: string | null;
      } = { agentProfiles: normalizedProfiles };
      if (humanName !== undefined) validationInput.humanName = humanName;
      const validationErrors = validateRoomParticipantNames(validationInput);
      if (validationErrors.length > 0) {
        return reply.code(400).send({ error: validationErrors[0], errors: validationErrors });
      }
      const normalizedAgentIds = normalizedProfiles.map((profile) => profile.id);
      const requestedLead =
        leadAgentId === undefined ? currentRoom.leadAgentId : leadAgentId || null;
      if (requestedLead && !normalizedAgentIds.includes(requestedLead)) {
        return reply.code(400).send({ error: 'leadAgentId must be one of the room agents' });
      }
      updated = deps.broker.setAgents(
        req.params.id,
        normalizedAgentIds,
        yoloAgents,
        normalizedProfiles,
        requestedLead,
      );
      if (!updated) return reply.code(404).send({ error: 'not found' });
    } else if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'leadAgentId')) {
      const requestedLead = leadAgentId || null;
      if (requestedLead && !updated.agents.includes(requestedLead)) {
        return reply.code(400).send({ error: 'leadAgentId must be one of the room agents' });
      }
      updated = deps.broker.setRoomLeadAgent(req.params.id, requestedLead);
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
      expectedTouches?: string[];
      parallelism?: TaskChecklistParallelism;
      conflictGroup?: string;
      workRole?: string;
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
      expectedTouches,
      parallelism,
      conflictGroup,
      workRole,
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
    if (expectedTouches !== undefined && !Array.isArray(expectedTouches)) {
      return reply.code(400).send({ error: 'expectedTouches must be an array' });
    }
    if (parallelism !== undefined && !isTaskChecklistParallelism(parallelism)) {
      return reply.code(400).send({ error: 'invalid parallelism' });
    }
    const item = deps.broker.createTaskChecklistItem(req.params.id, req.params.taskId, {
      planId: planId ?? null,
      phaseId: phaseId ?? null,
      title: title.slice(0, 240),
      ...(detail !== undefined ? { detail: String(detail).slice(0, 2000) } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(dependencyIds !== undefined ? { dependencyIds: dependencyIds.map(String) } : {}),
      ...(expectedTouches !== undefined
        ? { expectedTouches: expectedTouches.map((value) => String(value).slice(0, 500)) }
        : {}),
      ...(parallelism !== undefined ? { parallelism } : {}),
      ...(conflictGroup !== undefined
        ? { conflictGroup: String(conflictGroup).slice(0, 160) }
        : {}),
      ...(workRole !== undefined ? { workRole: String(workRole).slice(0, 80) } : {}),
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
      expectedTouches?: string[];
      parallelism?: TaskChecklistParallelism;
      conflictGroup?: string;
      workRole?: string;
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
      expectedTouches,
      parallelism,
      conflictGroup,
      workRole,
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
    if (expectedTouches !== undefined && !Array.isArray(expectedTouches)) {
      return reply.code(400).send({ error: 'expectedTouches must be an array' });
    }
    if (parallelism !== undefined && !isTaskChecklistParallelism(parallelism)) {
      return reply.code(400).send({ error: 'invalid parallelism' });
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
        ...(expectedTouches !== undefined
          ? { expectedTouches: expectedTouches.map((value) => String(value).slice(0, 500)) }
          : {}),
        ...(parallelism !== undefined ? { parallelism } : {}),
        ...(conflictGroup !== undefined
          ? { conflictGroup: String(conflictGroup).slice(0, 160) }
          : {}),
        ...(workRole !== undefined ? { workRole: String(workRole).slice(0, 80) } : {}),
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

  app.post<{ Params: { id: string; runId: string }; Body: { authorId?: string } }>(
    '/api/rooms/:id/runs/:runId/stop',
    async (req, reply) => {
      const result = deps.broker.stopAgentRun(
        req.params.id,
        req.params.runId,
        typeof req.body?.authorId === 'string' ? req.body.authorId.slice(0, 80) : 'human',
      );
      if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });
      return result.run;
    },
  );

  app.post<{ Params: { providerId: string } }>(
    '/api/providers/:providerId/recheck-quota',
    async (req, reply) => {
      if (!isProviderId(req.params.providerId)) {
        return reply.code(400).send({ error: `unknown provider: ${req.params.providerId}` });
      }
      return await deps.broker.recheckProviderQuota(req.params.providerId);
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

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/rooms/:id/routing-decisions',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      return deps.broker.listRoutingDecisions(req.params.id, Number.isFinite(limit) ? limit : 100);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/rooms/:id/mission-command-events',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      return deps.broker.listMissionCommandEvents(
        req.params.id,
        Number.isFinite(limit) ? limit : 100,
      );
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/rooms/:id/turn-outcomes',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      return deps.broker.listTurnOutcomes(req.params.id, Number.isFinite(limit) ? limit : 100);
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

  app.post<{ Params: { id: string }; Body: { path?: string } }>(
    '/api/rooms/:id/artifacts/open',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const requested = typeof req.body?.path === 'string' ? req.body.path.slice(0, 4000) : '';
      if (!requested) return reply.code(400).send({ error: 'path required' });

      const listing = deps.broker.listArtifacts(req.params.id);
      if (!listing) return reply.code(503).send({ error: 'context artifacts disabled' });

      const requestedAbs = path.resolve(requested);
      const allowed = listing.files.some((file) => path.resolve(file.path) === requestedAbs);
      if (!allowed) return reply.code(403).send({ error: 'artifact not in this room' });

      try {
        openInOs(requestedAbs);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: message });
      }
    },
  );

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

  app.patch<{
    Params: { id: string; messageId: string };
    Body: { authorId: string; text: string };
  }>('/api/rooms/:id/messages/:messageId', async (req, reply) => {
    const { authorId, text } = req.body ?? {};
    if (!authorId || typeof text !== 'string') {
      return reply.code(400).send({ error: 'authorId and text required' });
    }
    try {
      return deps.broker.editQueuedHumanMessage(
        req.params.id,
        req.params.messageId,
        authorId,
        text,
      );
    } catch (err) {
      if (err instanceof QueuedMessageMutationError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.delete<{
    Params: { id: string; messageId: string };
    Body: { authorId: string };
  }>('/api/rooms/:id/messages/:messageId', async (req, reply) => {
    const { authorId } = req.body ?? {};
    if (!authorId) return reply.code(400).send({ error: 'authorId required' });
    try {
      return deps.broker.retractQueuedHumanMessage(req.params.id, req.params.messageId, authorId);
    } catch (err) {
      if (err instanceof QueuedMessageMutationError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  ensureDefaultToolsRegistered();
  registerMcpRoute(app, deps);

  return app;
}

const LOOPBACK_IPS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
]);

function isLoopbackRequest(req: FastifyRequest): boolean {
  const ip = req.ip ?? '';
  return LOOPBACK_IPS.has(ip);
}

function registerMcpRoute(
  app: ReturnType<typeof Fastify>,
  deps: HttpDeps,
): void {
  const apiKey = deps.mcpApiKey ?? null;

  app.post('/api/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    // Layered trust per docs/phase-6-mcp-endpoint-design-2026-05-07.md §2:
    // loopback unauthenticated; non-loopback requires Bearer FIRESIDE_MCP_API_KEY
    // (and refuses outright when no key is configured).
    if (!isLoopbackRequest(req)) {
      if (!apiKey) {
        return reply
          .code(403)
          .send({ error: 'non-loopback /api/mcp calls require FIRESIDE_MCP_API_KEY' });
      }
      const header = req.headers['authorization'];
      const value = Array.isArray(header) ? header[0] : header;
      if (value !== `Bearer ${apiKey}`) {
        return reply.code(401).send({ error: 'invalid or missing bearer token' });
      }
    }

    const parsed = parseJsonRpcRequest(req.body);
    if (!parsed.ok) {
      return reply.code(400).send(parsed.error);
    }

    const agentIdHeader = pickHeader(req, 'x-fireside-agent-id') ?? 'mcp-client';
    const roomIdHeader = pickHeader(req, 'x-fireside-room-id') ?? '';
    const missionIdHeader = pickHeader(req, 'x-fireside-mission-id') ?? null;

    // Auth was already enforced above (loopback or bearer-token gate). Treat
    // an authenticated MCP caller as holding the full state-permission set —
    // the single-tenant trust model documented in
    // docs/phase-6-mcp-endpoint-design-2026-05-07.md §2.
    const response = await dispatchMcpRequest(parsed.value, {
      db: deps.db,
      agentId: agentIdHeader,
      roomId: roomIdHeader,
      missionId: missionIdHeader,
      statePermissions: DEFAULT_YOLO_STATE_PERMISSIONS,
    });

    // JSON-RPC notifications return null from the dispatcher. Per the MCP
    // streamable-HTTP transport, the server must respond with 202 Accepted
    // and an empty body — never a JSON-RPC response envelope.
    if (response === null) {
      return reply.code(202).send();
    }

    return reply.code(200).send(response);
  });
}

function pickHeader(req: FastifyRequest, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0]?.trim() || null;
  if (typeof value === 'string') return value.trim() || null;
  return null;
}
