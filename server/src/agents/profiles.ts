import { getAgentPersona, isProviderId, providerDisplayName } from './personas.js';
import type { AgentId, ProviderId, RoomAgentProfile } from './types.js';

const DEFAULT_AUTO_COMPACT_PERCENT = 70;

interface RawRoomAgentProfile {
  id?: unknown;
  providerId?: unknown;
  displayName?: unknown;
  personaId?: unknown;
  modelId?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
  effort?: unknown;
  autoCompactEnabled?: unknown;
  autoCompactPercent?: unknown;
  temporary?: unknown;
  spawnedBy?: unknown;
  spawnedByPersonaId?: unknown;
  spawnedAt?: unknown;
  spawnedReason?: unknown;
  spawnedScope?: unknown;
  dismissWhen?: unknown;
  maxTurns?: unknown;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function displayNameKey(value: string): string {
  return cleanDisplayName(value).toLowerCase();
}

function duplicateDisplayName(base: string, counter: number): string {
  if (counter === 2) return `${base} Jr.`;
  if (counter === 3) return `${base} III`;
  return `${base} ${counter}`;
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

function cleanDisplayName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

function cleanText(value: unknown, maxChars = 500): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxChars) : '';
}

function cleanModelId(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, '').trim().slice(0, 120) : '';
}

function cleanReasoningEffort(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

function positiveInteger(value: unknown): number | undefined {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value.trim())
        : NaN;
  if (!Number.isFinite(number)) return undefined;
  const integer = Math.floor(number);
  return integer > 0 ? integer : undefined;
}

function cleanPercent(value: unknown): number | undefined {
  const integer = positiveInteger(value);
  if (integer === undefined) return undefined;
  return Math.max(1, Math.min(100, integer));
}

function uniqueDisplayName(base: string, seen: Set<string>): string {
  const cleanBase = cleanDisplayName(base) || 'Agent';
  let candidate = cleanBase;
  let counter = 2;
  while (seen.has(displayNameKey(candidate))) {
    candidate = duplicateDisplayName(cleanBase, counter);
    counter += 1;
  }
  seen.add(displayNameKey(candidate));
  return candidate;
}

export function roomAgentHandleForProfile(
  profile: Pick<RoomAgentProfile, 'id' | 'providerId' | 'displayName'>,
  providerCounts: Map<ProviderId, number>,
): string {
  const displaySlug = slug(profile.displayName);
  const providerIsAmbiguous = (providerCounts.get(profile.providerId) ?? 0) > 1;
  if (displaySlug && (!providerIsAmbiguous || displaySlug !== profile.providerId)) {
    return displaySlug;
  }
  return slug(profile.id) || profile.id.toLowerCase();
}

export function validateRoomParticipantNames(input: {
  agentProfiles: Array<Pick<RoomAgentProfile, 'id' | 'providerId' | 'displayName'>>;
  humanName?: string | null;
}): string[] {
  const errors: string[] = [];
  const seenNames = new Map<string, string>();
  const seenHandles = new Map<string, string>();
  const providerCounts = new Map<ProviderId, number>();
  for (const profile of input.agentProfiles) {
    providerCounts.set(profile.providerId, (providerCounts.get(profile.providerId) ?? 0) + 1);
  }

  const addParticipant = (label: string, displayName: string, handle: string): void => {
    const cleanName = cleanDisplayName(displayName);
    if (!cleanName) {
      errors.push(`${label} needs a display name`);
      return;
    }
    const nameKey = displayNameKey(cleanName);
    const existingName = seenNames.get(nameKey);
    if (existingName) {
      errors.push(`${label} name "${cleanName}" conflicts with ${existingName}`);
    } else {
      seenNames.set(nameKey, label);
    }

    const handleKey = slug(handle || cleanName);
    if (!handleKey) {
      errors.push(`${label} needs a routeable @handle`);
      return;
    }
    const existingHandle = seenHandles.get(handleKey);
    if (existingHandle) {
      errors.push(`${label} handle @${handleKey} conflicts with ${existingHandle}`);
    } else {
      seenHandles.set(handleKey, label);
    }
  };

  const humanName = cleanDisplayName(input.humanName);
  if (humanName) addParticipant(`human "${humanName}"`, humanName, humanName);

  for (const profile of input.agentProfiles) {
    addParticipant(
      `agent "${cleanDisplayName(profile.displayName) || profile.id}"`,
      profile.displayName,
      roomAgentHandleForProfile(profile, providerCounts),
    );
  }

  return [...new Set(errors)];
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
  return providerId === 'claude' || providerId === 'codex' || providerId === 'gemini';
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
    autoCompactEnabled: true,
    autoCompactPercent: DEFAULT_AUTO_COMPACT_PERCENT,
  };
}

