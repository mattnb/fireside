import type { AgentId, ProviderId } from './agents/types.js';

export type AgentRosterAction = 'add' | 'dismiss';

export interface ParsedAgentRosterUpdate {
  action: AgentRosterAction;
  id: AgentId;
  name: string;
  providerId: ProviderId | '';
  personaId: string;
  reason: string;
  scope: string;
  dismissWhen: string;
  prompt: string;
  yolo: boolean | null;
  maxTurns: number | null;
}

export interface ExtractedAgentRosterUpdates {
  visibleText: string;
  updates: ParsedAgentRosterUpdate[];
}

const ROSTER_RE =
  /(^|\n)\/agent-roster\s*\n([\s\S]*?)\n[/@]end-(?:agent-roster|collab-note)(?=\s|$)/gi;
const ACTION_ALIASES = new Map<string, AgentRosterAction>([
  ['add', 'add'],
  ['create', 'add'],
  ['spawn', 'add'],
  ['dismiss', 'dismiss'],
  ['remove', 'dismiss'],
  ['delete', 'dismiss'],
]);

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/-/g, '_');
}

function normalizeAction(value: string): AgentRosterAction {
  return ACTION_ALIASES.get(value.trim().toLowerCase()) ?? 'add';
}

function parseBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'on', 'yolo'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0', 'off', 'normal'].includes(normalized)) return false;
  return null;
}

function parsePositiveInteger(value: string): number | null {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return null;
  const integer = Math.floor(parsed);
  return integer > 0 ? integer : null;
}

function first(fields: Map<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = fields.get(key);
    if (value) return value.trim();
  }
  return '';
}

function parseBlock(block: string): ParsedAgentRosterUpdate | null {
  const fields = new Map<string, string>();
  const promptLines: string[] = [];
  let inPrompt = false;

  for (const rawLine of block.split(/\r?\n/)) {
    if (inPrompt) {
      promptLines.push(rawLine);
      continue;
    }
    const match = /^([a-z][a-z_-]*)\s*:\s*(.*)$/i.exec(rawLine.trimEnd());
    if (!match) continue;
    const key = normalizeKey(match[1]!);
    const value = match[2] ?? '';
    if (['prompt', 'assignment', 'brief', 'context'].includes(key)) {
      inPrompt = true;
      if (value.trim()) promptLines.push(value.trim());
      continue;
    }
    fields.set(key, value.trim());
  }

  const action = normalizeAction(first(fields, 'action', 'mode'));
  const id = first(fields, 'id', 'agent_id', 'agent', 'handle');
  const name = first(fields, 'name', 'display_name', 'title');
  const providerId = first(fields, 'provider', 'provider_id') as ProviderId | '';
  const personaId = first(fields, 'persona', 'persona_id', 'role');
  const reason = first(fields, 'reason', 'why');
  const scope = first(fields, 'scope', 'target', 'lane', 'task');
  const dismissWhen = first(fields, 'dismiss_when', 'dismiss', 'until');
  const maxTurns = parsePositiveInteger(first(fields, 'max_turns', 'turns', 'max_replies'));
  const yolo = parseBoolean(first(fields, 'yolo', 'autonomous', 'full_auto'));
  const prompt = promptLines.join('\n').trim() || first(fields, 'prompt', 'assignment');

  if (action === 'add' && !providerId) return null;
  if (action === 'dismiss' && !id && !name) return null;

  return {
    action,
    id,
    name,
    providerId,
    personaId,
    reason,
    scope,
    dismissWhen,
    prompt,
    yolo,
    maxTurns,
  };
}

export function extractAgentRosterUpdates(text: string): ExtractedAgentRosterUpdates {
  const updates: ParsedAgentRosterUpdate[] = [];
  const visibleText = text.replace(ROSTER_RE, (match, prefix: string, block: string) => {
    const parsed = parseBlock(block);
    if (parsed) updates.push(parsed);
    return prefix === '\n' ? '\n' : '';
  });
  return {
    visibleText: visibleText.trim(),
    updates,
  };
}
