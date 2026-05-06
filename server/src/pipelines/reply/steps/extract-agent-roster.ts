import type { PipelineStep } from '../../core/pipeline.js';
import { extractAgentRosterUpdates } from '../../../agent-roster-updates.js';
import type { AgentReplySignalPipelineContext } from '../types.js';

export const extractAgentRosterStep: PipelineStep<AgentReplySignalPipelineContext> = {
  name: 'reply.extract-agent-roster',
  run(context) {
    const agentRoster = extractAgentRosterUpdates(context.visibleText);
    return {
      ...context,
      agentRoster,
      visibleText: agentRoster.visibleText,
    };
  },
};
