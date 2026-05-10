import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';

import {
  AgentRun,
  AgentRunAction,
  AgentRunDetail,
  AgentCatalog,
  ProviderScoreRequest,
  ProviderScoreResponse,
  Artifact,
  ArtifactListing,
  AgentTurnOutcome,
  AuditStreamResponse,
  CollaborationItem,
  ConversationFixture,
  Message,
  MessageRetractionUpdate,
  MissionBriefing,
  MissionBriefingSummary,
  MissionCommandEvent,
  PermissionRequest,
  PickerResult,
  PostMessageRequest,
  Project,
  RoutingDecision,
  Room,
  SearchResponse,
  StatusSnapshot,
  Task,
  TaskChecklistItem,
  TaskControl,
  TaskPhase,
  TaskPlan,
} from './api.types';

@Injectable({ providedIn: 'root' })
export class FiresideApi {
  private readonly http = inject(HttpClient);

  readonly system = {
    pickFolder: (initialPath = '') =>
      this.http.post<PickerResult>(
        '/api/system/folder-picker',
        { initialPath },
        { headers: { 'X-Fireside-Request': '1' } },
      ),
    pickFile: (initialPath = '') =>
      this.http.post<PickerResult>(
        '/api/system/file-picker',
        { initialPath },
        { headers: { 'X-Fireside-Request': '1' } },
      ),
  };

  readonly rooms = {
    list: () => this.http.get<Room[]>('/api/rooms'),
    create: (
      body: Pick<Room, 'name' | 'agents' | 'yoloAgents' | 'leadAgentId'> &
        Partial<Pick<Room, 'agentProfiles'>> & { projectId?: string; humanName?: string },
    ) =>
      this.http.post<Room>('/api/rooms', body),
    update: (
      roomId: string,
      body: Partial<
        Pick<Room, 'name' | 'agents' | 'yoloAgents' | 'leadAgentId' | 'agentProfiles' | 'projectId'>
      > & {
        humanName?: string;
      },
    ) => this.http.patch<Room>(`/api/rooms/${roomId}`, body),
    delete: (roomId: string) => this.http.delete<void>(`/api/rooms/${roomId}`),
  };

  readonly projects = {
    list: () => this.http.get<Project[]>('/api/projects'),
    create: (body: Pick<Project, 'name'> & Partial<Pick<Project, 'description'>>) =>
      this.http.post<Project>('/api/projects', body),
    update: (projectId: string, body: Partial<Pick<Project, 'name' | 'description'>>) =>
      this.http.patch<Project>(`/api/projects/${projectId}`, body),
    archive: (projectId: string) =>
      this.http.patch<Project>(`/api/projects/${projectId}`, { archivedAt: Date.now() }),
    unarchive: (projectId: string) =>
      this.http.patch<Project>(`/api/projects/${projectId}`, { archivedAt: null }),
    delete: (projectId: string) => this.http.delete<void>(`/api/projects/${projectId}`),
  };

  readonly state = {
    get: () => this.http.get<StatusSnapshot>('/api/state'),
  };

  readonly briefings = {
    list: () => this.http.get<MissionBriefingSummary[]>('/api/briefings'),
    detail: (briefingId: string) => this.http.get<MissionBriefing>(`/api/briefings/${briefingId}`),
    create: (
      roomId: string,
      body: { taskId?: string | null; title?: string; summary?: string; createdBy: string },
    ) => this.http.post<MissionBriefing>(`/api/rooms/${roomId}/briefings`, body),
  };

  readonly permissions = {
    list: (roomId: string) =>
      this.http.get<PermissionRequest[]>(`/api/rooms/${roomId}/permission-requests`),
    decide: (
      roomId: string,
      requestId: string,
      decision: 'approved' | 'denied',
      decidedBy: string,
    ) =>
      this.http.post<PermissionRequest>(
        `/api/rooms/${roomId}/permission-requests/${requestId}/decision`,
        {
          decision,
          decidedBy,
        },
      ),
  };

  readonly messages = {
    list: (roomId: string) => this.http.get<Message[]>(`/api/rooms/${roomId}/messages`),
    post: (body: PostMessageRequest) =>
      this.http.post<Message>(`/api/rooms/${body.roomId}/messages`, {
        authorId: body.authorId,
        text: body.text,
      }),
    update: (roomId: string, messageId: string, body: { authorId: string; text: string }) =>
      this.http.patch<Message>(`/api/rooms/${roomId}/messages/${messageId}`, body),
    retract: (roomId: string, messageId: string, authorId: string) =>
      this.http.delete<MessageRetractionUpdate>(`/api/rooms/${roomId}/messages/${messageId}`, {
        body: { authorId },
      }),
  };

