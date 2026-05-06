import { runPipeline } from '../core/pipeline.js';
import { createMessageSignalContext } from './create-message-signal-context.js';
import { extractAgentReferencesStep } from './extract-agent-references.js';
import { extractInlineYoloIntentStep } from './extract-inline-yolo-intent.js';
import type { MessageSignalPipelineContext, MessageSignalPipelineInput } from './types.js';

export const MESSAGE_SIGNAL_PIPELINE_STEPS = [
  extractAgentReferencesStep,
  extractInlineYoloIntentStep,
] as const;

export function runMessageSignalPipeline(
  input: MessageSignalPipelineInput,
): MessageSignalPipelineContext {
  return runPipeline(createMessageSignalContext(input), MESSAGE_SIGNAL_PIPELINE_STEPS);
}
