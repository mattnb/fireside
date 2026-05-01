import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PERMISSION_CAPABILITIES,
  PERMISSION_MODES,
  YOLO_FILESYSTEM_SCOPES,
  permissionCapabilitiesForMode,
  type PermissionCapability,
  type PermissionMode,
  type YoloFilesystemScope,
} from './permissions.js';

export const WORKFLOW_PROFILE_DISCOVERY_PATHS = [
  '.fireside/workflow.md',
  'FIRESIDE_WORKFLOW.md',
  'WORKFLOW.md',
] as const;

export const WORKFLOW_HOOK_NAMES = [
  'afterCreate',
  'beforeRun',
  'afterRun',
  'beforeRemove',
] as const;

export type WorkflowHookName = (typeof WORKFLOW_HOOK_NAMES)[number];

export interface WorkflowAgentConfig {
  maxTurns: number;
  maxConcurrentAgents: number;
  maxRetryBackoffMs: number;
}

export interface WorkflowWorkspaceConfig {
  root: string;
}

export type WorkflowHooksConfig = Record<WorkflowHookName, string[]>;

export interface WorkflowPermissionProfile {
  mode: PermissionMode;
  capabilities: PermissionCapability[];
  web: boolean;
  filesystemScope?: YoloFilesystemScope;
  target?: string;
  providerProfile?: string;
}

export interface WorkflowProfile {
  sourcePath?: string;
  body: string;
  promptTemplate: string;
  promptBudgetChars: number;
  agent: WorkflowAgentConfig;
  workspace: WorkflowWorkspaceConfig;
  hooks: WorkflowHooksConfig;
  permissions: WorkflowPermissionProfile;
}

