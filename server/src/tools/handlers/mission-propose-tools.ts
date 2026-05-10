// server/src/tools/handlers/mission-propose-tools.ts
//
// mission.propose.submit — lead transitions a task from elaborating →
// proposed once every clarifying question has an answer and at least one
// AC row exists. Validation lives here; setProposalStatus enforces the
// state-machine edge.

import { listAcceptanceCriteria } from '../../repos/acceptance-criteria.js';
import { openQuestions } from '../../repos/clarifying-questions.js';
import { getRoom } from '../../repos/rooms.js';
import {
  getActiveTask,
  getTask,
  setProposalStatus,
  setVerifierAgentId,
} from '../../repos/tasks.js';
import { defineTool } from '../registry.js';
import {
  missionProposeSubmitSchema,
  type MissionProposeSubmitArgs,
} from '../schemas/mission-propose.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

export function handleMissionProposeSubmit(
  input: AgentToolHandlerInput<MissionProposeSubmitArgs>,
): AgentToolResult {
  const mission = input.call.missionId
    ? getTask(input.db, input.call.missionId)
    : getActiveTask(input.db, input.call.roomId);
  if (!mission) {
    return {
      status: 'rejected',
      summary: 'mission.propose.submit rejected: no active mission',
      effects: [],
    };
  }

  if (mission.proposalStatus !== 'elaborating' && mission.proposalStatus !== 'draft') {
    return {
      status: 'rejected',
      summary: `mission.propose.submit rejected: task is in ${mission.proposalStatus}, not elaborating/draft`,
      effects: [],
    };
  }

  const open = openQuestions(input.db, mission.id);
  if (open.length > 0) {
    return {
      status: 'rejected',
      summary: `mission.propose.submit rejected: ${open.length} clarifying question(s) unanswered`,
      data: { unansweredQuestionIds: open.map((q) => q.id) },
      effects: [],
    };
  }

  const acs = listAcceptanceCriteria(input.db, mission.id);
  if (acs.length === 0) {
    return {
      status: 'rejected',
      summary: 'mission.propose.submit rejected: at least one acceptance criterion required',
      effects: [],
    };
  }

  // Validate optional verifier nomination — must be a member of the room
  // and not the lead (lead can't review their own proposal).
  if (input.args.verifierAgentId !== undefined) {
    const room = getRoom(input.db, mission.roomId);
    if (!room) {
      return {
        status: 'rejected',
        summary: `mission.propose.submit rejected: room ${mission.roomId} not found`,
        effects: [],
      };
    }
    if (!room.agents.includes(input.args.verifierAgentId)) {
      return {
        status: 'rejected',
        summary: `mission.propose.submit rejected: nominated verifier ${input.args.verifierAgentId} is not a member of the room`,
        effects: [],
      };
    }
    if (room.leadAgentId && input.args.verifierAgentId === room.leadAgentId) {
      return {
        status: 'rejected',
        summary: 'mission.propose.submit rejected: lead cannot self-verify',
        effects: [],
      };
    }
  }

  // From draft we hop through elaborating implicitly so the spec's
  // documented edge (elaborating → proposed) is preserved. Same-state on
  // elaborating is idempotent.
  if (mission.proposalStatus === 'draft') {
    setProposalStatus(input.db, mission.id, 'elaborating', input.call.agentId);
  }
  const updated = setProposalStatus(input.db, mission.id, 'proposed', input.call.agentId);
  if (!updated) {
    return {
      status: 'failed',
      summary: 'mission.propose.submit failed: task vanished mid-update',
      effects: [],
    };
  }
  if (input.args.verifierAgentId) {
    setVerifierAgentId(input.db, updated.id, input.args.verifierAgentId);
  }

  return {
    status: 'applied',
    summary: `mission.propose.submit: ${updated.id} → proposed`,
    data: {
      taskId: updated.id,
      proposalStatus: updated.proposalStatus,
      proposedByAgentId: updated.proposedByAgentId,
      acceptanceCriteriaCount: acs.length,
      ...(input.args.verifierAgentId
        ? { verifierAgentId: input.args.verifierAgentId }
        : {}),
    },
    effects: [
      {
        kind: 'task-updated',
        targetType: 'task',
        targetId: updated.id,
        summary: `Mission proposed by ${input.call.agentId}.`,
        payload: { proposalStatus: 'proposed' },
      },
    ],
  };
}

export const missionProposeSubmitTool = defineTool<MissionProposeSubmitArgs>({
  name: 'mission.propose.submit',
  summary:
    'Lead promotes the active mission from elaborating to proposed once questions are answered and ACs are listed.',
  requiredPermissions: ['mission:write'],
  schema: missionProposeSubmitSchema,
  handler: handleMissionProposeSubmit,
});

export const missionProposeTools = [missionProposeSubmitTool] as const;
