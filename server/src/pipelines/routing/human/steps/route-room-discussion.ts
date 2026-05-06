import type { PipelineStep } from '../../../core/pipeline.js';
import { makeHumanRoutingDecision } from '../predicates/make-human-routing-decision.js';
import type { HumanRoutingPipelineContext } from '../types.js';

export const routeRoomDiscussionStep: PipelineStep<HumanRoutingPipelineContext> = {
  name: 'routing.human.room-discussion',
  run(context) {
    if (context.decision || context.roomResponders.length === 0) return context;
    const trace = [
      ...context.trace,
      {
        id: 'room-discussion',
        result: 'matched' as const,
        reason: 'unaddressed message fans out to room agents',
        agents: context.roomResponders,
      },
    ];
    return {
      ...context,
      trace,
      decision: makeHumanRoutingDecision({
        action: 'group-discussion',
        reason: 'room-discussion-unaddressed-message',
        responders: context.roomResponders,
        references: context.references,
        trace,
      }),
    };
  },
};
