import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';

import {
  AgentRun,
  AgentRunAction,
  AgentRunDetail,
  AgentCatalog,
  Artifact,
  ArtifactListing,
  CollaborationItem,
  ConversationFixture,
  Message,
  MessageRetractionUpdate,
  MissionBriefing,
  MissionBriefingSummary,
  PermissionRequest,
  PickerResult,
  PostMessageRequest,
  Project,
  Room,
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
      body: Pick<Room, 'name' | 'agents' | 'yoloAgents'> &
        Partial<Pick<Room, 'agentProfiles'>> & { projectId?: string },
    ) =>
      this.http.post<Room>('/api/rooms', body),
    update: (
      roomId: string,
      body: Partial<Pick<Room, 'name' | 'agents' | 'yoloAgents' | 'agentProfiles' | 'projectId'>>,
    ) => this.http.patch<Room>(`/api/rooms/${roomId}`, body),
    delete: (roomId: string) => this.http.delete<void>(`/api/rooms/${roomId}`),
  };

  readonly projects = {
    list: () => this.http.get<Project[]>('/api/projects'),
    create: (body: Pick<Project, 'name'> & Partial<Pick<Project, 'description'>>) =>
      this.http.post<Project>('/api/projects', body),
    update: (projectId: string, body: Partial<Pick<Project, 'name' | 'description'>>) =>
      this.http.patch<Project>(`/api/projects/${projectId}`, body),
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
    actions: (roomId: string, limit = 250) =>
      this.http.get<AgentRunAction[]>(`/api/rooms/${roomId}/actions`, { params: { limit } }),
  };

  readonly agents = {
    catalog: () => this.http.get<AgentCatalog>('/api/agents/catalog'),
    compact: (roomId: string, agentId: string, authorId: string) =>
      this.http.post<AgentRun>(`/api/rooms/${roomId}/agents/${agentId}/compact`, { authorId }),
  };

  readonly artifacts = {
    list: (roomId: string) => this.http.get<ArtifactListing>(`/api/rooms/${roomId}/artifacts`),
    attachFixture: (roomId: string, sourcePath: string) =>
      this.http.post<ConversationFixture>(`/api/rooms/${roomId}/fixtures`, { sourcePath }),
    remove: (roomId: string, artifact: Artifact) =>
      this.http.delete<{ ok: boolean }>(`/api/rooms/${roomId}/artifacts`, {
        body: { kind: artifact.kind, path: artifact.path },
      }),
  };

  readonly collaboration = {
    list: (roomId: string, taskId?: string | null) =>
      this.http.get<CollaborationItem[]>(`/api/rooms/${roomId}/collaboration`, {
        params: taskId ? { taskId } : {},
      }),
  };
}
