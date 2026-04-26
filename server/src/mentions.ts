// server/src/mentions.ts
import type { AgentId } from './agents/types.js';

const KNOWN: AgentId[] = ['claude', 'codex', 'gemini', 'echo'];

// Match @name only when preceded by start-of-string or whitespace, and followed by
// non-word boundary that is not a `.` (to skip emails like user@claude.com).
const MENTION_RE = /(?:^|\s)@([a-z][a-z0-9-]*)(?![.\w])/gi;

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
