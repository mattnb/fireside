// server/src/context-files.ts
import path from 'node:path';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Message } from './repos/messages.js';

export interface MessageArtifact {
  messageId: string;
  path: string;
  chars: number;
  excerpt: string;
}

export interface ConversationContextFiles {
  transcriptPath: string;
  recapPath: string;
  artifactsDir: string;
  fixtureManifestPath: string;
  fixturesDir: string;
  omittedMessages: number;
  recentMessages: number;
  totalMessages: number;
  messageArtifacts: Record<string, MessageArtifact>;
  fixtureCount: number;
  fixtureSummary: string;
  maxRecapChars: number;
  maxTranscriptChars: number;
  largeMessageThresholdChars: number;
}

export interface ConversationArtifactFile {
  name: string;
  path: string;
  kind:
    | 'recap'
    | 'transcript'
    | 'manifest'
    | 'message-artifact'
    | 'draft-artifact'
    | 'fixture'
    | 'fixture-manifest';
  size: number;
  updatedAt: number;
}

export interface ConversationFixture {
  id: string;
  name: string;
  sourcePath: string;
  storedPath: string;
  size: number;
  copiedAt: number;
  isText: boolean;
  preview: string;
}

export type RemovableArtifactKind = 'fixture' | 'draft-artifact';

export interface ConversationArtifactListing {
  transcriptPath: string;
  recapPath: string;
  manifestPath: string;
  artifactsDir: string;
  fixtureManifestPath: string;
  fixturesDir: string;
  files: ConversationArtifactFile[];
}

const DEFAULT_LARGE_MESSAGE_THRESHOLD_CHARS = 6_000;
const DEFAULT_ARTIFACT_EXCERPT_CHARS = 1_200;
const DEFAULT_MAX_RECAP_CHARS = 12_000;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 64_000;
const DEFAULT_FIXTURE_PREVIEW_BYTES = 16_384;
const DEFAULT_MAX_FIXTURE_BYTES = 25 * 1024 * 1024;

function safeSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'room';
}

export function contextRoomDirectory(contextDir: string, roomId: string): string {
  return path.resolve(contextDir, safeSegment(roomId));
}

function fixtureDirectory(contextDir: string, roomId: string): string {
  return path.join(contextRoomDirectory(contextDir, roomId), 'fixtures');
}

function fixtureJsonPath(contextDir: string, roomId: string): string {
  return path.join(contextRoomDirectory(contextDir, roomId), 'fixtures.json');
}

function fixtureManifestPath(contextDir: string, roomId: string): string {
  return path.join(contextRoomDirectory(contextDir, roomId), 'fixtures.md');
}

function resolveInsideDirectory(root: string, candidate: string, label: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`${label} is outside room context`);
  }
  return resolvedCandidate;
}

function fileMeta(
  filePath: string,
  kind: ConversationArtifactFile['kind'],
): ConversationArtifactFile | null {
  if (!existsSync(filePath)) return null;
  const stat = statSync(filePath);
  return {
    name: path.basename(filePath),
    path: filePath,
    kind,
    size: stat.size,
    updatedAt: stat.mtimeMs,
  };
}