export function normalizeRoomAgentProfiles(input: {
  agents?: AgentId[];
  agentProfiles?: RawRoomAgentProfile[];
}): RoomAgentProfile[] {
  const seen = new Set<string>();
  const seenDisplayNames = new Set<string>();
  const profiles: RoomAgentProfile[] = [];
  const rawProfiles = Array.isArray(input.agentProfiles) ? input.agentProfiles : [];

  if (rawProfiles.length > 0) {
    for (const raw of rawProfiles) {
      const requestedId = typeof raw.id === 'string' ? raw.id : '';
      const providerCandidate = typeof raw.providerId === 'string' ? raw.providerId : '';
      if (!isProviderId(providerCandidate) || providerCandidate === 'echo') continue;
      const providerId = providerCandidate;
      const persona = getAgentPersona(typeof raw.personaId === 'string' ? raw.personaId : '');
      const base =
        requestedId ||
        (persona.id === 'generalist'
          ? providerId
          : `${providerId}-${persona.id.replace(/-(engineer|reviewer|specialist|expert)$/i, '')}`);
      const id = uniqueId(base, seen);
      const requestedName = cleanDisplayName(raw.displayName);
      const fallbackName =
        persona.id === 'generalist'
          ? providerDisplayName(providerId)
          : `${providerDisplayName(providerId)} ${persona.name}`;
      const maxTurns = positiveInteger(raw.maxTurns);
      const modelId = cleanModelId(raw.modelId ?? raw.model);
      const reasoningEffort = cleanReasoningEffort(raw.reasoningEffort ?? raw.effort);
      const autoCompactPercent = cleanPercent(raw.autoCompactPercent);
      const autoCompactEnabled =
        typeof raw.autoCompactEnabled === 'boolean' ? raw.autoCompactEnabled : true;
      profiles.push({
        id,
        providerId,
        displayName: uniqueDisplayName(requestedName || fallbackName, seenDisplayNames),
        personaId: persona.id,
        personaName: persona.name,
        personaSummary: persona.summary,
        ...(modelId ? { modelId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        autoCompactEnabled,
        autoCompactPercent: autoCompactPercent ?? DEFAULT_AUTO_COMPACT_PERCENT,
        ...(raw.temporary === true ? { temporary: true } : {}),
        ...(raw.spawnedBy ? { spawnedBy: cleanText(raw.spawnedBy, 80) } : {}),
        ...(raw.spawnedByPersonaId
          ? { spawnedByPersonaId: cleanText(raw.spawnedByPersonaId, 80) }
          : {}),
        ...(typeof raw.spawnedAt === 'number' && Number.isFinite(raw.spawnedAt)
          ? { spawnedAt: Math.max(0, Math.floor(raw.spawnedAt)) }
          : {}),
        ...(raw.spawnedReason ? { spawnedReason: cleanText(raw.spawnedReason, 800) } : {}),
        ...(raw.spawnedScope ? { spawnedScope: cleanText(raw.spawnedScope, 500) } : {}),
        ...(raw.dismissWhen ? { dismissWhen: cleanText(raw.dismissWhen, 300) } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
      });
    }
  }

  if (profiles.length === 0) {
    for (const agentId of input.agents ?? []) {
      if (typeof agentId !== 'string') continue;
      const cleanId = uniqueId(agentId, seen);
      const profile = defaultAgentProfile(cleanId);
      profiles.push({
        ...profile,
        displayName: uniqueDisplayName(profile.displayName, seenDisplayNames),
      });
    }
  }

  return profiles;
}

export function parseRoomAgentProfiles(json: string, agents: AgentId[]): RoomAgentProfile[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const profiles = normalizeRoomAgentProfiles({
        agentProfiles: parsed as RawRoomAgentProfile[],
      });
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
