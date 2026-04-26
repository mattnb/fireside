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
    `You are participating in a multi-agent chat room called "${opts.roomName}".`,
    `You are "${opts.agentId}". Other participants may be human or other AI agents.`,
    `Reply with the text of your message only — no preamble, no thinking-aloud, no markdown headers.`,
    `If you have nothing useful to add, reply with an empty message.`,
    ``,
    `--- recent transcript ---`,
    transcript || '(no prior messages)',
    `--- new message ---`,
    newLine,
    ``,
    `Compose your reply:`,
  ].join('\n');
}
