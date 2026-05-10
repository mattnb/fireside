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
  // No fields today. Reserved for future overrides (e.g. an explicit
  // verifier nomination supplied at propose time).
  reason?: string;
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
    },
  },
  parse(input: unknown): MissionProposeSubmitArgs {
    if (input === null || input === undefined) return {};
    if (!isRecord(input)) throw new Error('mission.propose.submit args must be an object');
    const result: MissionProposeSubmitArgs = {};
    if (typeof input.reason === 'string' && input.reason.trim()) {
      result.reason = input.reason.trim();
    }
    return result;
  },
};
