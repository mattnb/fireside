import type { PipelineStep } from '../../core/pipeline.js';
import { extractMissionReceipts } from '../../../mission-receipts.js';
import type { AgentReplySignalPipelineContext } from '../types.js';

export const extractMissionReceiptsStep: PipelineStep<AgentReplySignalPipelineContext> = {
  name: 'reply.extract-mission-receipts',
  run(context) {
    const missionReceipts = extractMissionReceipts(context.visibleText);
    return {
      ...context,
      missionReceipts,
      visibleText: missionReceipts.visibleText,
      textAfterMissionReceipts: missionReceipts.visibleText,
    };
  },
};
