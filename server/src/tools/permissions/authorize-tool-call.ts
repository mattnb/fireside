import type { PermissionGrant } from '../../permissions.js';
import {
  DEFAULT_YOLO_STATE_PERMISSIONS,
  hasStatePermissions,
  requiredStatePermissionsForTool,
  type StatePermission,
} from './state-permissions.js';

export interface ToolAuthorizationInput {
  toolName: string;
  agentId: string;
  targetAgentId?: string;
  requiredPermissions?: readonly StatePermission[];
  statePermissions?: readonly StatePermission[];
  permission?: PermissionGrant | null;
}

export type ToolAuthorizationResult =
  | {
      ok: true;
      granted: StatePermission[];
      required: StatePermission[];
    }
  | {
      ok: false;
      status: 'permission_denied';
      reason: string;
      granted: StatePermission[];
      required: StatePermission[];
    };

export function statePermissionsForGrant(permission: PermissionGrant | null | undefined): StatePermission[] {
  if (!permission) return ['mission:read', 'search:read'];
  if (permission.source === 'yolo') return [...DEFAULT_YOLO_STATE_PERMISSIONS];

  switch (permission.mode) {
    case 'full-auto':
      return [...DEFAULT_YOLO_STATE_PERMISSIONS];
    case 'edit':
      return [
        'mission:read',
        'mission:write',
        'collab:write',
        'agent:write-self',
        'permission:request',
        'search:read',
      ];
    case 'plan':
      return ['mission:read', 'agent:write-self', 'permission:request', 'search:read'];
  }
}

export function authorizeToolCall(input: ToolAuthorizationInput): ToolAuthorizationResult {
  const required = [...(input.requiredPermissions ?? requiredStatePermissionsForTool(input.toolName))];
  const granted = [
    ...new Set([...(input.statePermissions ?? []), ...statePermissionsForGrant(input.permission)]),
  ];

  if (
    input.toolName === 'agent.set_status' &&
    input.targetAgentId &&
    input.targetAgentId !== input.agentId &&
    !granted.includes('agent:coordinate')
  ) {
    return {
      ok: false,
      status: 'permission_denied',
      reason: `agent.set_status for another agent requires agent:coordinate`,
      granted,
      required: ['agent:coordinate'],
    };
  }

  if (hasStatePermissions(granted, required)) {
    return { ok: true, granted, required };
  }

  const missing = required.filter((permission) => !granted.includes(permission));
  return {
    ok: false,
    status: 'permission_denied',
    reason: `Missing state permission: ${missing.join(', ')}`,
    granted,
    required,
  };
}
