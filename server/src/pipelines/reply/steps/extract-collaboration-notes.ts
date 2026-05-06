import type { PipelineStep } from '../../core/pipeline.js';
import { extractCollaborationNotes } from '../../../collaboration-notes.js';
import type { AgentReplySignalPipelineContext } from '../types.js';

export const extractCollaborationNotesStep: PipelineStep<AgentReplySignalPipelineContext> = {
  name: 'reply.extract-collaboration-notes',
  run(context) {
    const collaboration = extractCollaborationNotes(context.visibleText);
    return {
      ...context,
      collaboration,
      visibleText: collaboration.visibleText,
    };
  },
};
