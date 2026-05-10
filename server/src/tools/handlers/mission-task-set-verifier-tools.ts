// server/src/tools/handlers/mission-task-set-verifier-tools.ts
//
// mission.task.set_verifier — assign or clear the verifier agent on a task.
// Caller validation:
//   - Must be the lead, the human, or a member of room.approverAgentIds.
//   - Cannot assign the lead itself (no self-review).
//   - Target agent must be in the room (or null to clear).

import { getRoom } from '../../repos/rooms.js';
import {
  getActiveTask,
  getTask,
  setVerifierAgentId,
} from '../../repos/tasks.js';
import { defineTool } from '../registry.js';
import {
  missionTaskSetVerifierSchema,
  type MissionTaskSetVerifierArgs,
} from '../schemas/mission-task-set-verifier.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

export function handleMissionTaskSetVerifier(
  input: AgentToolHandlerInput<MissionTaskSetVerifierArgs>,
): AgentToolResult {
  const taskId = input.args.taskId ?? input.call.missionId ?? null;
  const mission = taskId
    ? getTask(input.db, taskId)
    : getActiveTask(input.db, input.call.roomId);
  if (!mission) {
    return {
      status: 'rejected',
      summary: 'mission.task.set_verifier rejected: no matching mission',
      effects: [],
    };
  }

  const room = getRoom(input.db, mission.roomId);
  if (!room) {
    return {
      status: 'rejected',
      summary: `mission.task.set_verifier rejected: room ${mission.roomId} not found`,
      effects: [],
    };
  }

  // Authorization: lead, human, or pre-authorised approver may reassign.
  const callerIsLead = room.leadAgentId === input.call.agentId;
  const callerIsApprover = room.approverAgentIds.includes(input.call.agentId);
  const callerIsHuman = input.call.agentId === 'human';
  if (!callerIsLead && !callerIsApprover && !callerIsHuman) {
    return {
      status: 'rejected',
      summary: `mission.task.set_verifier rejected: ${input.call.agentId} is neither the lead nor an approver`,
      effects: [],
    };
  }

  // Target validation.
  const target = input.args.verifierAgentId;
  if (target !== null) {
    if (!room.agents.includes(target)) {
      return {
        status: 'rejected',
        summary: `mission.task.set_verifier rejected: ${target} is not a member of the room`,
        effects: [],
      };
    }
    if (room.leadAgentId && target === room.leadAgentId) {
      return {
        status: 'rejected',
        summary: 'mission.task.set_verifier rejected: lead cannot self-verify',
        effects: [],
      };
    }
  }

  const updated = setVerifierAgentId(input.db, mission.id, target);
  if (!updated) {
    return {
      status: 'failed',
      summary: 'mission.task.set_verifier failed: task vanished mid-update',
      effects: [],
    };
  }

  return {
    status: 'applied',
    summary: `mission.task.set_verifier: ${mission.id} → ${target ?? 'null (humans verify)'}`,
    data: { taskId: mission.id, verifierAgentId: updated.verifierAgentId },
    effects: [
      {
        kind: 'task-updated',
        targetType: 'task',
        targetId: mission.id,
        summary: `Verifier reassigned to ${target ?? 'human'}.`,
        payload: { verifierAgentId: updated.verifierAgentId },
      },
    ],
  };
}

export const missionTaskSetVerifierTool = defineTool<MissionTaskSetVerifierArgs>({
  name: 'mission.task.set_verifier',
  summary:
    'Assign or clear the verifier agent on a task. Pass null to clear (humans verify by default).',
  requiredPermissions: ['mission:write'],
  schema: missionTaskSetVerifierSchema,
  handler: handleMissionTaskSetVerifier,
});

export const missionTaskSetVerifierTools = [missionTaskSetVerifierTool] as const;
