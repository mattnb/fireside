import { runPipeline } from '../../core/pipeline.js';
import { createHumanRoutingContext } from './create-human-routing-context.js';
import { makeHumanRoutingDecision } from './predicates/make-human-routing-decision.js';
import { routeActiveWorkStep } from './steps/route-active-work.js';
import { routeAmbiguousReferenceStep } from './steps/route-ambiguous-reference.js';
import { routeExplicitTargetStep } from './steps/route-explicit-target.js';
import { routeInlineYoloStep } from './steps/route-inline-yolo.js';
import { routeNoRespondersStep } from './steps/route-no-responders.js';
import { routeRoomDiscussionStep } from './steps/route-room-discussion.js';
import { routeRoomYoloStep } from './steps/route-room-yolo.js';
import type { HumanRoutingDecision, RouteHumanMessageInput } from './types.js';

export const HUMAN_MESSAGE_ROUTING_PIPELINE_STEPS = [
  routeActiveWorkStep,
  routeInlineYoloStep,
  routeExplicitTargetStep,
  routeAmbiguousReferenceStep,
  routeRoomYoloStep,
  routeRoomDiscussionStep,
  routeNoRespondersStep,
] as const;

export function runHumanMessageRoutingPipeline(
  input: RouteHumanMessageInput,
): HumanRoutingDecision {
  const context = runPipeline(
    createHumanRoutingContext(input),
    HUMAN_MESSAGE_ROUTING_PIPELINE_STEPS,
  );
  return (
    context.decision ??
    makeHumanRoutingDecision({
      action: 'append-only',
      reason: 'no-routing-decision',
      references: context.references,
      trace: context.trace,
    })
  );
}
