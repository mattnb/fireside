import { buildPermissionGrant, type ParsedPermissionRequest } from '../../permissions.js';
import { defineTool } from '../registry.js';
import { parsePermissionRequestArgs, type PermissionRequestArgs } from '../schemas/permission.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

export function handlePermissionRequest(
  input: AgentToolHandlerInput<PermissionRequestArgs>,
): AgentToolResult {
  const request: ParsedPermissionRequest = buildPermissionGrant({
    agentId: input.call.agentId,
    mode: input.args.mode,
    requestedMode: input.args.requestedMode ?? input.args.mode,
    target: input.args.target,
    reason: input.args.reason,
    ...(input.args.filesystemScope ? { filesystemScope: input.args.filesystemScope } : {}),
    ...(input.args.web ? { web: true } : {}),
  });

  return {
    status: 'applied',
    summary: `${request.mode} permission requested for ${request.target}`,
    data: request,
    effects: [
      {
        kind: 'permission-requested',
        targetType: 'permission-request',
        summary: `${request.mode} permission requested for ${request.target}`,
        payload: request,
      },
    ],
  };
}

export const permissionRequestTool = defineTool<PermissionRequestArgs>({
  name: 'permission.request',
  summary: 'Request edit, command, network, or full-auto permission for a future turn.',
  requiredPermissions: ['permission:request'],
  schema: {
    parse: parsePermissionRequestArgs,
  },
  handler: handlePermissionRequest,
});
