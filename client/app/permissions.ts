// client/app/permissions.ts
// Pure label resolvers for permission modes and permission requests.

import type { PermissionRequest } from './api.types';

export function permissionModeLabel(mode: string | undefined): string {
  if (mode === 'full-auto') return 'full auto';
  if (mode === 'edit') return 'edit/write';
  return 'read-only';
}

const COMMAND_REQUEST_MODES = new Set([
  'bash',
  'shell',
  'command',
  'run-command',
  'git',
  'commit',
  'git-commit',
]);

export function permissionRequestLabel(request: PermissionRequest): string {
  if (request.requestedMode && request.requestedMode !== request.mode) {
    if (COMMAND_REQUEST_MODES.has(request.requestedMode)) {
      return `${request.requestedMode} command`;
    }
    return `${request.requestedMode} (${permissionModeLabel(request.mode)})`;
  }
  return permissionModeLabel(request.mode);
}
