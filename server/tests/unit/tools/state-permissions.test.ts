import { describe, expect, it } from 'vitest';
import { authorizeToolCall } from '../../../src/tools/permissions/authorize-tool-call.js';
import { requiredStatePermissionsForTool } from '../../../src/tools/permissions/state-permissions.js';

describe('state tool permissions', () => {
  it('maps tool namespaces to the expected state permissions', () => {
    expect(requiredStatePermissionsForTool('mission.task.update')).toEqual(['mission:write']);
    expect(requiredStatePermissionsForTool('mission.phase.complete')).toEqual(['mission:admin']);
    expect(requiredStatePermissionsForTool('collab.note.add')).toEqual(['collab:write']);
    expect(requiredStatePermissionsForTool('permission.request')).toEqual(['permission:request']);
    expect(requiredStatePermissionsForTool('search.mission')).toEqual(['search:read']);
    expect(requiredStatePermissionsForTool('agent.checkin')).toEqual(['agent:write-self']);
    expect(requiredStatePermissionsForTool('agent.ack_message')).toEqual(['agent:write-self']);
    expect(requiredStatePermissionsForTool('agent.list_assignments')).toEqual(['mission:read']);
    expect(requiredStatePermissionsForTool('agent.request_turns')).toEqual(['agent:coordinate']);
  });

  it('denies write tools on read-only state grants', () => {
    expect(
      authorizeToolCall({
        toolName: 'mission.task.update',
        agentId: 'codex',
        statePermissions: ['mission:read'],
      }),
    ).toMatchObject({
      ok: false,
      status: 'permission_denied',
      required: ['mission:write'],
    });
  });

  it('allows yolo permission grants to use admin state tools', () => {
    expect(
      authorizeToolCall({
        toolName: 'mission.phase.complete',
        agentId: 'codex',
        permission: {
          source: 'yolo',
          mode: 'full-auto',
          target: 'unrestricted filesystem',
          reason: 'test yolo grant',
        },
      }),
    ).toMatchObject({
      ok: true,
      required: ['mission:admin'],
    });
  });

  it('requires coordination permission to update another agent status', () => {
    expect(
      authorizeToolCall({
        toolName: 'agent.set_status',
        agentId: 'codex',
        targetAgentId: 'claude',
        statePermissions: ['agent:write-self'],
      }),
    ).toMatchObject({
      ok: false,
      status: 'permission_denied',
      required: ['agent:coordinate'],
    });

    expect(
      authorizeToolCall({
        toolName: 'agent.set_status',
        agentId: 'codex',
        targetAgentId: 'claude',
        statePermissions: ['agent:write-self', 'agent:coordinate'],
      }),
    ).toMatchObject({ ok: true });
  });
});
