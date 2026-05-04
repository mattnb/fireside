import type { AgentId } from '../agents/types.js';
import { defaultAgentProfile } from '../agents/profiles.js';
import {
  parseAgentReferences,
  parseAgentReferencesForAliases,
  parseMentionTokens,
} from '../mentions.js';
import type { Room } from '../repos/rooms.js';

export interface RoutingRuleTrace {
  id: string;
  result: 'matched' | 'skipped' | 'blocked';
  reason: string;
  agents?: AgentId[];
  aliases?: string[];
}

export interface RoomAgentReferenceResult {
  agentIds: AgentId[];
  ambiguousAliases: string[];
  explicitTokens: string[];
  trace: RoutingRuleTrace[];
}

export function mentionAliasSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function addAlias(index: Map<string, AgentId[]>, token: string, agentId: AgentId): void {
  if (!token) return;
  const matches = index.get(token) ?? [];
  if (!matches.includes(agentId)) matches.push(agentId);
  index.set(token, matches);
}

export function resolveRoomAgentReferences(room: Room, text: string): RoomAgentReferenceResult {
  const aliases = new Map<AgentId, string[]>();
  const aliasIndex = new Map<string, AgentId[]>();
  const providerCounts = new Map<string, number>();
  const trace: RoutingRuleTrace[] = [];

  for (const agentId of room.agents) {
    const profile =
      room.agentProfiles.find((candidate) => candidate.id === agentId) ??
      defaultAgentProfile(agentId);
    providerCounts.set(profile.providerId, (providerCounts.get(profile.providerId) ?? 0) + 1);
  }

  for (const agentId of room.agents) {
    const profile =
      room.agentProfiles.find((candidate) => candidate.id === agentId) ??
      defaultAgentProfile(agentId);
    const providerIsAmbiguous = (providerCounts.get(profile.providerId) ?? 0) > 1;
    const displayNameSlug = mentionAliasSlug(profile.displayName);
    const profileAliases = [agentId];
    if (!providerIsAmbiguous) profileAliases.push(profile.providerId);
    if (!providerIsAmbiguous || displayNameSlug !== profile.providerId) {
      profileAliases.push(
        profile.displayName,
        profile.displayName.replace(/\s+/g, '-'),
        displayNameSlug,
      );
    }
    aliases.set(agentId, profileAliases);
    for (const alias of profileAliases) addAlias(aliasIndex, mentionAliasSlug(alias), agentId);
  }

  const dynamic = parseAgentReferencesForAliases(text, aliases);
  if (dynamic.length > 0) {
    trace.push({
      id: 'alias-handoff',
      result: 'matched',
      reason: 'text matched a room-local display name or agent-id handoff',
      agents: dynamic,
    });
  }

  const ambiguousAliases = new Set<string>();
  const staticMatches: AgentId[] = [];
  const explicitTokens = parseMentionTokens(text);
  const explicitTokenSet = new Set(explicitTokens);

  for (const token of explicitTokens) {
    const aliasMatches = aliasIndex.get(token) ?? [];
    if (aliasMatches.length === 1) {
      staticMatches.push(aliasMatches[0]!);
      trace.push({
        id: 'explicit-mention',
        result: 'matched',
        reason: `@${token} matched one room participant`,
        agents: [aliasMatches[0]!],
        aliases: [token],
      });
      continue;
    }
    if (aliasMatches.length > 1) {
      ambiguousAliases.add(token);
      trace.push({
        id: 'explicit-mention',
        result: 'blocked',
        reason: `@${token} matched multiple room participants`,
        agents: aliasMatches,
        aliases: [token],
      });
      continue;
    }
    if ((providerCounts.get(token) ?? 0) > 1) {
      ambiguousAliases.add(token);
      trace.push({
        id: 'provider-mention',
        result: 'blocked',
        reason: `@${token} is ambiguous because multiple room participants use that provider`,
        aliases: [token],
      });
    }
  }

  for (const match of parseAgentReferences(text)) {
    const token = mentionAliasSlug(match);
    if (!token || explicitTokenSet.has(token)) continue;
    const aliasMatches = aliasIndex.get(token) ?? [];
    if (aliasMatches.length === 1) {
      staticMatches.push(aliasMatches[0]!);
      trace.push({
        id: 'bare-handoff',
        result: 'matched',
        reason: `${token} matched one room participant`,
        agents: [aliasMatches[0]!],
        aliases: [token],
      });
      continue;
    }
    if (aliasMatches.length > 1) {
      ambiguousAliases.add(token);
      trace.push({
        id: 'bare-handoff',
        result: 'blocked',
        reason: `${token} matched multiple room participants`,
        agents: aliasMatches,
        aliases: [token],
      });
      continue;
    }
    const providerMatches = room.agentProfiles.filter((profile) => profile.providerId === token);
    if (providerMatches.length > 1) {
      ambiguousAliases.add(token);
      trace.push({
        id: 'provider-handoff',
        result: 'blocked',
        reason: `${token} is ambiguous because multiple room participants use that provider`,
        agents: providerMatches.map((profile) => profile.id),
        aliases: [token],
      });
      continue;
    }
    const agentMatches = room.agentProfiles.filter(
      (profile) => profile.providerId === token || profile.id === token,
    );
    if (agentMatches.length > 0) {
      staticMatches.push(...agentMatches.map((profile) => profile.id));
      trace.push({
        id: 'provider-handoff',
        result: 'matched',
        reason: `${token} matched room participant provider/id`,
        agents: agentMatches.map((profile) => profile.id),
        aliases: [token],
      });
    }
  }

  const agentIds = [...new Set([...dynamic, ...staticMatches])];
  if (agentIds.length === 0 && ambiguousAliases.size === 0) {
    trace.push({
      id: 'reference-resolution',
      result: 'skipped',
      reason: 'no room-local agent references found',
    });
  }

  return {
    agentIds,
    ambiguousAliases: [...ambiguousAliases],
    explicitTokens,
    trace,
  };
}
