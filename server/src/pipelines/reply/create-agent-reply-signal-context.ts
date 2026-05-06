import type {
  AgentReplySignalPipelineContext,
  AgentReplySignalPipelineInput,
} from './types.js';

export function createAgentReplySignalContext(
  input: AgentReplySignalPipelineInput,
): AgentReplySignalPipelineContext {
  return {
    agentId: input.agentId,
    originalText: input.text,
    visibleText: input.text,
    textAfterMissionReceipts: input.text,
    missionCreates: { visibleText: input.text, updates: [] },
    missionPlans: { visibleText: input.text, updates: [] },
    missionPhases: { visibleText: input.text, updates: [] },
    missionTasks: { visibleText: input.text, updates: [] },
    agentRoster: { visibleText: input.text, updates: [] },
    missionReceipts: { visibleText: input.text, receipts: [] },
    permission: null,
    collaboration: { visibleText: input.text, notes: [] },
  };
}
