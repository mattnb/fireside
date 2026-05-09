import type { PipelineStep } from '../../core/pipeline.js';
import { normalizeFiresideEnvelopes } from '../../../hidden-blocks.js';
import type { AgentReplySignalPipelineContext } from '../types.js';

// Defensive normalization step: agents sometimes emit a hallucinated
// `<!--FIRESIDE:<name> v=N ... /end-<name>-->` envelope (a confused mash-up
// of the deprecated `<!-- fireside-tool -->` envelope and the canonical
// slash-block fallback). The downstream extractors all use `hiddenBlockRegex`,
// which rejects the `FIRESIDE:` prefix because it carries word chars, so
// without this step the entire envelope leaks into visible chat. Rewriting
// the envelope into the canonical slash-block form lets the existing
// mission/collab/permission extractors recognize and strip the payload.
export const normalizeFiresideEnvelopesStep: PipelineStep<AgentReplySignalPipelineContext> = {
  name: 'reply.normalize-fireside-envelopes',
  run(context) {
    const { normalizedText, count } = normalizeFiresideEnvelopes(context.visibleText);
    if (count === 0) return context;
    return {
      ...context,
      visibleText: normalizedText,
      textAfterMissionReceipts: normalizedText,
    };
  },
};
