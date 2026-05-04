// client/app/agent-display.service.ts
// Single source of truth for agent identity rendering: display name, avatar
// class, persona, rail kind/status/detail, owner/temporary/running checks,
// mention helpers, and draft-row metadata. All resolution flows through
// this service so children inject it instead of receiving 20+ helper fns
// per binding site.
//
// State source: MissionStore. The service reads the store's catalog,
// rooms, runs, snapshot, and selection signals; no UI state lives here.

import { Injectable, inject } from '@angular/core';

import { DEFAULT_AGENT_CATALOG } from './catalog-defaults';
import { MissionStore } from './mission-store';
import type { DraftRoomAgent } from './room-agent-types';
import type {
  AgentId,
  AgentPersona,
  AgentProviderCatalogItem,
  Message,
  ProviderId,
  Room,
  RoomAgentProfile,
  StatusSnapshotAgentState,
} from './api.types';
import type { MentionSuggestion } from './chat-types';

export type AgentRailKind =
  | 'running'
  | 'yolo'
  | 'idle'
  | 'ready'
  | 'waiting'
  | 'blocked'
  | 'stale';

@Injectable({ providedIn: 'root' })
export class AgentDisplayService {
  private readonly store = inject(MissionStore);

  // ---- Catalog lookups ----------------------------------------------------

  providerForId(providerId: ProviderId): AgentProviderCatalogItem {
    return (
      this.store.agentCatalog().providers.find((provider) => provider.id === providerId) ?? {
        id: providerId,
        displayName: providerId,
        summary: '',
      }
    );
  }

  personaForId(personaId: string): AgentPersona {
    return (
      this.store.agentCatalog().personas.find((persona) => persona.id === personaId) ??
      DEFAULT_AGENT_CATALOG.personas[0]!
    );
  }

  // ---- Profile resolution -------------------------------------------------

  roomAgentProfile(room: Room | null | undefined, agentId: AgentId): RoomAgentProfile {
    const providerId = this.providerIdFromAgentId(agentId);
    const provider = this.providerForId(providerId);
    const generalist = this.personaForId('generalist');
    return (
      room?.agentProfiles?.find((profile) => profile.id === agentId) ?? {
        id: agentId,
        providerId,
        displayName: agentId === providerId ? provider.displayName : agentId,
        personaId: generalist.id,
        personaName: generalist.name,
        personaSummary: generalist.summary,
      }
    );
  }

  agentProfile(agentId: AgentId): RoomAgentProfile {
    return this.roomAgentProfile(this.store.selectedRoom(), agentId);
  }

  agentProviderId(agentId: AgentId): ProviderId {
    return this.agentProfile(agentId).providerId;
  }

  private providerIdFromAgentId(agentId: AgentId): ProviderId {
    const lower = agentId.toLowerCase();
    if (lower === 'claude' || lower.startsWith('claude-')) return 'claude';
    if (lower === 'codex' || lower.startsWith('codex-')) return 'codex';
    if (lower === 'gemini' || lower.startsWith('gemini-')) return 'gemini';
    return lower;
  }

  // ---- Render helpers -----------------------------------------------------

  name(agentId: AgentId): string {
    return this.agentProfile(agentId).displayName;
  }

  nameForRoom(room: Room | null | undefined, agentId: AgentId): string {
    return this.roomAgentProfile(room, agentId).displayName;
  }

  personaName(agentId: AgentId): string {
    return this.agentProfile(agentId).personaName;
  }

  isTemporary(agentId: AgentId): boolean {
    return this.agentProfile(agentId).temporary === true;
  }

  temporaryTitle(agentId: AgentId): string {
    const profile = this.agentProfile(agentId);
    if (!profile.temporary) return '';
    const by = profile.spawnedBy ? ` by ${this.name(profile.spawnedBy)}` : '';
    const scope = profile.spawnedScope ? ` for ${profile.spawnedScope}` : '';
    return `Temporary agent${by}${scope}`;
  }

  avatarClass(agentId: AgentId, size: 'sm' | 'tiny' | '' = ''): string {
    const sizeClass = size ? ` avatar--${size}` : '';
    return `avatar${sizeClass} avatar--${this.agentProviderId(agentId)}`;
  }

  // ---- Workflow / rail status --------------------------------------------

  isAgentRunning(agentId: AgentId): boolean {
    return this.store.runningRuns().some((run) => run.agentId === agentId);
  }

  isRoomYoloAgent(agentId: AgentId): boolean {
    return this.store.roomYoloAgents().includes(agentId);
  }

  isAgentOwner(agentId: AgentId): boolean {
    return (this.store.selectedRoom()?.agents ?? []).includes(agentId);
  }