export interface WorkflowProfileParseOptions {
  repoPath?: string;
  sourcePath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface WorkflowProfileDiscoveryOptions {
  repoPath: string;
  explicitFilePath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface WorkflowProfileValidationResult {
  valid: boolean;
  errors: string[];
}

export const DEFAULT_WORKFLOW_AGENT_CONFIG: WorkflowAgentConfig = {
  maxTurns: 8,
  maxConcurrentAgents: 3,
  maxRetryBackoffMs: 30_000,
};

export const DEFAULT_WORKFLOW_PROMPT_BUDGET_CHARS = 16_000;

type FrontMatterValue =
  | string
  | number
  | boolean
  | FrontMatterValue[]
  | { [key: string]: FrontMatterValue };

type FrontMatterMap = Record<string, FrontMatterValue>;

type ScalarValue = string | number | boolean | ScalarValue[];

export class WorkflowProfileError extends Error {
  readonly code: string;
  readonly sourcePath?: string;

  constructor(message: string, code = 'workflow-profile-error', sourcePath?: string) {
    super(message);
    this.name = 'WorkflowProfileError';
    this.code = code;
    if (sourcePath) this.sourcePath = sourcePath;
  }
}

export function workflowProfileCandidatePaths(options: WorkflowProfileDiscoveryOptions): string[] {
  const env = options.env ?? process.env;
  const repoPath = resolveProfilePath(options.repoPath, process.cwd(), env);
  const candidates = [
    ...(options.explicitFilePath
      ? [resolveProfilePath(options.explicitFilePath, repoPath, env)]
      : []),
    ...WORKFLOW_PROFILE_DISCOVERY_PATHS.map((relativePath) => path.join(repoPath, relativePath)),
  ];
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

export function discoverWorkflowProfilePath(
  options: WorkflowProfileDiscoveryOptions,
): string | null {
  for (const candidate of workflowProfileCandidatePaths(options)) {
    if (isReadableFile(candidate)) return candidate;
  }
  return null;
}

export function loadWorkflowProfile(
  options: WorkflowProfileDiscoveryOptions,
): WorkflowProfile | null {
  const sourcePath = discoverWorkflowProfilePath(options);
  if (!sourcePath) return null;
  const parseOptions: WorkflowProfileParseOptions = {
    repoPath: options.repoPath,
    sourcePath,
  };
  if (options.env) parseOptions.env = options.env;
  return parseWorkflowProfileMarkdown(readFileSync(sourcePath, 'utf8'), parseOptions);
}

export function parseWorkflowProfileMarkdown(
  markdown: string,
  options: WorkflowProfileParseOptions = {},
): WorkflowProfile {
  const env = options.env ?? process.env;
  const repoPath = resolveProfilePath(options.repoPath ?? process.cwd(), process.cwd(), env);
  const sourcePath = options.sourcePath
    ? resolveProfilePath(options.sourcePath, repoPath, env)
    : undefined;
  const { frontMatter, body } = splitFrontMatter(markdown, sourcePath);
  const parsedFrontMatter = frontMatter ? parseFrontMatterMap(frontMatter, sourcePath) : {};
  const profile = buildWorkflowProfile(parsedFrontMatter, body, {
    repoPath,
    env,
    ...(sourcePath ? { sourcePath } : {}),
  });
  const validation = validateWorkflowProfile(profile);
  if (!validation.valid) {
    throw new WorkflowProfileError(
      `Invalid workflow profile: ${validation.errors.join('; ')}`,
      'invalid-profile',
      sourcePath,
    );
  }
  return profile;
}

export function parseWorkflowProfile(
  markdown: string,
  options: WorkflowProfileParseOptions = {},
): WorkflowProfile {
  return parseWorkflowProfileMarkdown(markdown, options);
}

export function validateWorkflowProfile(profile: WorkflowProfile): WorkflowProfileValidationResult {
  const errors: string[] = [];

  if (!isPositiveInteger(profile.agent.maxTurns)) {
    errors.push('agent.maxTurns must be a positive integer');
  }
  if (!isPositiveInteger(profile.agent.maxConcurrentAgents)) {
    errors.push('agent.maxConcurrentAgents must be a positive integer');
  }
  if (!isPositiveInteger(profile.agent.maxRetryBackoffMs)) {
    errors.push('agent.maxRetryBackoffMs must be a positive integer');
  }
  if (!isPositiveInteger(profile.promptBudgetChars)) {
    errors.push('promptBudgetChars must be a positive integer');
  }
  if (!profile.workspace.root) {
    errors.push('workspace.root must be a non-empty path');
  }
  for (const hookName of WORKFLOW_HOOK_NAMES) {
    if (profile.hooks[hookName].some((hook) => !hook.trim())) {
      errors.push(`hooks.${hookName} must not contain empty commands`);
    }
  }
  if (!isPermissionMode(profile.permissions.mode)) {
    errors.push('permissions.mode must be a known permission mode');
  }
  for (const capability of profile.permissions.capabilities) {
    if (!isPermissionCapability(capability)) {
      errors.push(`permissions.capabilities contains unknown capability: ${capability}`);
    }
  }
  if (
    profile.permissions.filesystemScope &&
    !isYoloFilesystemScope(profile.permissions.filesystemScope)
  ) {
    errors.push('permissions.filesystemScope must be a known filesystem scope');
  }

  return { valid: errors.length === 0, errors };
}

function buildWorkflowProfile(
  frontMatter: FrontMatterMap,
  body: string,
  options: {
    repoPath: string;
    sourcePath?: string;
    env: NodeJS.ProcessEnv;
  },
): WorkflowProfile {
  const agent = readRecord(frontMatter, 'agent') ?? {};
  const workspace = readRecord(frontMatter, 'workspace') ?? {};
  const hooks = readRecord(frontMatter, 'hooks') ?? {};
  const permissions = readRecord(frontMatter, 'permissions') ?? {};
  const sourcePath = options.sourcePath ? path.resolve(options.sourcePath) : undefined;
  const promptTemplate = readOptionalString(frontMatter, 'promptTemplate') ?? body;
  const permissionMode = readPermissionMode(permissions, 'mode', 'plan');
  const filesystemScope = readOptionalFilesystemScope(permissions, 'filesystemScope');
  const permissionWeb = readOptionalBoolean(permissions, 'web') ?? false;
  const capabilities = readPermissionCapabilities(
    permissions,
    permissionMode,
    permissionWeb,
    filesystemScope,
  );
  const permissionTarget = readOptionalString(permissions, 'target');
  const providerProfile = readOptionalString(permissions, 'providerProfile');

  return {
    ...(sourcePath ? { sourcePath } : {}),
    body,
    promptTemplate,
    promptBudgetChars: readPositiveInteger(
      frontMatter,
      'promptBudgetChars',
      DEFAULT_WORKFLOW_PROMPT_BUDGET_CHARS,
    ),
    agent: {
      maxTurns: readPositiveInteger(agent, 'maxTurns', DEFAULT_WORKFLOW_AGENT_CONFIG.maxTurns),
      maxConcurrentAgents: readPositiveInteger(
        agent,
        'maxConcurrentAgents',
        DEFAULT_WORKFLOW_AGENT_CONFIG.maxConcurrentAgents,
      ),
      maxRetryBackoffMs: readPositiveInteger(
        agent,
        'maxRetryBackoffMs',
        DEFAULT_WORKFLOW_AGENT_CONFIG.maxRetryBackoffMs,
      ),
    },
    workspace: {
      root: resolveProfilePath(
        readOptionalString(workspace, 'root') ?? options.repoPath,
        options.repoPath,
        options.env,
      ),
    },
    hooks: {
      afterCreate: readStringList(hooks, 'afterCreate', []),
      beforeRun: readStringList(hooks, 'beforeRun', []),
      afterRun: readStringList(hooks, 'afterRun', []),
      beforeRemove: readStringList(hooks, 'beforeRemove', []),
    },
    permissions: {
      mode: permissionMode,
      capabilities,
      web: permissionWeb,
      ...(filesystemScope ? { filesystemScope } : {}),
      ...(permissionTarget ? { target: permissionTarget } : {}),
      ...(providerProfile ? { providerProfile } : {}),
    },
  };
}

function splitFrontMatter(
  markdown: string,
  sourcePath?: string,
): { frontMatter?: string; body: string } {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') return { body: normalized };

  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() !== '---') continue;
    return {
      frontMatter: lines.slice(1, i).join('\n'),
      body: lines.slice(i + 1).join('\n'),
    };
  }

  throw new WorkflowProfileError(
    'Workflow profile front matter starts with --- but has no closing ---',
    'front-matter-unclosed',
    sourcePath,
  );
}

function parseFrontMatterMap(rawFrontMatter: string, sourcePath?: string): FrontMatterMap {
  const lines = rawFrontMatter.replace(/\r\n?/g, '\n').split('\n');
  const { value, nextIndex } = parseMapBlock(lines, 0, 0, sourcePath);
  for (let i = nextIndex; i < lines.length; i += 1) {
    if (!isSkippableLine(lines[i] ?? '')) {
      throw frontMatterError('Unexpected front matter content', i, sourcePath);
    }
  }
  return value;
}

function parseMapBlock(
  lines: string[],
  startIndex: number,
  expectedIndent: number,
  sourcePath?: string,
): { value: FrontMatterMap; nextIndex: number } {
  const value: FrontMatterMap = {};
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (isSkippableLine(line)) {
      index += 1;
      continue;
    }

    const indent = countIndent(line);
    if (indent < expectedIndent) break;
    if (indent > expectedIndent) {
      throw frontMatterError('Unexpected indentation in front matter', index, sourcePath);
    }

    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      throw frontMatterError('Front matter must be a map, not a list', index, sourcePath);
    }

