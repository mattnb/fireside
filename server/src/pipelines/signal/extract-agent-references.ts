import type { PipelineStep } from '../core/pipeline.js';
import { resolveRoomAgentReferences } from '../../routing/agent-references.js';
import type { MessageSignalPipelineContext } from './types.js';

export const extractAgentReferencesStep: PipelineStep<MessageSignalPipelineContext> = {
  name: 'signal.extract-agent-references',
  run(context) {
    const references = resolveRoomAgentReferences(context.room, context.text);
    return {
      ...context,
      references,
      signals: {
        ...context.signals,
        hasAgentReferences: references.agentIds.length > 0,
        hasAmbiguousAgentReferences: references.ambiguousAliases.length > 0,
      },
      trace: [...context.trace, ...references.trace],
    };
  },
};