  canCompactAgent(agentId: AgentId): boolean {
    const providerId = this.agentProviderId(agentId);
    return providerId === 'claude' || providerId === 'codex';
  }

  workflowState(agentId: AgentId): StatusSnapshotAgentState | null {
    return (
      this.store.selectedRoomSnapshot()?.agentStates.find(
        (state) => state.agentId === agentId,
      ) ?? null
    );
  }

  railStatus(agentId: AgentId): string {
    if (this.store.compactingAgent() === agentId) return 'compacting';
    const state = this.workflowState(agentId);
    if (state) return state.label;
    if (this.isAgentRunning(agentId)) return 'working';
    if (this.isRoomYoloAgent(agentId)) return 'yolo';
    return 'idle';
  }

  railDetail(agentId: AgentId): string {
    const state = this.workflowState(agentId);
    return state?.detail ?? this.railStatus(agentId);
  }

  railKind(agentId: AgentId): AgentRailKind {
    const state = this.workflowState(agentId);
    if (state?.state === 'working') return 'running';
    if (state?.state === 'stale') return 'stale';
    if (state?.state === 'incapacitated') return 'blocked';
    if (state?.state === 'blocked') return state.severity === 'danger' ? 'blocked' : 'waiting';
    if (state?.state === 'waiting_on_human' || state?.state === 'waiting_on_agent')
      return 'waiting';
    if (state?.state === 'idle_ready') return 'ready';
    if (this.isAgentRunning(agentId)) return 'running';
    if (this.isRoomYoloAgent(agentId)) return 'yolo';
    return 'idle';
  }

  // ---- Seen-by + message helpers -----------------------------------------

  messageSeenAgents(message: Message): AgentId[] {
    const seen = new Set<AgentId>(message.seenBy ?? []);
    for (const run of this.store.runs()) {
      if (run.triggerMessageId !== message.id) continue;
      if (run.agentId === message.authorId) continue;
      seen.add(run.agentId);
    }
    seen.delete(message.authorId);
    const roomOrder = this.store.selectedRoom()?.agents ?? [];
    return [
      ...roomOrder.filter((agentId) => seen.has(agentId)),
      ...[...seen].filter((agentId) => !roomOrder.includes(agentId)).sort(),
    ];
  }

  seenAgentsLabel(agents: AgentId[]): string {
    if (agents.length === 0) return 'Seen by nobody';
    return `Seen by ${agents.map((agentId) => this.name(agentId)).join(', ')}`;
  }

  // ---- Mention slug + handle helpers -------------------------------------

  mentionSlug(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  mentionHandleForProfile(
    profile: RoomAgentProfile,
    providerCounts: Map<ProviderId, number>,
  ): string {
    const displaySlug = this.mentionSlug(profile.displayName);
    const providerIsAmbiguous = (providerCounts.get(profile.providerId) ?? 0) > 1;
    if (displaySlug && (!providerIsAmbiguous || displaySlug !== profile.providerId)) {
      return displaySlug;
    }
    return this.mentionSlug(profile.id) || profile.id.toLowerCase();
  }

  mentionSuggestionsForRoom(room: Room | null, query: string): MentionSuggestion[] {
    if (!room) return [];
    const lowered = query.toLowerCase();
    const providerCounts = new Map<ProviderId, number>();
    for (const agentId of room.agents) {
      const providerId = this.roomAgentProfile(room, agentId).providerId;
      providerCounts.set(providerId, (providerCounts.get(providerId) ?? 0) + 1);
    }
    return room.agents
      .map((agentId): MentionSuggestion => {
        const profile = this.roomAgentProfile(room, agentId);
        const handle = this.mentionHandleForProfile(profile, providerCounts);
        return {
          agentId,
          handle,
          label: profile.displayName,
          detail:
            profile.personaId === 'generalist'
              ? `${this.draftProviderLabel(profile.providerId)} / ${agentId}`
              : `${this.draftProviderLabel(profile.providerId)} ${profile.personaName} / ${agentId}`,
        };
      })
      .filter((suggestion) =>
        [
          suggestion.handle,
          suggestion.label,
          suggestion.agentId,
          this.agentProviderId(suggestion.agentId),
          this.personaName(suggestion.agentId),
        ].some((value) => value.toLowerCase().includes(lowered)),
      )
      .slice(0, 8);
  }

  // ---- Draft-row helpers (for create-room / edit-agents modals) ----------

  draftProviderLabel(providerId: ProviderId): string {
    return (
      this.store.agentCatalog().providers.find((provider) => provider.id === providerId)
        ?.displayName ?? providerId
    );
  }

  draftPersonaLabel(personaId: string): string {
    return this.personaForId(personaId).name;
  }

  draftProviderAvatarClass(row: DraftRoomAgent): string {
    return `avatar avatar--sm avatar--${row.providerId}`;
  }
}
