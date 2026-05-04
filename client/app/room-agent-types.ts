// client/app/room-agent-types.ts
// Shared draft-row shape for the create-room and edit-agents modals.

import type { AgentId, ProviderId } from './api.types';

export type DraftRoomAgent = {
  clientId: string;
  agentId?: AgentId;
  providerId: ProviderId;
  displayName: string;
  personaId: string;
  modelId?: string;
  reasoningEffort?: string;
  autoCompactEnabled: boolean;
  autoCompactPercent: number;
  yolo: boolean;
};
