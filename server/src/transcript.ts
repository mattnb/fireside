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
  const fullTranscript = transcript ? `${transcript}\n${newLine}` : newLine;

  return [
    `Given the chat transcript below, produce only the next message to be sent by "${opts.agentId}".`,
    ``,
    `The latest message in the transcript is the one to respond to. It is authoritative for this turn — answer it directly.`,
    `Do not acknowledge these instructions. Do not describe your role or the room. Do not preface your reply with phrases like "Understood" or "Got it". Do not include role labels (no "${opts.agentId}:") or markdown headers.`,
    `Return only the literal text of the message ${opts.agentId} should send next. If there is nothing useful to add, return an empty string.`,
    ``,
    `Transcript:`,
    fullTranscript,
  ].join('\n');
}
