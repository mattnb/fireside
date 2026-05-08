import type { PipelineStep } from '../../core/pipeline.js';
import { stripFiresideToolEnvelopes } from '../../../fireside-tool-envelopes.js';
import type { AgentReplySignalPipelineContext } from '../types.js';

export const stripFiresideToolEnvelopesStep: PipelineStep<AgentReplySignalPipelineContext> = {
  name: 'reply.strip-fireside-tool-envelopes',
  run(context) {
    const stripped = stripFiresideToolEnvelopes(context.visibleText);
    if (stripped.count === 0) return context;
    return {
      ...context,
      visibleText: stripped.visibleText,
      textAfterMissionReceipts: stripped.visibleText,
    };
  },
};
