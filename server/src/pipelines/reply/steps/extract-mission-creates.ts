import type { PipelineStep } from '../../core/pipeline.js';
import { extractMissionCreateUpdates } from '../../../mission-create-updates.js';
import type { AgentReplySignalPipelineContext } from '../types.js';

export const extractMissionCreatesStep: PipelineStep<AgentReplySignalPipelineContext> = {
  name: 'reply.extract-mission-creates',
  run(context) {
    const missionCreates = extractMissionCreateUpdates(context.visibleText);
    return {
      ...context,
      missionCreates,
      visibleText: missionCreates.visibleText,
    };
  },
};
