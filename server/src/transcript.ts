// server/src/transcript.ts
import type { AgentId } from './agents/types.js';
import type { AuthorKind } from './repos/messages.js';

export interface HistoryEntry {
  authorId: string;
  authorKind: AuthorKind;
  text: string;
}

export interface BuildTurnOptions {
  agentId: AgentId;
  roomName: string;
  history: HistoryEntry[];
  newMessage: HistoryEntry;
  maxHistory?: number;
}

const DEFAULT_MAX_HISTORY = 80;

function formatLine(agentId: AgentId, entry: HistoryEntry): string {
  const isSelf = entry.authorKind === 'agent' && entry.authorId === agentId;
  const author = isSelf ? `${entry.authorId} (you)` : entry.authorId;
  return `${author}: ${entry.text}`;
}

export function buildTurnPrompt(opts: BuildTurnOptions): string {
  const max = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
  const recent = opts.history.slice(-max);
  const transcript = recent.map((e) => formatLine(opts.agentId, e)).join('\n');
  const newLine = formatLine(opts.agentId, opts.newMessage);

  return [
    `You are an AI participant named "${opts.agentId}" in a multi-user chat room.`,
    `Other participants are humans and other AI agents.`,
    ``,
    `Conversation so far:`,
    transcript || '(no prior messages)',
    ``,
    `New message just posted:`,
    newLine,
    ``,
    `Write your next chat message as "${opts.agentId}", in response to the new message above. Output ONLY the text of your message — no quotes, no JSON, no preface, no role labels, no markdown headers, no explanation. If you have nothing to add, output an empty string.`,
  ].join('\n');
}