export function listConversationArtifacts(opts: {
  contextDir: string;
  roomId: string;
}): ConversationArtifactListing {
  const roomDir = contextRoomDirectory(opts.contextDir, opts.roomId);
  const transcriptPath = path.join(roomDir, 'transcript.md');
  const recapPath = path.join(roomDir, 'recap.md');
  const manifestPath = path.join(roomDir, 'artifacts.md');
  const artifactsDir = path.join(roomDir, 'artifacts');
  const fixturesDir = fixtureDirectory(opts.contextDir, opts.roomId);
  const fixtureMdPath = fixtureManifestPath(opts.contextDir, opts.roomId);
  const files: ConversationArtifactFile[] = [];

  for (const item of [
    fileMeta(recapPath, 'recap'),
    fileMeta(transcriptPath, 'transcript'),
    fileMeta(manifestPath, 'manifest'),
    fileMeta(fixtureMdPath, 'fixture-manifest'),
  ]) {
    if (item) files.push(item);
  }

  if (existsSync(artifactsDir)) {
    const artifactFiles = readdirSync(artifactsDir)
      .map((name) => fileMeta(path.join(artifactsDir, name), 'message-artifact'))
      .filter((file): file is ConversationArtifactFile => file !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    files.push(...artifactFiles);
  }
  const draftsDir = path.join(roomDir, 'drafts');
  if (existsSync(draftsDir)) {
    const draftFiles = readdirSync(draftsDir)
      .map((name) => fileMeta(path.join(draftsDir, name), 'draft-artifact'))
      .filter((file): file is ConversationArtifactFile => file !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    files.push(...draftFiles);
  }
  if (existsSync(fixturesDir)) {
    const fixtureFiles = readdirSync(fixturesDir)
      .map((name) => fileMeta(path.join(fixturesDir, name), 'fixture'))
      .filter((file): file is ConversationArtifactFile => file !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    files.push(...fixtureFiles);
  }

  return {
    transcriptPath,
    recapPath,
    manifestPath,
    artifactsDir,
    fixtureManifestPath: fixtureMdPath,
    fixturesDir,
    files,
  };
}

function artifactFileName(message: Message): string {
  const stamp = new Date(message.createdAt).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${safeSegment(message.id)}.md`;
}

function excerptText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n[... ${text.length - maxChars} chars omitted ...]\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available * 0.62);
  const tail = available - head;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ''}`;
}

function oneLine(text: string, maxChars: number): string {
  return excerptText(text.replace(/\s+/g, ' ').trim(), maxChars);
}

function fixtureStoredName(sourcePath: string, copiedAt: number): string {
  const parsed = path.parse(sourcePath);
  const stamp = new Date(copiedAt).toISOString().replace(/[:.]/g, '-');
  const base = safeSegment(parsed.name);
  const ext = parsed.ext.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 16);
  return `${stamp}-${base}${ext}`;
}

function isLikelyText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  if (buffer.includes(0)) return false;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 32) continue;
    suspicious += 1;
  }
  return suspicious / buffer.length < 0.02;
}

function fixturePreview(sourcePath: string, maxBytes: number): { isText: boolean; preview: string } {
  const buffer = readFileSync(sourcePath);
  const head = buffer.subarray(0, maxBytes);
  const isText = isLikelyText(head);
  if (!isText) return { isText, preview: '' };
  const decoded = head.toString('utf8').replace(/\r\n/g, '\n');
  const suffix = buffer.length > maxBytes ? `\n\n[fixture preview truncated at ${maxBytes} bytes]` : '';
  return { isText, preview: `${decoded}${suffix}` };
}

function readFixtureJson(contextDir: string, roomId: string): ConversationFixture[] {
  const jsonPath = fixtureJsonPath(contextDir, roomId);
  if (!existsSync(jsonPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ConversationFixture => {
      if (!item || typeof item !== 'object') return false;
      const obj = item as Partial<ConversationFixture>;
      return (
        typeof obj.id === 'string' &&
        typeof obj.name === 'string' &&
        typeof obj.sourcePath === 'string' &&
        typeof obj.storedPath === 'string' &&
        typeof obj.size === 'number' &&
        typeof obj.copiedAt === 'number' &&
        typeof obj.isText === 'boolean' &&
        typeof obj.preview === 'string'
      );
    });
  } catch {
    return [];
  }
}

function fixtureSummary(fixtures: ConversationFixture[], maxChars = 4_000): string {
  const lines = fixtures.map((fixture) => {
    const preview = fixture.isText && fixture.preview ? ` Preview: ${oneLine(fixture.preview, 260)}` : '';
    return `- ${fixture.name}: ${fixture.size} bytes; stored at ${fixture.storedPath}; original ${fixture.sourcePath}.${preview}`;
  });
  return trimToMaxChars(lines.join('\n') || '- none', maxChars);
}

function writeFixtureManifest(contextDir: string, roomId: string, fixtures: ConversationFixture[]): void {
  const roomDir = contextRoomDirectory(contextDir, roomId);
  mkdirSync(roomDir, { recursive: true });
  writeFileSync(fixtureJsonPath(contextDir, roomId), JSON.stringify(fixtures, null, 2), 'utf8');
  writeFileSync(
    fixtureManifestPath(contextDir, roomId),
    [
      '# Fireside Conversation Fixtures',
      '',
      `Room ID: ${roomId}`,
      `Updated: ${new Date().toISOString()}`,
      `Fixtures: ${fixtures.length}`,
      '',
      fixtures.length > 0
        ? fixtures
            .map((fixture) =>
              [
                `## ${fixture.name}`,
                '',
                `ID: ${fixture.id}`,
                `Original path: ${fixture.sourcePath}`,
                `Stored path: ${fixture.storedPath}`,
                `Bytes: ${fixture.size}`,
                `Copied: ${new Date(fixture.copiedAt).toISOString()}`,
                `Text preview: ${fixture.isText ? 'yes' : 'no'}`,
                '',
                fixture.isText && fixture.preview
                  ? ['```', fixture.preview, '```'].join('\n')
                  : '_No text preview available._',
              ].join('\n'),
            )
            .join('\n\n')
        : '- none',
      '',
    ].join('\n'),
    'utf8',
  );
}

