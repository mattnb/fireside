import type { PipelineStep } from '../../core/pipeline.js';
import { extractMissionPhaseUpdates } from '../../../mission-phase-updates.js';
import type { AgentReplySignalPipelineContext } from '../types.js';

export const extractMissionPhasesStep: PipelineStep<AgentReplySignalPipelineContext> = {
  name: 'reply.extract-mission-phases',
  run(context) {
    const missionPhases = extractMissionPhaseUpdates(context.visibleText);
    return {
      ...context,
      missionPhases,
      visibleText: missionPhases.visibleText,
    };
  },
};