    const entry = parseKeyValueLine(trimmed, index, sourcePath);
    if (entry.valueText === '') {
      const nextContent = findNextContentLine(lines, index + 1);
      if (!nextContent || nextContent.indent <= indent) {
        setFrontMatterValue(value, entry.key, {}, index, sourcePath);
        index += 1;
        continue;
      }
      if (nextContent.trimmed.startsWith('- ')) {
        const parsedList = parseListBlock(lines, nextContent.index, nextContent.indent, sourcePath);
        setFrontMatterValue(value, entry.key, parsedList.value, index, sourcePath);
        index = parsedList.nextIndex;
        continue;
      }

      const parsedMap = parseMapBlock(lines, nextContent.index, nextContent.indent, sourcePath);
      setFrontMatterValue(value, entry.key, parsedMap.value, index, sourcePath);
      index = parsedMap.nextIndex;
      continue;
    }

    if (entry.valueText === '|' || entry.valueText === '>') {
      const parsedScalar = parseBlockScalar(lines, index + 1, indent, entry.valueText === '>');
      setFrontMatterValue(value, entry.key, parsedScalar.value, index, sourcePath);
      index = parsedScalar.nextIndex;
      continue;
    }

    setFrontMatterValue(
      value,
      entry.key,
      parseScalar(entry.valueText, index, sourcePath),
      index,
      sourcePath,
    );
    index += 1;
  }

  return { value, nextIndex: index };
}

