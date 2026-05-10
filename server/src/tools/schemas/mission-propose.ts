// server/src/tools/schemas/mission-propose.ts
//
// Schema for mission.propose.submit. Lead transitions a task from
// elaborating → proposed once every clarifying question has an answer and
// at least one acceptance criterion exists. The handler does the validation;
// the tool itself takes no arguments beyond optional context.

type UnknownRecord = Record<string, unknown>;

function isRecord(input: unknown): input is UnknownRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export interface MissionProposeSubmitArgs {
  reason?: string;
  /** Optional verifier nomination. If unset, the gate auto-picks at approve
   *  time using the verifier-selection heuristic (first non-lead, non-doer
   *  agent). */
  verifierAgentId?: string;
}

export const missionProposeSubmitSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reason: {
        type: 'string',
        description: 'Optional one-line summary of what is being proposed.',
      },
      verifierAgentId: {
        type: 'string',
        description:
          'Optional agent id nominated as verifier. Falls back to the auto-pick at approve time if omitted.',
      },
    },
  },
  parse(input: unknown): MissionProposeSubmitArgs {
    if (input === null || input === undefined) return {};
    if (!isRecord(input)) throw new Error('mission.propose.submit args must be an object');
    const result: MissionProposeSubmitArgs = {};
    if (typeof input.reason === 'string' && input.reason.trim()) {
      result.reason = input.reason.trim();
    }
    const verifierRaw =
      typeof input.verifierAgentId === 'string'
        ? input.verifierAgentId
        : typeof input.verifier_agent_id === 'string'
          ? input.verifier_agent_id
          : typeof input.verifier === 'string'
            ? input.verifier
            : undefined;
    if (typeof verifierRaw === 'string' && verifierRaw.trim()) {
      result.verifierAgentId = verifierRaw.trim();
    }
    return result;
  },
};
