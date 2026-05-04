// server/src/mentions.ts
import type { AgentId } from './agents/types.js';

const KNOWN: AgentId[] = ['claude', 'codex', 'gemini', 'echo'];

// Match @name only when preceded by start-of-string or a separator. Sentence
// punctuation is allowed after the handle, but domains like user@claude.com
// and @claude.com are intentionally ignored.
const MENTION_RE =
  /(?:^|[\s([{"'`>])@([a-z][a-z0-9-]*)(?=$|[\s,;:!?)\]}"'\u2014\u2013-]|\.(?=[\s)\]}"']|$))/gi;

export function parseMentions(text: string): AgentId[] {
  const found = new Set<AgentId>();
  for (const match of text.matchAll(MENTION_RE)) {
    const captured = match[1];
    if (!captured) continue;
    const name = captured.toLowerCase() as AgentId;
    if (KNOWN.includes(name)) found.add(name);
  }
  return Array.from(found);
}

export function parseMentionTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    const captured = match[1];
    if (captured) found.add(captured.toLowerCase());
  }
  return Array.from(found);
}

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const AGENT_NAME_RE = /\b(claude|codex|gemini|echo)\b/gi;
const LEADING_HANDOFF_RE =
  /(?:^|[.!?\n]\s*)(claude|codex|gemini|echo)\s*(?:(?::|,|;|--|-)(?=\s*\S)|\s+(?:please|can|could|should|take|pick|verify|review|continue|next|your|you\b))/gi;
const PHRASE_HANDOFF_RE =
  /\b(?:ask|tell|handoff\s+to|hand\s+off\s+to|over\s+to|waiting\s+on|blocked\s+on|coordinate\s+with|sync\s+with|pass\s+to|defer\s+to)\s+(claude|codex|gemini|echo)\b/gi;
const AGENT_ACTION_RE =
  /\b(claude|codex|gemini|echo)\s+(?:should|can|could|needs?|must|will|continues?|verify|review|take|pick|own|owns|handle|fix)\b/gi;

function scrubCode(text: string): string {
  return text.replace(CODE_BLOCK_RE, ' ').replace(INLINE_CODE_RE, ' ');
}

function normalizeHandoffMarkup(text: string): string {
  return text
    .replace(/[*_~]+(claude|codex|gemini|echo)(\s*[:;,])[*_~]+/gi, '$1$2')
    .replace(/[*_~]+(claude|codex|gemini|echo)[*_~]+/gi, '$1')
    .replace(/[*_~]+(claude|codex|gemini|echo)(?=\s*[:;,])/gi, '$1')
    .replace(/\b(claude|codex|gemini|echo)(\s*[:;,])[*_~]+/gi, '$1$2');
}

function collectAgentMatches(text: string, re: RegExp, found: Set<AgentId>): void {
  for (const match of text.matchAll(re)) {
    const captured = match[1];
    if (!captured) continue;
    const name = captured.toLowerCase() as AgentId;
    if (KNOWN.includes(name)) found.add(name);
  }
}

export function parseAgentReferences(text: string): AgentId[] {
  const clean = normalizeHandoffMarkup(scrubCode(text));
  if (/^(claude|codex|gemini|echo)\s*[:;,]?\s*$/i.test(clean.trim())) return [];
  const found = new Set<AgentId>(parseMentions(clean));
  collectAgentMatches(clean, LEADING_HANDOFF_RE, found);
  collectAgentMatches(clean, PHRASE_HANDOFF_RE, found);
  collectAgentMatches(clean, AGENT_ACTION_RE, found);
  return Array.from(found);
}

export function parseBareAgentNames(text: string): AgentId[] {
  const clean = scrubCode(text);
  const found = new Set<AgentId>();
  collectAgentMatches(clean, AGENT_NAME_RE, found);
  return Array.from(found);
}

export function parseAgentReferencesForAliases(
  text: string,
  aliasesByAgent: Map<AgentId, string[]>,
): AgentId[] {
  const clean = normalizeHandoffMarkup(scrubCode(text)).toLowerCase();
  const mentionTokens = new Set(parseMentionTokens(clean));
  const found = new Set<AgentId>();
  for (const [agentId, aliases] of aliasesByAgent) {
    const normalizedAliases = aliases
      .map((alias) => alias.trim().toLowerCase())
      .filter((alias) => alias.length > 0);
    if (normalizedAliases.some((alias) => mentionTokens.has(alias))) {
      found.add(agentId);
      continue;
    }
    if (
      normalizedAliases.some((alias) => {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(
          `(?:^|[.!?\\n]\\s*)${escaped}\\s*(?:(?::|,|;|--|-)(?=\\s*\\S)|\\s+(?:please|can|could|should|take|pick|verify|review|continue|next|your|you\\b))`,
          'i',
        ).test(clean);
      })
    ) {
      found.add(agentId);
    }
  }
  return Array.from(found);
}