function parseListBlock(
  lines: string[],
  startIndex: number,
  expectedIndent: number,
  sourcePath?: string,
): { value: FrontMatterValue[]; nextIndex: number } {
  const value: FrontMatterValue[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (isSkippableLine(line)) {
      index += 1;
      continue;
    }

    const indent = countIndent(line);
    if (indent < expectedIndent) break;
    if (indent > expectedIndent) {
      throw frontMatterError('Unexpected indentation in list', index, sourcePath);
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) break;
    const itemText = trimmed.slice(2).trim();
    if (!itemText) {
      throw frontMatterError('List items must be scalar values', index, sourcePath);
    }
    value.push(parseScalar(itemText, index, sourcePath));
    index += 1;
  }

  return { value, nextIndex: index };
}

function parseBlockScalar(
  lines: string[],
  startIndex: number,
  parentIndent: number,
  folded: boolean,
): { value: string; nextIndex: number } {
  const collected: string[] = [];
  let contentIndent: number | null = null;
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      collected.push('');
      index += 1;
      continue;
    }

    const indent = countIndent(line);
    if (indent <= parentIndent) break;
    contentIndent = contentIndent === null ? indent : Math.min(contentIndent, indent);
    collected.push(line);
    index += 1;
  }

  const stripIndent = contentIndent ?? parentIndent + 2;
  const stripped = collected.map((line) =>
    line.trim() ? line.slice(Math.min(countIndent(line), stripIndent)) : '',
  );

  return {
    value: folded ? foldBlockScalar(stripped) : stripped.join('\n'),
    nextIndex: index,
  };
}

function foldBlockScalar(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line === '') {
      if (current.length) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      paragraphs.push('');
      continue;
    }
    current.push(line);
  }
  if (current.length) paragraphs.push(current.join(' '));
  return paragraphs.join('\n');
}

function parseScalar(valueText: string, lineIndex: number, sourcePath?: string): ScalarValue {
  const trimmed = stripInlineComment(valueText).trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return parseQuotedScalar(trimmed, lineIndex, sourcePath);
  }
  if (trimmed.startsWith('[')) return parseInlineList(trimmed, lineIndex, sourcePath);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    throw frontMatterError(
      'Decimal numbers are not supported for workflow scalars',
      lineIndex,
      sourcePath,
    );
  }
  return trimmed;
}

