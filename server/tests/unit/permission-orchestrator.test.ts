import { describe, expect, it } from 'vitest';
import type { ParsedPermissionRequest } from '../../src/permissions.js';
import type { Task } from '../../src/repos/tasks.js';
import {
  buildRoomYoloPermissionGrant,
  buildYoloPermissionGrant,
  inferYoloPermissionProfileFromText,
  normalizeYoloPermissionProfile,
  planPermissionRequestContinuation,
} from '../../src/orchestration/permission-orchestrator.js';

const activeTask: Task = {
  id: 'task',
  roomId: 'room',
  title: 'Mission',
  goal: '',
  repoPath: 'C:/work/project',
  acceptanceCriteria: '',
  agents: ['claude', 'codex'],
  status: 'active',
  capabilityProfile: 'edit',
  summary: '',
  createdAt: 1,
  updatedAt: 1,
};

const permissionRequest: ParsedPermissionRequest = {
  mode: 'edit',
  requestedMode: 'write',
  target: 'C:/work/project/docs/plan.md',
  reason: 'Create the plan.',
  capabilities: ['read', 'edit-existing', 'create-file'],
  targetExists: false,
  targetKind: 'missing',
  targetResolvedPath: 'C:/work/project/docs/plan.md',
  targetCheckedAt: 1,
  providerProfile: 'Claude: acceptEdits',
};

describe('permission orchestrator', () => {
  it('infers inline YOLO profile requests conservatively', () => {
    expect(inferYoloPermissionProfileFromText('start unrestricted YOLO mode with web fetch')).toEqual(
      {
        mode: 'full-auto',
        filesystemScope: 'unrestricted',
        web: true,
      },
    );
    expect(inferYoloPermissionProfileFromText('please do not yolo this')).toBeNull();
  });

  it('normalizes missing YOLO profile fields to task-scoped edit access', () => {
    expect(normalizeYoloPermissionProfile({})).toEqual({
      mode: 'edit',
      filesystemScope: 'task',
      web: false,
    });
  });

  it('builds task-scoped and room-level YOLO grants', () => {
    const taskGrant = buildYoloPermissionGrant({
      profile: normalizeYoloPermissionProfile({ mode: 'edit', filesystemScope: 'task' }),
      activeTask,
      agentId: 'claude',
      cwd: 'C:/fireside',
    });
    const roomGrant = buildRoomYoloPermissionGrant({ agentId: 'codex', activeTask });

    expect(taskGrant).toMatchObject({
      source: 'yolo',
      mode: 'edit',
      target: 'C:/work/project',
      filesystemScope: 'task',
    });
    expect(roomGrant).toMatchObject({
      source: 'yolo',
      mode: 'full-auto',
      target: 'unrestricted filesystem',
      filesystemScope: 'unrestricted',
      web: true,
    });
  });

  it('plans manual permission waits when the current turn is not YOLO granted', () => {
    expect(
      planPermissionRequestContinuation({
        agentId: 'claude',
        request: permissionRequest,
        effectivePermission: undefined,
        yoloPermissionAutoApprovals: 0,
      }),
    ).toEqual({ kind: 'manual-approval' });
  });

  it('auto-continues YOLO permission requests until the safety limit is reached', () => {
    const currentPermission = buildRoomYoloPermissionGrant({ agentId: 'claude', activeTask });

    expect(
      planPermissionRequestContinuation({
        agentId: 'claude',
        request: permissionRequest,
        effectivePermission: currentPermission,
        yoloPermissionAutoApprovals: 2,
        autoApprovalLimit: 3,
      }),
    ).toMatchObject({
      kind: 'yolo-auto-followup',
      nextAutoApprovalCount: 3,
      autoPermission: {
        source: 'yolo',
        mode: 'edit',
        target: permissionRequest.target,
      },
    });

    expect(
      planPermissionRequestContinuation({
        agentId: 'claude',
        request: permissionRequest,
        effectivePermission: currentPermission,
        yoloPermissionAutoApprovals: 3,
        autoApprovalLimit: 3,
      }),
    ).toEqual({ kind: 'yolo-auto-approval-limit', limit: 3 });
  });
});
