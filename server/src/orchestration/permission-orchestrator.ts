import type { AgentId } from '../agents/types.js';
import {
  buildPermissionGrant,
  isPermissionMode,
  isYoloFilesystemScope,
  type NormalizedYoloPermissionProfile,
  type PermissionGrant,
  type ParsedPermissionRequest,
  type YoloFilesystemScope,
  type YoloPermissionProfile,
} from '../permissions.js';
import type { Task } from '../repos/tasks.js';

export const YOLO_PERMISSION_AUTO_APPROVAL_LIMIT = 3;

export type PermissionRequestContinuation =
  | { kind: 'manual-approval' }
  | {
      kind: 'yolo-auto-followup';
      autoPermission: PermissionGrant;
      nextAutoApprovalCount: number;
    }
  | {
      kind: 'yolo-auto-approval-limit';
      limit: number;
    };

function cleanYoloTarget(target: unknown): string | undefined {
  if (typeof target !== 'string') return undefined;
  const trimmed = target.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : undefined;
}

export function normalizeYoloPermissionProfile(
  profile?: YoloPermissionProfile,
): NormalizedYoloPermissionProfile {
  const rawScope = typeof profile?.filesystemScope === 'string' ? profile.filesystemScope : '';
  const filesystemScope = isYoloFilesystemScope(rawScope) ? rawScope : 'task';
  const rawMode = typeof profile?.mode === 'string' ? profile.mode : '';
  const mode =
    filesystemScope === 'unrestricted' ? 'full-auto' : isPermissionMode(rawMode) ? rawMode : 'edit';
  const target = cleanYoloTarget(profile?.target);
  return {
    mode,
    filesystemScope,
    ...(target !== undefined ? { target } : {}),
    web: profile?.web === true,
  };
}

export function inferYoloPermissionProfileFromText(text: string): YoloPermissionProfile | null {
  const normalized = text.toLowerCase();
  if (!/\byolo\b/.test(normalized)) return null;
  if (
    !/\byolo\s+mode\b|\byolo\s+run\b|\byolo\s+collaboration\b|\bunrestricted\s+yolo\b/.test(
      normalized,
    )
  ) {
    return null;
  }
  if (/\b(no|not|never|don't|do not)\b.{0,32}\byolo\b/.test(normalized)) return null;

  const filesystemScope: YoloFilesystemScope = /\bunrestricted\b/.test(normalized)
    ? 'unrestricted'
    : /\bfireside\s+cwd\b|\bcwd\b/.test(normalized)
      ? 'cwd'
      : 'task';
  const mode =
    filesystemScope === 'unrestricted' ||
    /\bfull[-\s]?auto\b|\bskip permissions\b|\bdangerously\b/.test(normalized)
      ? 'full-auto'
      : /\bread[-\s]?only\b|\bplan\b/.test(normalized)
        ? 'plan'
        : 'edit';
  const web = /\b(web|webfetch|web fetch|internet|browse|browser|fetch)\b/.test(normalized);
  return { mode, filesystemScope, web };
}

export function yoloScopeLabel(scope: YoloFilesystemScope): string {
  switch (scope) {
    case 'task':
      return 'active mission path';
    case 'cwd':
      return 'Fireside working directory';
    case 'custom':
      return 'custom path';
    case 'unrestricted':
      return 'unrestricted filesystem';
  }
}

export function buildYoloPermissionGrant(input: {
  profile: NormalizedYoloPermissionProfile;
  activeTask: Task | null;
  agentId?: AgentId;
  cwd?: string;
}): PermissionGrant {
  const cwd = input.cwd ?? process.cwd();
  const target = (() => {
    switch (input.profile.filesystemScope) {
      case 'task':
        return input.activeTask?.repoPath || cwd;
      case 'cwd':
        return cwd;
      case 'custom':
        return input.profile.target || input.activeTask?.repoPath || cwd;
      case 'unrestricted':
        return 'unrestricted filesystem';
    }
  })();
  const reason = [
    `YOLO collaboration permission profile (${input.profile.mode}, ${yoloScopeLabel(input.profile.filesystemScope)}).`,
    input.profile.web
      ? 'The human requested web lookup/fetch access for this YOLO run where supported.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    ...buildPermissionGrant({
      agentId: input.agentId ?? 'echo',
      source: 'yolo',
      mode: input.profile.mode,
      target,
      reason,
      filesystemScope: input.profile.filesystemScope,
      ...(input.profile.web ? { web: true } : {}),
    }),
    source: 'yolo',
    mode: input.profile.mode,
    target,
    reason,
    filesystemScope: input.profile.filesystemScope,
    ...(input.profile.web ? { web: true } : {}),
  };
}

export function buildYoloAutoApprovedPermissionGrant(input: {
  agentId: AgentId;
  request: ParsedPermissionRequest | PermissionGrant;
  currentPermission: PermissionGrant;
}): PermissionGrant {
  return buildPermissionGrant({
    agentId: input.agentId,
    source: 'yolo',
    mode: input.request.mode,
    ...(input.request.requestedMode ? { requestedMode: input.request.requestedMode } : {}),
    target: input.request.target,
    reason: input.request.reason,
    ...(input.currentPermission.filesystemScope
      ? { filesystemScope: input.currentPermission.filesystemScope }
      : {}),
    ...(input.currentPermission.web ? { web: true } : {}),
  });
}

export function buildRoomYoloPermissionGrant(input: {
  agentId: AgentId;
  activeTask: Task | null;
}): PermissionGrant {
  return buildYoloPermissionGrant({
    profile: {
      mode: 'full-auto',
      filesystemScope: 'unrestricted',
      web: true,
    },
    activeTask: input.activeTask,
    agentId: input.agentId,
  });
}

export function planPermissionRequestContinuation(input: {
  agentId: AgentId;
  request: ParsedPermissionRequest;
  effectivePermission: PermissionGrant | undefined;
  yoloPermissionAutoApprovals: number;
  autoApprovalLimit?: number;
}): PermissionRequestContinuation {
  if (input.effectivePermission?.source !== 'yolo') return { kind: 'manual-approval' };

  const limit = input.autoApprovalLimit ?? YOLO_PERMISSION_AUTO_APPROVAL_LIMIT;
  if (input.yoloPermissionAutoApprovals >= limit) {
    return { kind: 'yolo-auto-approval-limit', limit };
  }

  return {
    kind: 'yolo-auto-followup',
    autoPermission: buildYoloAutoApprovedPermissionGrant({
      agentId: input.agentId,
      request: input.request,
      currentPermission: input.effectivePermission,
    }),
    nextAutoApprovalCount: input.yoloPermissionAutoApprovals + 1,
  };
}