function parseQuotedScalar(valueText: string, lineIndex: number, sourcePath?: string): string {
  const quote = valueText[0];
  if (!quote || (quote !== '"' && quote !== "'")) {
    throw frontMatterError('Invalid quoted scalar', lineIndex, sourcePath);
  }
  if (!valueText.endsWith(quote) || valueText.length === 1) {
    throw frontMatterError('Unterminated quoted scalar', lineIndex, sourcePath);
  }
  const body = valueText.slice(1, -1);
  if (quote === "'") return body;
  return body
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function parseInlineList(valueText: string, lineIndex: number, sourcePath?: string): ScalarValue[] {
  if (!valueText.endsWith(']')) {
    throw frontMatterError('Unterminated inline list scalar', lineIndex, sourcePath);
  }
  const body = valueText.slice(1, -1).trim();
  if (!body) return [];
  return splitInlineListItems(body, lineIndex, sourcePath).map((item) =>
    parseScalar(item, lineIndex, sourcePath),
  );
}

function splitInlineListItems(body: string, lineIndex: number, sourcePath?: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote === '"') {
      current += char;
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      current += char;
      continue;
    }
    if (char === quote) {
      quote = null;
      current += char;
      continue;
    }
    if (char === ',' && quote === null) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (quote !== null) {
    throw frontMatterError('Unterminated quoted scalar in inline list', lineIndex, sourcePath);
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function parseKeyValueLine(
  trimmed: string,
  lineIndex: number,
  sourcePath?: string,
): { key: string; valueText: string } {
  const match = /^([A-Za-z][A-Za-z0-9_.-]*)\s*:(?:\s*(.*))?$/.exec(trimmed);
  if (!match?.[1]) {
    throw frontMatterError(
      'Front matter entries must use key: value syntax',
      lineIndex,
      sourcePath,
    );
  }
  return {
    key: match[1],
    valueText: match[2] ?? '',
  };
}

function setFrontMatterValue(
  root: FrontMatterMap,
  rawKey: string,
  value: FrontMatterValue,
  lineIndex: number,
  sourcePath?: string,
): void {
  const parts = rawKey.split('.').filter(Boolean);
  let current: FrontMatterMap = root;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (existing === undefined) {
      const next: FrontMatterMap = {};
      current[part] = next;
      current = next;
      continue;
    }
    if (!isRecord(existing)) {
      throw frontMatterError(
        `Front matter key ${rawKey} conflicts with an existing scalar`,
        lineIndex,
        sourcePath,
      );
    }
    current = existing;
  }

  const last = parts.at(-1);
  if (!last) {
    throw frontMatterError('Front matter key must not be empty', lineIndex, sourcePath);
  }
  if (current[last] !== undefined) {
    throw frontMatterError(`Duplicate front matter key: ${rawKey}`, lineIndex, sourcePath);
  }
  current[last] = value;
}

function readRecord(source: FrontMatterMap, key: string): FrontMatterMap | null {
  const value = source[key];
  if (value === undefined) return null;
  if (!isRecord(value)) throw invalidField(key, 'must be a map');
  return value;
}

function readOptionalString(source: FrontMatterMap, key: string): string | null {
  const value = source[key];
  if (value === undefined) return null;
  if (typeof value !== 'string') throw invalidField(key, 'must be a string');
  return value;
}

function readOptionalBoolean(source: FrontMatterMap, key: string): boolean | null {
  const value = source[key];
  if (value === undefined) return null;
  if (typeof value !== 'boolean') throw invalidField(key, 'must be a boolean');
  return value;
}

function readPositiveInteger(source: FrontMatterMap, key: string, defaultValue: number): number {
  const value = source[key];
  if (value === undefined) return defaultValue;
  if (!isPositiveInteger(value)) throw invalidField(key, 'must be a positive integer');
  return value;
}

function readStringList(source: FrontMatterMap, key: string, defaultValue: string[]): string[] {
  const value = source[key];
  if (value === undefined) return [...defaultValue];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) throw invalidField(key, 'must be a string or list of strings');
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw invalidField(key, 'must contain only strings');
    items.push(item);
  }
  return items;
}

