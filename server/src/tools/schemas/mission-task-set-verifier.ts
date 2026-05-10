// server/src/tools/schemas/mission-task-set-verifier.ts
//
// Schema for mission.task.set_verifier — lead (or other authorised caller)
// reassigns the verifier agent on the active or named task. Pass null to
// clear the assignment (so the human becomes the verifier by default).

type UnknownRecord = Record<string, unknown>;

function isRecord(input: unknown): input is UnknownRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function optionalString(input: UnknownRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

export interface MissionTaskSetVerifierArgs {
  taskId?: string;
  /** Agent id to assign, or null to clear (humans verify by default). */
  verifierAgentId: string | null;
}

export const missionTaskSetVerifierSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['verifierAgentId'],
    properties: {
      taskId: {
        type: 'string',
        description: 'Task id; defaults to the active task in the room.',
      },
      verifierAgentId: {
        type: ['string', 'null'],
        description: 'Agent id to assign, or null to clear and let humans verify.',
      },
    },
  },
  parse(input: unknown): MissionTaskSetVerifierArgs {
    if (!isRecord(input)) throw new Error('mission.task.set_verifier args must be an object');

    if (!('verifierAgentId' in input || 'verifier_agent_id' in input || 'verifier' in input)) {
      throw new Error('verifierAgentId is required (use null to clear)');
    }
    // Don't use ?? — it would skip explicit nulls. Pick the first present
    // key in priority order regardless of value.
    let raw: unknown;
    if ('verifierAgentId' in input) raw = input.verifierAgentId;
    else if ('verifier_agent_id' in input) raw = input.verifier_agent_id;
    else raw = input.verifier;

    let verifierAgentId: string | null;
    if (raw === null) verifierAgentId = null;
    else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      verifierAgentId = trimmed === '' ? null : trimmed;
    } else {
      throw new Error('verifierAgentId must be a string or null');
    }

    const args: MissionTaskSetVerifierArgs = { verifierAgentId };
    const taskId = optionalString(input, 'taskId', 'task_id', 'id');
    if (taskId !== undefined) args.taskId = taskId;
    return args;
  },
};
