import type { PipelineStep } from '../../../core/pipeline.js';
import { makeHumanRoutingDecision } from '../predicates/make-human-routing-decision.js';
import type { HumanRoutingPipelineContext } from '../types.js';

export const routeAmbiguousReferenceStep: PipelineStep<HumanRoutingPipelineContext> = {
  name: 'routing.human.ambiguous-reference',
  run(context) {
    if (context.decision || context.references.ambiguousAliases.length === 0) return context;
    const trace = [
      ...context.trace,
      {
        id: 'ambiguous-reference',
        result: 'blocked' as const,
        reason: 'agent reference was ambiguous and produced no unambiguous target',
        aliases: context.references.ambiguousAliases,
      },
    ];
    return {
      ...context,
      trace,
      decision: makeHumanRoutingDecision({
        action: 'append-only',
        reason: 'ambiguous-agent-reference',
        references: context.references,
        trace,
      }),
    };
  },
};
