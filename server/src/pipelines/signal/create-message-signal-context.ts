import type { MessageSignalPipelineContext, MessageSignalPipelineInput } from './types.js';

function emptyReferenceResult(): MessageSignalPipelineContext['references'] {
  return {
    agentIds: [],
    ambiguousAliases: [],
    explicitTokens: [],
    trace: [],
  };
}

export function createMessageSignalContext(
  input: MessageSignalPipelineInput,
): MessageSignalPipelineContext {
  return {
    room: input.room,
    authorId: input.authorId,
    text: input.text,
    providedInlineYoloProfile: input.inlineYoloProfile ?? null,
    references: emptyReferenceResult(),
    inlineYoloProfile: null,
    signals: {
      hasAgentReferences: false,
      hasAmbiguousAgentReferences: false,
      hasInlineYoloIntent: false,
    },
    trace: [],
  };
}
