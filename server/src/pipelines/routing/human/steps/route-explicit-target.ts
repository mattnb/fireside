import type { PipelineStep } from '../../../core/pipeline.js';
import { makeHumanRoutingDecision } from '../predicates/make-human-routing-decision.js';
import type { HumanRoutingPipelineContext } from '../types.js';

export const routeExplicitTargetStep: PipelineStep<HumanRoutingPipelineContext> = {
  name: 'routing.human.explicit-target',
  run(context) {
    if (context.decision || context.targetedResponders.length === 0) return context;
    const trace = [
      ...context.trace,
      {
        id: 'explicit-target-precedence',
        result: 'matched' as const,
        reason: 'explicit @agent/direct handoff takes precedence over room-level YOLO',
        agents: context.targetedResponders,
      },
    ];
    return {
      ...context,
      trace,
      decision: makeHumanRoutingDecision({
        action: 'direct-agent-turn',
        reason: 'explicit-human-mention',
        responders: context.targetedResponders,
        bypassRoomYolo: true,
        references: context.references,
        trace,
      }),
    };
  },
};