function readPermissionMode(
  source: FrontMatterMap,
  key: string,
  defaultValue: PermissionMode,
): PermissionMode {
  const value = source[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !isPermissionMode(value)) {
    throw invalidField(key, `must be one of ${PERMISSION_MODES.join(', ')}`);
  }
  return value;
}

function readOptionalFilesystemScope(
  source: FrontMatterMap,
  key: string,
): YoloFilesystemScope | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isYoloFilesystemScope(value)) {
    throw invalidField(key, `must be one of ${YOLO_FILESYSTEM_SCOPES.join(', ')}`);
  }
  return value;
}

function readPermissionCapabilities(
  source: FrontMatterMap,
  mode: PermissionMode,
  web: boolean,
  filesystemScope?: YoloFilesystemScope,
): PermissionCapability[] {
  const value = source.capabilities;
  if (value === undefined) {
    return permissionCapabilitiesForMode({
      mode,
      ...(web ? { web } : {}),
      ...(filesystemScope ? { filesystemScope } : {}),
    });
  }
  const rawCapabilities =
    typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : value;
  if (!Array.isArray(rawCapabilities)) {
    throw invalidField('capabilities', 'must be a string or list of strings');
  }

  const capabilities: PermissionCapability[] = [];
  for (const capability of rawCapabilities) {
    if (typeof capability !== 'string' || !isPermissionCapability(capability)) {
      throw invalidField(
        'capabilities',
        `must contain only known capabilities: ${PERMISSION_CAPABILITIES.join(', ')}`,
      );
    }
    capabilities.push(capability);
  }
  return [...new Set(capabilities)];
}

function resolveProfilePath(rawPath: string, basePath: string, env: NodeJS.ProcessEnv): string {
  const expanded = expandPath(rawPath, env);
  if (path.isAbsolute(expanded) || path.win32.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(basePath, expanded);
}

function expandPath(rawPath: string, env: NodeJS.ProcessEnv): string {
  const withHome = rawPath.replace(/^~(?=$|[\\/])/, () => homeDirectory(env));
  return withHome
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => env[name] ?? '')
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, name: string) => env[name] ?? '');
}

function homeDirectory(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? env.USERPROFILE ?? os.homedir();
}

function isReadableFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: FrontMatterValue | undefined): value is FrontMatterMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

function isPermissionCapability(value: string): value is PermissionCapability {
  return (PERMISSION_CAPABILITIES as readonly string[]).includes(value);
}

function isYoloFilesystemScope(value: string): value is YoloFilesystemScope {
  return (YOLO_FILESYSTEM_SCOPES as readonly string[]).includes(value);
}

function countIndent(line: string): number {
  const match = /^ */.exec(line);
  return match?.[0].length ?? 0;
}

function isSkippableLine(line: string): boolean {
  const trimmed = line.trim();
  return !trimmed || trimmed.startsWith('#');
}

function findNextContentLine(
  lines: string[],
  startIndex: number,
): { index: number; indent: number; trimmed: string } | null {
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (isSkippableLine(line)) continue;
    return { index: i, indent: countIndent(line), trimmed: line.trim() };
  }
  return null;
}

function stripInlineComment(valueText: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < valueText.length; i += 1) {
    const char = valueText[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(valueText[i - 1] ?? ''))) {
      return valueText.slice(0, i);
    }
  }

  return valueText;
}

function invalidField(fieldPath: string, detail: string): WorkflowProfileError {
  return new WorkflowProfileError(
    `Invalid workflow profile front matter: ${fieldPath} ${detail}`,
    'invalid-front-matter',
  );
}

function frontMatterError(
  message: string,
  lineIndex: number,
  sourcePath?: string,
): WorkflowProfileError {
  const location = sourcePath ? `${sourcePath}:` : '';
  return new WorkflowProfileError(
    `${message} at ${location}${lineIndex + 1}`,
    'invalid-front-matter',
    sourcePath,
  );
}
