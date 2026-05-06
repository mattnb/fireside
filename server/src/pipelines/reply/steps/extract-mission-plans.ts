import type { PipelineStep } from '../../core/pipeline.js';
import { extractMissionPlanUpdates } from '../../../mission-plan-updates.js';
import type { AgentReplySignalPipelineContext } from '../types.js';

export const extractMissionPlansStep: PipelineStep<AgentReplySignalPipelineContext> = {
  name: 'reply.extract-mission-plans',
  run(context) {
    const missionPlans = extractMissionPlanUpdates(context.visibleText);
    return {
      ...context,
      missionPlans,
      visibleText: missionPlans.visibleText,
    };
  },
};
