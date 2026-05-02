import fs from 'node:fs';
import path from 'node:path';
import { providerIdFromAgentId } from './agents/profiles.js';
import type { AgentId } from './agents/types.js';

export const PERMISSION_MODES = ['plan', 'edit', 'full-auto'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const PERMISSION_CAPABILITIES = [
  'read',
  'edit-existing',
  'create-file',
  'delete-file',
  'run-command',
  'git-commit',
  'git-push',
  'network',
  'escape-cwd',
] as const;
export type PermissionCapability = (typeof PERMISSION_CAPABILITIES)[number];

export const PERMISSION_STATUSES = ['pending', 'approved', 'denied'] as const;
export type PermissionStatus = (typeof PERMISSION_STATUSES)[number];

export const PERMISSION_TARGET_KINDS = ['file', 'directory', 'missing', 'command', 'unknown'] as const;
export type PermissionTargetKind = (typeof PERMISSION_TARGET_KINDS)[number];

export const YOLO_FILESYSTEM_SCOPES = ['task', 'cwd', 'custom', 'unrestricted'] as const;
export type YoloFilesystemScope = (typeof YOLO_FILESYSTEM_SCOPES)[number];

export interface YoloPermissionProfile {
  mode?: PermissionMode;
  filesystemScope?: YoloFilesystemScope;
  target?: string;
  web?: boolean;
}

export interface NormalizedYoloPermissionProfile {
  mode: PermissionMode;
  filesystemScope: YoloFilesystemScope;
  target?: string;
  web: boolean;
}

export interface PermissionGrant {
  requestId?: string;
  source?: 'request' | 'task' | 'yolo';
  mode: PermissionMode;
  requestedMode?: string;
  target: string;
  reason: string;
  capabilities?: PermissionCapability[];
  targetExists?: boolean | null;
  targetKind?: PermissionTargetKind;
  targetResolvedPath?: string;
  targetCheckedAt?: number;
  providerProfile?: string;
  filesystemScope?: YoloFilesystemScope;
  web?: boolean;
}

export interface ResolvedPermissionGrant extends PermissionGrant {
  requestedMode: string;
  capabilities: PermissionCapability[];
  targetExists: boolean | null;
  targetKind: PermissionTargetKind;
  targetResolvedPath: string;
  targetCheckedAt: number;
  providerProfile: string;
}

export interface ParsedPermissionRequest {
  mode: PermissionMode;
  requestedMode: string;
  target: string;
  reason: string;
  capabilities: PermissionCapability[];
  targetExists: boolean | null;
  targetKind: PermissionTargetKind;
  targetResolvedPath: string;
  targetCheckedAt: number;
  providerProfile: string;
}

export interface ExtractedPermissionRequest {
  request: ParsedPermissionRequest;
  visibleText: string;
}

export interface PermissionRequest extends ParsedPermissionRequest {
  id: string;
  roomId: string;
  agentId: AgentId;
  status: PermissionStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

export function normalizePermissionMode(value: string): PermissionMode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'write' || normalized === 'create') return 'edit';
  if (isCommandPermissionAlias(normalized) || isNetworkPermissionAlias(normalized)) return 'full-auto';
  return isPermissionMode(normalized) ? normalized : null;
}

function isCommandPermissionAlias(value: string): boolean {
  return [
    'bash',
    'shell',
    'command',
    'commands',
    'run',
    'run-command',
    'terminal',
    'exec',
    'execute',
    'git',
    'commit',
    'git-commit',
  ].includes(value);
}

function isNetworkPermissionAlias(value: string): boolean {
  return ['web', 'webfetch', 'web-fetch', 'fetch', 'network', 'push', 'git-push'].includes(value);
}

