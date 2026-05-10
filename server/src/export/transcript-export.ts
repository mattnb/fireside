// server/src/export/transcript-export.ts
//
// Build a self-contained Markdown transcript of a room's chat. Used for
// review handoffs and archival. Includes every message with author kind
// and timestamp; system messages are rendered as italic single-line
// callouts.

import type { Database } from 'better-sqlite3';
import { getRoom } from '../repos/rooms.js';
import { listMessages } from '../repos/messages.js';

function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

export interface TranscriptExportResult {
  filename: string;
  markdown: string;
}

export interface TranscriptExportOptions {
  /** When set, cap the message count (newest preserved). */
  limit?: number;
}

export function exportTranscriptMarkdown(
  db: Database,
  roomId: string,
  options: TranscriptExportOptions = {},
): TranscriptExportResult | null {
  const room = getRoom(db, roomId);
  if (!room) return null;
  const messages = listMessages(db, roomId, options.limit ? { limit: options.limit } : {});

  const lines: string[] = [];
  lines.push(`# ${room.name} — transcript`);
  lines.push('');
  lines.push(`**Room id:** \`${room.id}\``);
  if (room.agents.length > 0) lines.push(`**Agents:** ${room.agents.join(', ')}`);
  if (room.leadAgentId) lines.push(`**Lead:** ${room.leadAgentId}`);
  lines.push(`**Messages:** ${messages.length}`);
  lines.push(`**Exported:** ${new Date().toISOString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const message of messages) {
    const ts = isoDate(message.createdAt);
    if (message.authorKind === 'system') {
      lines.push(`_[${ts}] system:_ ${oneLine(message.text)}`);
      lines.push('');
      continue;
    }
    const kindLabel = message.authorKind === 'agent' ? 'agent' : 'human';
    lines.push(`### [${ts}] ${message.authorId} _(${kindLabel})_`);
    lines.push('');
    lines.push(message.text || '_(empty message)_');
    lines.push('');
  }

  return {
    filename: `transcript-${slugify(room.name)}-${shortId(room.id)}.md`,
    markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'room'
  );
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