export function attachConversationFixture(opts: {
  contextDir: string;
  roomId: string;
  sourcePath: string;
  maxBytes?: number;
  previewBytes?: number;
}): ConversationFixture {
  const sourcePath = path.resolve(opts.sourcePath);
  if (!existsSync(sourcePath)) throw new Error(`file not found: ${sourcePath}`);
  const stat = statSync(sourcePath);
  if (!stat.isFile()) throw new Error(`not a file: ${sourcePath}`);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FIXTURE_BYTES;
  if (stat.size > maxBytes) {
    throw new Error(`file is too large for a Fireside fixture (${stat.size} > ${maxBytes} bytes)`);
  }

  const copiedAt = Date.now();
  const fixturesDir = fixtureDirectory(opts.contextDir, opts.roomId);
  mkdirSync(fixturesDir, { recursive: true });
  const storedPath = path.join(fixturesDir, fixtureStoredName(sourcePath, copiedAt));
  copyFileSync(sourcePath, storedPath);
  const preview = fixturePreview(sourcePath, opts.previewBytes ?? DEFAULT_FIXTURE_PREVIEW_BYTES);
  const fixture: ConversationFixture = {
    id: `${copiedAt}-${safeSegment(path.basename(sourcePath))}`,
    name: path.basename(sourcePath),
    sourcePath,
    storedPath,
    size: stat.size,
    copiedAt,
    isText: preview.isText,
    preview: preview.preview,
  };
  const fixtures = [fixture, ...readFixtureJson(opts.contextDir, opts.roomId)];
  writeFixtureManifest(opts.contextDir, opts.roomId, fixtures);
  return fixture;
}

export function removeConversationArtifact(opts: {
  contextDir: string;
  roomId: string;
  kind: ConversationArtifactFile['kind'];
  artifactPath: string;
}): void {
  if (opts.kind === 'fixture') {
    const fixturesDir = fixtureDirectory(opts.contextDir, opts.roomId);
    const artifactPath = resolveInsideDirectory(fixturesDir, opts.artifactPath, 'fixture path');
    const fixtures = readFixtureJson(opts.contextDir, opts.roomId);
    const remainingFixtures = fixtures.filter(
      (fixture) => path.resolve(fixture.storedPath) !== artifactPath,
    );
    const fileExists = existsSync(artifactPath);
    if (!fileExists && remainingFixtures.length === fixtures.length) {
      throw new Error(`fixture not found: ${artifactPath}`);
    }
    if (fileExists) {
      const stat = statSync(artifactPath);
      if (!stat.isFile()) throw new Error(`not a file: ${artifactPath}`);
      unlinkSync(artifactPath);
    }
    writeFixtureManifest(opts.contextDir, opts.roomId, remainingFixtures);
    return;
  }

  if (opts.kind === 'draft-artifact') {
    const draftsDir = path.join(contextRoomDirectory(opts.contextDir, opts.roomId), 'drafts');
    const artifactPath = resolveInsideDirectory(draftsDir, opts.artifactPath, 'draft artifact path');
    if (!existsSync(artifactPath)) throw new Error(`draft artifact not found: ${artifactPath}`);
    const stat = statSync(artifactPath);
    if (!stat.isFile()) throw new Error(`not a file: ${artifactPath}`);
    unlinkSync(artifactPath);
    return;
  }

  throw new Error(`artifact kind cannot be removed: ${opts.kind}`);
}

function trimToMaxChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 96))}\n\n[recap truncated to ${maxChars} chars]\n`;
}

function messageArtifactStub(artifact: MessageArtifact): string {
  return [
    `[Large message stored outside the live prompt: ${artifact.chars} chars.]`,
    `Artifact file: ${artifact.path}`,
    `Excerpt:`,
    artifact.excerpt,
    `[End excerpt.]`,
  ].join('\n');
}

export function messageTextForPrompt(
  message: Message,
  contextFiles: ConversationContextFiles | undefined,
): string {
  const artifact = contextFiles?.messageArtifacts[message.id];
  return artifact ? messageArtifactStub(artifact) : message.text;
}

function textForContextFile(message: Message, artifacts: Record<string, MessageArtifact>): string {
  const artifact = artifacts[message.id];
  return artifact
    ? `[Large message artifact: ${artifact.chars} chars at ${artifact.path}. Excerpt: ${oneLine(artifact.excerpt, 320)}]`
    : message.text;
}

function formatMessage(
  message: Message,
  artifacts: Record<string, MessageArtifact>,
  maxInlineChars = 1_200,
): string {
  const text = textForContextFile(message, artifacts);
  const body = artifacts[message.id] ? text : excerptText(text, maxInlineChars);
  return `- ${new Date(message.createdAt).toISOString()} ${message.authorId} (${message.authorKind}): ${body}`;
}

function countByAuthor(messages: Message[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    counts.set(message.authorId, (counts.get(message.authorId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([author, count]) => `- ${author}: ${count}`)
    .join('\n');
}

function materializeArtifacts(opts: {
  roomDir: string;
  messages: Message[];
  thresholdChars: number;
  excerptChars: number;
}): { artifactsDir: string; messageArtifacts: Record<string, MessageArtifact> } {
  const artifactsDir = path.join(opts.roomDir, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  const messageArtifacts: Record<string, MessageArtifact> = {};

  for (const message of opts.messages) {
    if (message.text.length <= opts.thresholdChars) continue;

    const artifactPath = path.join(artifactsDir, artifactFileName(message));
    const excerpt = excerptText(message.text, opts.excerptChars);
    const artifact: MessageArtifact = {
      messageId: message.id,
      path: artifactPath,
      chars: message.text.length,
      excerpt,
    };
    messageArtifacts[message.id] = artifact;
    writeFileSync(
      artifactPath,
      [
        `# Fireside Message Artifact`,
        ``,
        `Message ID: ${message.id}`,
        `Author: ${message.authorId} (${message.authorKind})`,
        `Created: ${new Date(message.createdAt).toISOString()}`,
        `Characters: ${message.text.length}`,
        ``,
        `## Full Text`,
        ``,
        message.text,
        ``,
      ].join('\n'),
      'utf8',
    );
  }

  return { artifactsDir, messageArtifacts };
}

function boundedTailLines(lines: string[], headerLines: string[], maxChars: number): string[] {
  const selected: string[] = [];
  const headerChars = headerLines.join('\n').length;
  let used = headerChars;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const added = line.length + 1;
    if (selected.length > 0 && used + added > maxChars) break;
    if (selected.length === 0 && used + added > maxChars) {
      selected.unshift(excerptText(line, Math.max(1_000, maxChars - used - 1)));
      break;
    }
    selected.unshift(line);
    used += added;
  }

  return selected;
}