  readonly tasks = {
    list: (roomId: string) => this.http.get<Task[]>(`/api/rooms/${roomId}/tasks`),
    create: (roomId: string, body: Partial<Task>) =>
      this.http.post<Task>(`/api/rooms/${roomId}/tasks`, body),
    update: (roomId: string, taskId: string, body: Partial<Task>) =>
      this.http.patch<Task>(`/api/rooms/${roomId}/tasks/${taskId}`, body),
    control: (roomId: string, taskId: string) =>
      this.http.get<TaskControl>(`/api/rooms/${roomId}/tasks/${taskId}/control`),
    updateChecklistItem: (
      roomId: string,
      taskId: string,
      itemId: string,
      body: Partial<TaskChecklistItem>,
    ) =>
      this.http.patch<TaskChecklistItem>(
        `/api/rooms/${roomId}/tasks/${taskId}/checklist/${itemId}`,
        body,
      ),
    createPhase: (roomId: string, taskId: string, body: Partial<TaskPhase>) =>
      this.http.post<TaskPhase>(`/api/rooms/${roomId}/tasks/${taskId}/phases`, body),
    createChecklistItem: (roomId: string, taskId: string, body: Partial<TaskChecklistItem>) =>
      this.http.post<TaskChecklistItem>(`/api/rooms/${roomId}/tasks/${taskId}/checklist`, body),
    createPlan: (roomId: string, taskId: string, body: Partial<TaskPlan>) =>
      this.http.post<TaskPlan>(`/api/rooms/${roomId}/tasks/${taskId}/plans`, body),
  };

  readonly runs = {
    list: (roomId: string) => this.http.get<AgentRun[]>(`/api/rooms/${roomId}/runs`),
    detail: (roomId: string, runId: string) =>
      this.http.get<AgentRunDetail>(`/api/rooms/${roomId}/runs/${runId}`),
    dismiss: (roomId: string, runId: string, authorId: string) =>
      this.http.post<AgentRun>(`/api/rooms/${roomId}/runs/${runId}/dismiss`, { authorId }),
    stop: (roomId: string, runId: string, authorId: string) =>
      this.http.post<AgentRun>(`/api/rooms/${roomId}/runs/${runId}/stop`, { authorId }),
    actions: (roomId: string, limit = 250) =>
      this.http.get<AgentRunAction[]>(`/api/rooms/${roomId}/actions`, { params: { limit } }),
  };

  readonly agents = {
    catalog: () => this.http.get<AgentCatalog>('/api/agents/catalog'),
    providerScore: (body: ProviderScoreRequest) =>
      this.http.post<ProviderScoreResponse>('/api/agents/provider-score', body),
    compact: (roomId: string, agentId: string, authorId: string) =>
      this.http.post<AgentRun>(`/api/rooms/${roomId}/agents/${agentId}/compact`, { authorId }),
  };

  readonly providers = {
    recheckQuota: (providerId: string) =>
      this.http.post<{
        ok: boolean;
        cleared: number;
        status?: string;
        resetsAt?: number | null;
        detail?: string;
      }>(`/api/providers/${providerId}/recheck-quota`, {}),
  };

  readonly artifacts = {
    list: (roomId: string) => this.http.get<ArtifactListing>(`/api/rooms/${roomId}/artifacts`),
    attachFixture: (roomId: string, sourcePath: string) =>
      this.http.post<ConversationFixture>(`/api/rooms/${roomId}/fixtures`, { sourcePath }),
    remove: (roomId: string, artifact: Artifact) =>
      this.http.delete<{ ok: boolean }>(`/api/rooms/${roomId}/artifacts`, {
        body: { kind: artifact.kind, path: artifact.path },
      }),
    open: (roomId: string, artifact: Artifact) =>
      this.http.post<{ ok: boolean }>(`/api/rooms/${roomId}/artifacts/open`, {
        path: artifact.path,
      }),
  };

  readonly collaboration = {
    list: (roomId: string, taskId?: string | null) =>
      this.http.get<CollaborationItem[]>(`/api/rooms/${roomId}/collaboration`, {
        params: taskId ? { taskId } : {},
      }),
  };

  readonly search = {
    universal: (
      query: string,
      opts: { scope?: string[]; roomId?: string; taskId?: string; limit?: number } = {},
    ) => {
      const params: Record<string, string | number> = { q: query };
      if (opts.scope && opts.scope.length > 0) params['scope'] = opts.scope.join(',');
      if (opts.roomId) params['roomId'] = opts.roomId;
      if (opts.taskId) params['taskId'] = opts.taskId;
      if (opts.limit !== undefined) params['limit'] = opts.limit;
      return this.http.get<SearchResponse>('/api/search', { params });
    },
  };

  readonly audit = {
    stream: (
      roomId: string,
      opts: { kinds?: string[]; agentId?: string; taskId?: string; limit?: number } = {},
    ) => {
      const params: Record<string, string | number> = {};
      if (opts.kinds && opts.kinds.length > 0) params['kinds'] = opts.kinds.join(',');
      if (opts.agentId) params['agentId'] = opts.agentId;
      if (opts.taskId) params['taskId'] = opts.taskId;
      if (opts.limit !== undefined) params['limit'] = opts.limit;
      return this.http.get<AuditStreamResponse>(`/api/rooms/${roomId}/audit`, { params });
    },
  };

  readonly diagnostics = {
    routingDecisions: (roomId: string, limit = 50) =>
      this.http.get<RoutingDecision[]>(`/api/rooms/${roomId}/routing-decisions`, {
        params: { limit },
      }),
    missionCommandEvents: (roomId: string, limit = 50) =>
      this.http.get<MissionCommandEvent[]>(`/api/rooms/${roomId}/mission-command-events`, {
        params: { limit },
      }),
    turnOutcomes: (roomId: string, limit = 50) =>
      this.http.get<AgentTurnOutcome[]>(`/api/rooms/${roomId}/turn-outcomes`, {
        params: { limit },
      }),
  };
}
