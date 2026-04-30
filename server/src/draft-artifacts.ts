import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { AgentId } from './agents/types.js';
import { contextRoomDirectory } from './context-files.js';

export interface ParsedDraftArtifact {
  name: string;
  target: string;
  content: string;
}

export interface ExtractedDraftArtifacts {
  visibleText: string;
  drafts: ParsedDraftArtifact[];
}

export interface StoredDraftArtifact extends ParsedDraftArtifact {
  path: string;
  chars: number;
}

const DRAFT_RE = /(^|\n)\/draft-artifact\s*\n([\s\S]*?)\n\/end-draft-artifact(?:\r?\n)?/gi;

function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'draft.md';
}

function parseDraftBlock(block: string): ParsedDraftArtifact | null {
  const lines = block.split(/\r?\n/);
  const fields = new Map<string, string>();
  const contentLines: string[] = [];
  let inContent = false;

  for (const raw of lines) {
    if (inContent) {
      contentLines.push(raw);
      continue;
    }
    const match = /^([a-z][a-z-]*)\s*:\s*(.*)$/i.exec(raw.trimEnd());
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2] ?? '';
    if (key === 'content') {
      inContent = true;
      if (value) contentLines.push(value);
      continue;
    }
    fields.set(key, value.trim());
  }

  const target = fields.get('target') ?? '';
  const explicitName = fields.get('name') ?? fields.get('title') ?? '';
  const name = explicitName || (target ? path.basename(target) : 'draft.md');
  const content = contentLines.join('\n').trim();
  if (!content) return null;
  return {
    name,
    target,
    content,
  };
}

export function extractDraftArtifacts(text: string): ExtractedDraftArtifacts {
  const drafts: ParsedDraftArtifact[] = [];
  const visibleText = text.replace(DRAFT_RE, (_match, prefix: string, block: string) => {
    const parsed = parseDraftBlock(block);
    if (parsed) drafts.push(parsed);
    return prefix === '\n' ? '\n' : '';
  });
  return {
    visibleText: visibleText.trim(),
    drafts,
  };
}

export function writeDraftArtifact(opts: {
  contextDir: string;
  roomId: string;
  agentId: AgentId;
  runId: string;
  draft: ParsedDraftArtifact;
}): StoredDraftArtifact {
  const draftsDir = path.join(contextRoomDirectory(opts.contextDir, opts.roomId), 'drafts');
  mkdirSync(draftsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(draftsDir, `${stamp}-${opts.agentId}-${nanoid(8)}-${safeName(opts.draft.name)}`);
  writeFileSync(
    filePath,
    [
      `# Fireside Draft Artifact`,
      ``,
      `Agent: ${opts.agentId}`,
      `Run ID: ${opts.runId}`,
      `Target: ${opts.draft.target || 'unspecified'}`,
      `Created: ${new Date().toISOString()}`,
      `Characters: ${opts.draft.content.length}`,
      ``,
      `## Draft Content`,
      ``,
      opts.draft.content,
      ``,
    ].join('\n'),
    'utf8',
  );
  return {
    ...opts.draft,
    path: filePath,
    chars: opts.draft.content.length,
  };
}
