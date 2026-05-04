// client/app/chat-types.ts
// Shared types for the chat surface (message-list + composer) so children
// don't have to reach back into app.ts for them.

import type { AgentId, Message, PermissionRequest, ProviderId } from './api.types';

export type MissionActivityTone = 'work' | 'done' | 'blocked' | 'phase' | 'retry' | 'mission' | 'plan';

export type MissionActivityEvent = {
  id: string;
  createdAt: number;
  agentId?: AgentId | undefined;
  tone: MissionActivityTone;
  title: string;
  detail?: string | undefined;
  runId?: string | undefined;
};

export type ChatTimelineItem = {
  id: string;
  kind: 'message' | 'permission' | 'activity';
  createdAt: number;
  message?: Message;
  request?: PermissionRequest;
  activity?: MissionActivityEvent;
  grouped: boolean;
  html?: string;
  isError?: boolean;
  seenAgents?: AgentId[];
};

export type ComposerMentionToken = {
  query: string;
  start: number;
  end: number;
};

export type MentionSuggestion = {
  agentId: AgentId;
  handle: string;
  label: string;
  detail: string;
};

export type RoomAgentProfileLite = {
  id: AgentId;
  displayName: string;
  providerId: ProviderId;
  personaId: string;
  personaName: string;
};
