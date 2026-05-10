// server/src/tools/handlers/mission-approve-tools.ts
//
// mission.approve — pre-authorised approver agent approves / rejects /
// requests-changes on a task. Auth happens in the applicator
// (room.approverAgentIds + 'human' literal). Humans never call this
// MCP tool — they go through the HTTP routes.

import { applyMissionApprove } from '../../mission-state/mission-approve-applicator.js';
import { defineTool } from '../registry.js';
import {
  missionApproveSchema,
  type MissionApproveArgs,
} from '../schemas/mission-approve.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

export function handleMissionApprove(
  input: AgentToolHandlerInput<MissionApproveArgs>,
): AgentToolResult {
  const result = applyMissionApprove({
    db: input.db,
    taskId: input.args.taskId,
    action: input.args.action,
    ...(input.args.reason !== undefined ? { reason: input.args.reason } : {}),
    byAgentId: input.call.agentId,
  });

  if (result.rejected) {
    return {
      status: 'rejected',
      summary: `mission.approve rejected: ${result.reason ?? 'unknown reason'}`,
      effects: [],
    };
  }

  return {
    status: 'applied',
    summary: `mission.approve: ${input.args.action} on ${input.args.taskId} → ${result.proposalStatus}`,
    data: {
      taskId: input.args.taskId,
      action: input.args.action,
      proposalStatus: result.proposalStatus,
    },
    effects: [
      {
        kind: 'task-updated',
        targetType: 'task',
        targetId: input.args.taskId,
        summary: `Approver ${input.call.agentId} ${input.args.action}d the task.`,
        payload: { action: input.args.action, proposalStatus: result.proposalStatus },
      },
    ],
  };
}

export const missionApproveTool = defineTool<MissionApproveArgs>({
  name: 'mission.approve',
  summary:
    'Pre-authorised approver agent approves / rejects / requests-changes on a task. Humans use HTTP routes instead.',
  requiredPermissions: ['mission:admin'],
  schema: missionApproveSchema,
  handler: handleMissionApprove,
});

export const missionApproveTools = [missionApproveTool] as const;