function reasonHasGitPush(reason: string): boolean {
  if (/\b(no|without|do not|don't)\s+push\b/i.test(reason)) return false;
  return /\bgit\b[\s\S]{0,120}\bpush\b/i.test(reason);
}

function commandAliasCapabilities(input: {
  requestedMode: string;
  reason: string;
}): PermissionCapability[] | null {
  const requestedMode = input.requestedMode.trim().toLowerCase();
  if (isNetworkPermissionAlias(requestedMode)) {
    return requestedMode.includes('push')
      ? ['read', 'run-command', 'git-push', 'network']
      : ['read', 'network'];
  }
  if (!isCommandPermissionAlias(requestedMode)) return null;

  const capabilities: PermissionCapability[] = ['read', 'run-command'];
  if (/\bgit\b/i.test(input.reason)) {
    if (/\bgit\b[\s\S]{0,120}\bcommit\b/i.test(input.reason) || requestedMode.includes('commit')) {
      capabilities.push('git-commit');
    }
    if (reasonHasGitPush(input.reason) || requestedMode === 'git-push') {
      capabilities.push('git-push', 'network');
    }
  }
  return uniqueCapabilities(capabilities);
}

function uniqueCapabilities(capabilities: PermissionCapability[]): PermissionCapability[] {
  return [...new Set(capabilities)];
}

function isWithinCwd(resolvedPath: string): boolean {
  if (!resolvedPath) return true;
  const cwd = path.resolve(process.cwd());
  const relative = path.relative(cwd, resolvedPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function describePermissionTarget(target: string): {
  exists: boolean | null;
  kind: PermissionTargetKind;
  resolvedPath: string;
  checkedAt: number;
} {
  const cleaned = stripTargetPunctuation(target);
  const checkedAt = Date.now();
  if (!cleaned) {
    return { exists: null, kind: 'unknown', resolvedPath: '', checkedAt };
  }
  if (!looksLikePath(cleaned)) {
    return { exists: null, kind: 'command', resolvedPath: '', checkedAt };
  }

  const resolvedPath =
    path.isAbsolute(cleaned) || path.win32.isAbsolute(cleaned)
      ? cleaned
      : path.resolve(process.cwd(), cleaned);
  try {
    const stat = fs.statSync(resolvedPath);
    return {
      exists: true,
      kind: stat.isDirectory() ? 'directory' : 'file',
      resolvedPath,
      checkedAt,
    };
  } catch {
    return { exists: false, kind: 'missing', resolvedPath, checkedAt };
  }
}

export function permissionCapabilitiesForMode(input: {
  mode: PermissionMode;
  targetInfo?: ReturnType<typeof describePermissionTarget>;
  web?: boolean;
  filesystemScope?: YoloFilesystemScope;
}): PermissionCapability[] {
  const capabilities: PermissionCapability[] =
    input.mode === 'plan'
      ? ['read']
      : input.mode === 'edit'
        ? ['read', 'edit-existing', 'create-file']
        : [
            'read',
            'edit-existing',
            'create-file',
            'delete-file',
            'run-command',
            'git-commit',
            'git-push',
            'network',
            'escape-cwd',
          ];

  if (input.web) capabilities.push('network');
  if (input.filesystemScope === 'unrestricted') capabilities.push('escape-cwd');
  if (
    input.targetInfo?.resolvedPath &&
    input.targetInfo.kind !== 'unknown' &&
    input.targetInfo.kind !== 'command' &&
    !isWithinCwd(input.targetInfo.resolvedPath)
  ) {
    capabilities.push('escape-cwd');
  }

  return uniqueCapabilities(capabilities);
}

export function providerPermissionProfile(input: {
  agentId: AgentId;
  mode: PermissionMode;
  requestedMode?: string;
  target: string;
  capabilities?: PermissionCapability[];
  targetInfo?: ReturnType<typeof describePermissionTarget>;
}): string {
  const directory = permissionTargetDirectory(input.target);
  const suffix = directory ? `; target directory ${directory}` : '';
  const capabilities = input.capabilities ?? permissionCapabilitiesForMode({ mode: input.mode });
  const commandGrant =
    input.mode === 'full-auto' &&
    capabilities.includes('run-command') &&
    Boolean(input.requestedMode && isCommandPermissionAlias(input.requestedMode)) &&
    !capabilities.includes('delete-file');
  switch (providerIdFromAgentId(input.agentId)) {
    case 'claude':
      if (commandGrant) {
        const gitOnly = capabilities.includes('git-commit') || capabilities.includes('git-push');
        const tools = gitOnly ? 'Bash(git *)' : 'Bash(*)';
        const pushGuard = capabilities.includes('git-push')
          ? ''
          : '; disallowed Bash(git push*) and Bash(git * push*)';
        return `Claude: default + allowed ${tools}${pushGuard}${suffix}`;
      }
      if (input.mode === 'edit') return `Claude: acceptEdits + allowed tools Edit,MultiEdit,Write${suffix}`;
      if (input.mode === 'full-auto') return 'Claude: bypassPermissions';
      return 'Claude: plan/read-only';
    case 'codex':
      if (commandGrant) return `Codex: workspace-write shell command grant + approval_policy=never${suffix}`;
      if (input.mode === 'edit') return `Codex: workspace-write + approval_policy=never${suffix}`;
      if (input.mode === 'full-auto') return 'Codex: dangerously bypass approvals and sandbox';
      return 'Codex: read-only sandbox + approval_policy=never';
    case 'gemini':
      if (commandGrant) return `Gemini: yolo approval mode for command execution${suffix}`;
      if (input.mode === 'edit') return `Gemini: auto_edit${suffix}`;
      if (input.mode === 'full-auto') return 'Gemini: yolo approval mode';
      return 'Gemini: plan approval mode';
    case 'echo':
      return 'Echo: no provider tools';
  }
  return 'Unknown provider: no provider tools';
}

export function buildPermissionGrant(input: {
  agentId: AgentId;
  mode: PermissionMode;
  requestedMode?: string;
  target: string;
  reason: string;
  source?: PermissionGrant['source'];
  requestId?: string;
  filesystemScope?: YoloFilesystemScope;
  web?: boolean;
}): ResolvedPermissionGrant {
  const targetInfo = describePermissionTarget(input.target);
  const aliasCapabilities = input.requestedMode
    ? commandAliasCapabilities({ requestedMode: input.requestedMode, reason: input.reason })
    : null;
  const capabilities = aliasCapabilities
    ? uniqueCapabilities([
        ...aliasCapabilities,
        ...(input.web ? (['network'] as PermissionCapability[]) : []),
        ...(input.filesystemScope === 'unrestricted'
          ? (['escape-cwd'] as PermissionCapability[])
          : []),
        ...(targetInfo.resolvedPath &&
        targetInfo.kind !== 'unknown' &&
        targetInfo.kind !== 'command' &&
        !isWithinCwd(targetInfo.resolvedPath)
          ? (['escape-cwd'] as PermissionCapability[])
          : []),
      ])
    : permissionCapabilitiesForMode({
        mode: input.mode,
        targetInfo,
        ...(input.web !== undefined ? { web: input.web } : {}),
        ...(input.filesystemScope !== undefined ? { filesystemScope: input.filesystemScope } : {}),
      });
  const providerProfile = providerPermissionProfile({
    agentId: input.agentId,
    mode: input.mode,
    ...(input.requestedMode ? { requestedMode: input.requestedMode } : {}),
    target: input.target,
    capabilities,
    targetInfo,
  });
  return {
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.source ? { source: input.source } : {}),
    mode: input.mode,
    requestedMode: input.requestedMode ?? input.mode,
    target: input.target,
    reason: input.reason,
    capabilities,
    targetExists: targetInfo.exists,
    targetKind: targetInfo.kind,
    targetResolvedPath: targetInfo.resolvedPath,
    targetCheckedAt: targetInfo.checkedAt,
    providerProfile,
    ...(input.filesystemScope ? { filesystemScope: input.filesystemScope } : {}),
    ...(input.web ? { web: true } : {}),
  };
}

export function isYoloFilesystemScope(value: string): value is YoloFilesystemScope {
  return (YOLO_FILESYSTEM_SCOPES as readonly string[]).includes(value);
}

function cleanValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseKeyValues(lines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const match = /^([a-z][a-z-]*)\s*:\s*(.+)$/i.exec(line.trim());
    if (!match) continue;
    const key = match[1]?.toLowerCase();
    const value = match[2];
    if (key && value) fields[key] = cleanValue(value);
  }
  return fields;
}

function parsePermissionRequestLines(
  lines: string[],
  agentId: AgentId = 'echo',
): ParsedPermissionRequest | null {
  const fields = parseKeyValues(lines);
  const requestedMode = fields.mode ?? '';
  const mode = requestedMode ? normalizePermissionMode(requestedMode) : null;
  const target = fields.target;
  const reason = fields.reason;

  if (!mode || !target || !reason) return null;

  const grant = buildPermissionGrant({
    agentId,
    mode,
    requestedMode,
    target: target.slice(0, 500),
    reason: reason.slice(0, 1000),
  });
  return grant;
}

export function extractPermissionRequest(
  text: string,
  agentId: AgentId = 'echo',
): ExtractedPermissionRequest | null {
  const lines = text.split(/\r?\n/);
  for (let markerIndex = 0; markerIndex < lines.length; markerIndex += 1) {
    if (!/^\/permission-request\b/i.test(lines[markerIndex]?.trim() ?? '')) continue;

    const blockLines: string[] = [];
    let endIndex = lines.length;
    for (let i = markerIndex + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      if (!trimmed && blockLines.length > 0) {
        endIndex = i + 1;
        break;
      }
      if (!/^([a-z][a-z-]*)\s*:\s*(.+)$/i.test(trimmed)) {
        endIndex = blockLines.length > 0 ? i : markerIndex + 1;
        break;
      }
      blockLines.push(line);
    }

    const request = parsePermissionRequestLines(blockLines, agentId);
    if (!request) continue;

    return {
      request,
      visibleText: [...lines.slice(0, markerIndex), ...lines.slice(endIndex)].join('\n').trim(),
    };
  }

  return null;
}

export function parsePermissionRequest(
  text: string,
  agentId: AgentId = 'echo',
): ParsedPermissionRequest | null {
  return extractPermissionRequest(text, agentId)?.request ?? null;
}

/* Legacy helper retained for tests/importers that only need the parsed request. */
export function parsePermissionRequestStrictBlock(
  text: string,
  agentId: AgentId = 'echo',
): ParsedPermissionRequest | null {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith('/permission-request')) return null;
  const fields = parseKeyValues(trimmed.split(/\r?\n/).slice(1));
  const requestedMode = fields.mode ?? '';
  const mode = requestedMode ? normalizePermissionMode(requestedMode) : null;
  const target = fields.target;
  const reason = fields.reason;

  if (!mode || !target || !reason) return null;

  return buildPermissionGrant({
    agentId,
    mode,
    requestedMode,
    target: target.slice(0, 500),
    reason: reason.slice(0, 1000),
  });
}

function stripTargetPunctuation(target: string): string {
  return target.trim().replace(/^`|`$/g, '').replace(/[),.;:]+$/g, '');
}

function looksLikePath(target: string): boolean {
  return (
    path.isAbsolute(target) ||
    path.win32.isAbsolute(target) ||
    target.startsWith('.') ||
    target.includes('/') ||
    target.includes('\\')
  );
}

export function permissionTargetDirectory(target: string): string | null {
  const cleaned = stripTargetPunctuation(target);
  if (!cleaned || !looksLikePath(cleaned)) return null;

  const absolute =
    path.isAbsolute(cleaned) || path.win32.isAbsolute(cleaned)
      ? cleaned
      : path.resolve(process.cwd(), cleaned);

  try {
    const stat = fs.statSync(absolute);
    return stat.isDirectory() ? absolute : path.dirname(absolute);
  } catch {
    if (/[\\/]$/.test(absolute)) return absolute.replace(/[\\/]+$/, '');
    return path.dirname(absolute);
  }
}
