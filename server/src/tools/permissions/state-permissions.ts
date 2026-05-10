export const STATE_PERMISSIONS = [
  'mission:read',
  'mission:write',
  'mission:admin',
  'collab:write',
  'agent:write-self',
  'agent:coordinate',
  'permission:request',
  'search:read',
] as const;

export type StatePermission = (typeof STATE_PERMISSIONS)[number];

export const DEFAULT_YOLO_STATE_PERMISSIONS: readonly StatePermission[] = STATE_PERMISSIONS;

export function isStatePermission(value: string): value is StatePermission {
  return (STATE_PERMISSIONS as readonly string[]).includes(value);
}

export function normalizeStatePermissions(values: readonly string[] | undefined): StatePermission[] {
  if (!values) return [];
  return [...new Set(values.filter(isStatePermission))];
}

export function hasStatePermissions(
  granted: readonly StatePermission[],
  required: readonly StatePermission[],
): boolean {
  return required.every((permission) => granted.includes(permission));
}

export function requiredStatePermissionsForTool(toolName: string): StatePermission[] {
  if (toolName.startsWith('search.')) return ['search:read'];
  if (toolName === 'permission.request') return ['permission:request'];
  if (toolName.startsWith('collab.')) return ['collab:write'];

  if (toolName === 'agent.list_assignments') return ['mission:read'];
  if (toolName === 'agent.request_turns') return ['agent:coordinate'];
  if (toolName.startsWith('agent.')) return ['agent:write-self'];

  if (toolName === 'mission.snapshot') return ['mission:read'];
  if (toolName === 'mission.complete' || toolName === 'mission.repair_status') {
    return ['mission:admin'];
  }

  if (toolName === 'mission.phase.complete' || toolName === 'mission.phase.reopen') {
    return ['mission:admin'];
  }
  if (toolName === 'mission.phase.list_blockers') return ['mission:read'];

  if (toolName === 'mission.approve') return ['mission:admin'];

  if (
    toolName.startsWith('mission.') ||
    toolName.startsWith('mission.plan.') ||
    toolName.startsWith('mission.phase.') ||
    toolName.startsWith('mission.task.') ||
    toolName.startsWith('mission.evidence.') ||
    toolName === 'mission.receipt.submit'
  ) {
    return ['mission:write'];
  }

  return [];
}
