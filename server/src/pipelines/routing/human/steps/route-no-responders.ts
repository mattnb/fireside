import type { PipelineStep } from '../../../core/pipeline.js';
import { makeHumanRoutingDecision } from '../predicates/make-human-routing-decision.js';
import type { HumanRoutingPipelineContext } from '../types.js';

export const routeNoRespondersStep: PipelineStep<HumanRoutingPipelineContext> = {
  name: 'routing.human.no-responders',
  run(context) {
    if (context.decision) return context;
    const trace = [
      ...context.trace,
      {
        id: 'no-responders',
        result: 'skipped' as const,
        reason: 'room has no available responders',
      },
    ];
    return {
      ...context,
      trace,
      decision: makeHumanRoutingDecision({
        action: 'append-only',
        reason: 'no-responders',
        references: context.references,
        trace,
      }),
    };
  },
};