export function writeConversationContextFiles(opts: {
  contextDir: string;
  roomId: string;
  roomName: string;
  messages: Message[];
  recentMessages: number;
  largeMessageThresholdChars?: number;
  artifactExcerptChars?: number;
  maxRecapChars?: number;
  maxTranscriptChars?: number;
}): ConversationContextFiles {
  const totalMessages = opts.messages.length;
  const omittedMessages = Math.max(0, totalMessages - opts.recentMessages);
  const roomDir = contextRoomDirectory(opts.contextDir, opts.roomId);
  mkdirSync(roomDir, { recursive: true });
  const fixtures = readFixtureJson(opts.contextDir, opts.roomId);
  writeFixtureManifest(opts.contextDir, opts.roomId, fixtures);

  const largeMessageThresholdChars =
    opts.largeMessageThresholdChars ?? DEFAULT_LARGE_MESSAGE_THRESHOLD_CHARS;
  const artifactExcerptChars = opts.artifactExcerptChars ?? DEFAULT_ARTIFACT_EXCERPT_CHARS;
  const maxRecapChars = opts.maxRecapChars ?? DEFAULT_MAX_RECAP_CHARS;
  const maxTranscriptChars = opts.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
  const { artifactsDir, messageArtifacts } = materializeArtifacts({
    roomDir,
    messages: opts.messages,
    thresholdChars: largeMessageThresholdChars,
    excerptChars: artifactExcerptChars,
  });

  const transcriptPath = path.join(roomDir, 'transcript.md');
  const recapPath = path.join(roomDir, 'recap.md');
  const fixtureMdPath = fixtureManifestPath(opts.contextDir, opts.roomId);
  const fixturesDir = fixtureDirectory(opts.contextDir, opts.roomId);
  const fixtureSummaryText = fixtureSummary(fixtures);
  const transcriptHeader = [
    `# Fireside Transcript`,
    ``,
    `Room: ${opts.roomName}`,
    `Room ID: ${opts.roomId}`,
    `Updated: ${new Date().toISOString()}`,
    `Messages: ${totalMessages}`,
    `This file is bounded to the most recent transcript entries that fit within ${maxTranscriptChars} characters. Large messages are stored as artifact files and referenced here.`,
    ``,
    `## Messages`,
    ``,
  ];
  const transcriptLines = opts.messages.map((m) => formatMessage(m, messageArtifacts));
  const selectedTranscriptLines = boundedTailLines(
    transcriptLines,
    transcriptHeader,
    maxTranscriptChars,
  );
  const transcriptOmitted = transcriptLines.length - selectedTranscriptLines.length;
  const transcript = [
    ...transcriptHeader,
    transcriptOmitted > 0
      ? `_${transcriptOmitted} older transcript entr${transcriptOmitted === 1 ? 'y was' : 'ies were'} omitted from this bounded file._`
      : '',
    transcriptOmitted > 0 ? `` : '',
    ...selectedTranscriptLines,
    ``,
  ].join('\n');

  const olderMessages = opts.messages.slice(0, omittedMessages);
  const olderTail = olderMessages.slice(-24);
  const artifacts = Object.values(messageArtifacts);
  const artifactLines = artifacts
    .slice(-40)
    .map((artifact) => `- ${artifact.messageId}: ${artifact.chars} chars at ${artifact.path}`);
  const recap = trimToMaxChars(
    [
      `# Fireside Conversation Recap`,
      ``,
      `Room: ${opts.roomName}`,
      `Room ID: ${opts.roomId}`,
      `Updated: ${new Date().toISOString()}`,
      `Total messages: ${totalMessages}`,
      `Messages omitted from the live prompt: ${omittedMessages}`,
      `Large message artifacts: ${artifacts.length}`,
      `Conversation fixtures: ${fixtures.length}`,
      `This deterministic recap is bounded and excerpt-based. It is a navigation aid, not a full semantic summary.`,
      ``,
      `## Participants`,
      ``,
      countByAuthor(opts.messages) || '- none',
      ``,
      `## Large Message Artifacts`,
      ``,
      artifactLines.length > 0 ? artifactLines.join('\n') : '- none',
      ``,
      `## Conversation Fixtures`,
      ``,
      fixtureSummaryText,
      ``,
      `## Recent Omitted Message Excerpts`,
      ``,
      olderTail.length > 0
        ? olderTail.map((m) => formatMessage(m, messageArtifacts, 360)).join('\n')
        : 'No messages have been omitted from the live prompt yet.',
      ``,
    ].join('\n'),
    maxRecapChars,
  );

  const manifestPath = path.join(roomDir, 'artifacts.md');
  const manifest = [
    `# Fireside Message Artifacts`,
    ``,
    `Room: ${opts.roomName}`,
    `Room ID: ${opts.roomId}`,
    `Updated: ${new Date().toISOString()}`,
    ``,
    artifacts.length > 0
      ? artifacts.map((artifact) => `- ${artifact.messageId}: ${artifact.chars} chars at ${artifact.path}`).join('\n')
      : '- none',
    ``,
  ].join('\n');

  writeFileSync(transcriptPath, transcript, 'utf8');
  writeFileSync(recapPath, recap, 'utf8');
  writeFileSync(manifestPath, manifest, 'utf8');

  return {
    transcriptPath,
    recapPath,
    artifactsDir,
    fixtureManifestPath: fixtureMdPath,
    fixturesDir,
    omittedMessages,
    recentMessages: opts.recentMessages,
    totalMessages,
    messageArtifacts,
    fixtureCount: fixtures.length,
    fixtureSummary: fixtureSummaryText,
    maxRecapChars,
    maxTranscriptChars,
    largeMessageThresholdChars,
  };
}
