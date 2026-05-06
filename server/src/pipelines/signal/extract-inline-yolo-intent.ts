import type { PipelineStep } from '../core/pipeline.js';
import { inferYoloPermissionProfileFromText } from '../../orchestration/permission-orchestrator.js';
import type { MessageSignalPipelineContext } from './types.js';

export const extractInlineYoloIntentStep: PipelineStep<MessageSignalPipelineContext> = {
  name: 'signal.extract-inline-yolo-intent',
  run(context) {
    const inlineYoloProfile =
      context.providedInlineYoloProfile ?? inferYoloPermissionProfileFromText(context.text);
    if (!inlineYoloProfile) return context;
    return {
      ...context,
      inlineYoloProfile,
      signals: {
        ...context.signals,
        hasInlineYoloIntent: true,
      },
    };
  },
};
