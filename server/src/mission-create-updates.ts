import type { AgentId } from './agents/types.js';
import {
  hiddenBlockRegex,
  parseHiddenBlockFields,
  stripEmptyHiddenBlockComments,
} from './hidden-blocks.js';
import { normalizePermissionMode, type PermissionMode } from './permissions.js';

export interface ParsedMissionCreateUpdate {
  title: string;
  goal: string;
  repoPath: string;
  acceptanceCriteria: string;
  agents: AgentId[] | null;
  capabilityProfile: PermissionMode | null;
  summary: string;
}

export interface ExtractedMissionCreateUpdates {
  visibleText: string;
  updates: ParsedMissionCreateUpdate[];
}

const CREATE_RE = hiddenBlockRegex('mission-create', ['mission-create', 'collab-note']);

function first(fields: Map<string, string[]>, ...keys: string[]): string {
  for (const key of keys) {
    const value = fields.get(key)?.[0];
    if (value) return value.trim();
  }
  return '';
}

function all(fields: Map<string, string[]>, ...keys: string[]): string {
  return keys
    .flatMap((key) => fields.get(key) ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function splitAgents(value: string): AgentId[] | null {
  const agents = [
    ...new Set(
      value
        .split(/,|;|\n/)
        .map((agent) => agent.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, 12) as AgentId[];
  return agents.length > 0 ? agents : null;
}

function parseCreateBlock(block: string): ParsedMissionCreateUpdate | null {
  const fields = parseHiddenBlockFields(block);
  const title = first(fields, 'title', 'mission', 'name');
  if (!title) return null;
  const capabilityProfile = normalizePermissionMode(
    first(fields, 'capability_profile', 'capability', 'mode', 'permission_mode'),
  );
  const agents = splitAgents(first(fields, 'agents', 'assigned_agents', 'team'));

  return {
    title,
    goal: all(fields, 'goal', 'brief', 'objective'),
    repoPath: first(fields, 'repo_path', 'workspace', 'path', 'working_directory'),
    acceptanceCriteria: all(fields, 'acceptance', 'acceptance_criteria', 'done_when'),
    agents,
    capabilityProfile,
    summary: all(fields, 'summary'),
  };
}

export function extractMissionCreateUpdates(text: string): ExtractedMissionCreateUpdates {
  const updates: ParsedMissionCreateUpdate[] = [];
  const visibleText = text.replace(CREATE_RE, (match, prefix: string, block: string) => {
    const parsed = parseCreateBlock(block);
    if (parsed) updates.push(parsed);
    return prefix === '\n' ? '\n' : '';
  });
  return {
    visibleText: stripEmptyHiddenBlockComments(visibleText).trim(),
    updates,
  };
}
