import { getAgentPersona, isProviderId, providerDisplayName } from './personas.js';
import type { AgentId, ProviderId, RoomAgentProfile } from './types.js';

interface RawRoomAgentProfile {
  id?: unknown;
  providerId?: unknown;
  displayName?: unknown;
  personaId?: unknown;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function uniqueId(base: string, seen: Set<string>): AgentId {
  const cleanBase = slug(base) || 'agent';
  let candidate = cleanBase;
  let counter = 2;
  while (seen.has(candidate)) {
    candidate = `${cleanBase}-${counter}`;
    counter += 1;
  }
  seen.add(candidate);
  return candidate;
}

export function providerIdFromAgentId(agentId: AgentId): ProviderId | null {
  const lower = agentId.toLowerCase();
  if (isProviderId(lower)) return lower;
  for (const providerId of ['claude', 'codex', 'gemini', 'echo'] as const) {
    if (lower.startsWith(`${providerId}-`)) return providerId;
  }
  return null;
}

export function isCompactableProviderAgent(agentId: AgentId): boolean {
  const providerId = providerIdFromAgentId(agentId);
  return providerId === 'claude' || providerId === 'codex';
}

export function defaultAgentProfile(agentId: AgentId): RoomAgentProfile {
  const providerId = providerIdFromAgentId(agentId) ?? 'echo';
  const persona = getAgentPersona('generalist');
  return {
    id: agentId,
    providerId,
    displayName: agentId === providerId ? providerDisplayName(providerId) : agentId,
    personaId: persona.id,
    personaName: persona.name,
    personaSummary: persona.summary,
  };
}

export function normalizeRoomAgentProfiles(input: {
  agents?: AgentId[];
  agentProfiles?: RawRoomAgentProfile[];
}): RoomAgentProfile[] {
  const seen = new Set<string>();
  const profiles: RoomAgentProfile[] = [];
  const rawProfiles = Array.isArray(input.agentProfiles) ? input.agentProfiles : [];

  if (rawProfiles.length > 0) {
    for (const raw of rawProfiles) {
      const providerCandidate = typeof raw.providerId === 'string' ? raw.providerId : '';
      if (!isProviderId(providerCandidate) || providerCandidate === 'echo') continue;
      const providerId = providerCandidate;
      const persona = getAgentPersona(typeof raw.personaId === 'string' ? raw.personaId : '');
      const requestedId = typeof raw.id === 'string' ? raw.id : '';
      const base =
        requestedId ||
        (persona.id === 'generalist'
          ? providerId
          : `${providerId}-${persona.id.replace(/-(engineer|reviewer|specialist|expert)$/i, '')}`);
      const id = uniqueId(base, seen);
      const requestedName =
        typeof raw.displayName === 'string' ? raw.displayName.trim().slice(0, 80) : '';
      profiles.push({
        id,
        providerId,
        displayName:
          requestedName ||
          (persona.id === 'generalist'
            ? providerDisplayName(providerId)
            : `${providerDisplayName(providerId)} ${persona.name}`),
        personaId: persona.id,
        personaName: persona.name,
        personaSummary: persona.summary,
      });
    }
  }

  if (profiles.length === 0) {
    for (const agentId of input.agents ?? []) {
      if (typeof agentId !== 'string') continue;
      const cleanId = uniqueId(agentId, seen);
      profiles.push(defaultAgentProfile(cleanId));
    }
  }

  return profiles;
}

export function parseRoomAgentProfiles(json: string, agents: AgentId[]): RoomAgentProfile[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const profiles = normalizeRoomAgentProfiles({ agentProfiles: parsed as RawRoomAgentProfile[] });
      const byId = new Map(profiles.map((profile) => [profile.id, profile]));
      return agents.map((agentId) => byId.get(agentId) ?? defaultAgentProfile(agentId));
    }
  } catch {
    // Legacy rooms did not store profile metadata.
  }
  return agents.map(defaultAgentProfile);
}

export function compactPersonaPrompt(agentId: AgentId, profile: RoomAgentProfile): string {
  const persona = getAgentPersona(profile.personaId);
  if (persona.id === 'generalist') {
    return `Agent profile: ${profile.displayName} (${agentId}) uses provider ${profile.providerId} with the Generalist persona. This persona adds no special lens beyond the room and mission instructions.`;
  }
  return [
    `Agent profile: ${profile.displayName} (${agentId}) uses provider ${profile.providerId}.`,
    `Persona: ${persona.name} (${persona.category}). ${persona.summary}`,
    `Persona lens: ${persona.prompt}`,
    `Apply this lens while still obeying the Fireside mission, collaboration, permission, and state-update contracts.`,
  ].join('\n');
}
