import { runMessageSignalPipeline } from '../../signal/run-message-signal-pipeline.js';
import { handoffResponders } from './predicates/handoff-responders.js';
import type { AgentMessageRoutingPipelineContext, RouteAgentMessageInput } from './types.js';

export function createAgentRoutingContext(
  input: RouteAgentMessageInput,
): AgentMessageRoutingPipelineContext {
  const signalContext = runMessageSignalPipeline({
    room: input.room,
    authorId: input.authorId,
    text: input.text,
  });
  const allowedAgents = input.allowedAgents ?? null;
  return {
    ...signalContext,
    authorId: input.authorId,
    allowedAgents,
    responders: handoffResponders({
      room: input.room,
      references: signalContext.references,
      authorId: input.authorId,
      allowedAgents,
    }),
    decision: null,
  };
}
