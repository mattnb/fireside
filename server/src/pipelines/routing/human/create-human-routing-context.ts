import { runMessageSignalPipeline } from '../../signal/run-message-signal-pipeline.js';
import { referencedResponders } from './predicates/referenced-responders.js';
import { roomResponders } from './predicates/room-responders.js';
import type { HumanRoutingPipelineContext, RouteHumanMessageInput } from './types.js';

export function createHumanRoutingContext(
  input: RouteHumanMessageInput,
): HumanRoutingPipelineContext {
  const signalContext = runMessageSignalPipeline({
    room: input.room,
    authorId: input.authorId,
    text: input.text,
    ...(input.inlineYoloProfile !== undefined
      ? { inlineYoloProfile: input.inlineYoloProfile }
      : {}),
  });
  return {
    ...signalContext,
    roomHasActiveWork: input.roomHasActiveWork,
    activeYolo: input.activeYolo,
    busyAgents: input.busyAgents,
    targetedResponders: referencedResponders(input.room, signalContext.references, input.authorId),
    roomResponders: roomResponders(input.room, input.authorId),
    decision: null,
  };
}
