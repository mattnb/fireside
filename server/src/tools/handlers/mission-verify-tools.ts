// server/src/tools/handlers/mission-verify-tools.ts
//
// mission.verify — agent records a doer or verifier check against an AC.
// Wraps applyMissionVerify; same-agent verifier checks are rejected with a
// diagnostic at the applicator level.

import { applyMissionVerify } from '../../mission-state/mission-verify-applicator.js';
import { getAcceptanceCriterion } from '../../repos/acceptance-criteria.js';
import { defineTool } from '../registry.js';
import {
  missionVerifySchema,
  type MissionVerifyArgs,
} from '../schemas/mission-verify.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

export function handleMissionVerify(
  input: AgentToolHandlerInput<MissionVerifyArgs>,
): AgentToolResult {
  const ac = getAcceptanceCriterion(input.db, input.args.acId);
  if (!ac) {
    return {
      status: 'rejected',
      summary: `mission.verify rejected: unknown ac ${input.args.acId}`,
      effects: [],
    };
  }

  const result = applyMissionVerify({
    db: input.db,
    acId: input.args.acId,
    side: input.args.side,
    status: input.args.status,
    evidence: input.args.evidence,
    byAgentId: input.call.agentId,
  });

  if (result.rejected) {
    return {
      status: 'rejected',
      summary: `mission.verify rejected: ${result.reason ?? 'unknown reason'}`,
      effects: [],
    };
  }

  return {
    status: 'applied',
    summary: `mission.verify: ${input.args.side} ${input.args.status} on ${input.args.acId}`,
    data: {
      acId: input.args.acId,
      taskId: result.taskId,
      side: input.args.side,
      status: input.args.status,
    },
    effects: [
      {
        kind: 'task-updated',
        targetType: 'task',
        targetId: result.taskId ?? ac.taskId,
        summary: `${input.args.side} recorded ${input.args.status} on AC ${input.args.acId}`,
        payload: { acId: input.args.acId, side: input.args.side, status: input.args.status },
      },
    ],
  };
}

export const missionVerifyTool = defineTool<MissionVerifyArgs>({
  name: 'mission.verify',
  summary:
    'Record a doer or verifier check on an acceptance criterion. Same-agent verifier checks are rejected.',
  requiredPermissions: ['mission:write'],
  schema: missionVerifySchema,
  handler: handleMissionVerify,
});

export const missionVerifyTools = [missionVerifyTool] as const;
