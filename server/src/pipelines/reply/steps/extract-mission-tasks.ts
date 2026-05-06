import type { PipelineStep } from '../../core/pipeline.js';
import { extractMissionTaskUpdates } from '../../../mission-task-updates.js';
import type { AgentReplySignalPipelineContext } from '../types.js';

export const extractMissionTasksStep: PipelineStep<AgentReplySignalPipelineContext> = {
  name: 'reply.extract-mission-tasks',
  run(context) {
    const missionTasks = extractMissionTaskUpdates(context.visibleText);
    return {
      ...context,
      missionTasks,
      visibleText: missionTasks.visibleText,
    };
  },
};
