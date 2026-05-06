import type { PipelineStep } from '../../../core/pipeline.js';
import { makeAgentRoutingDecision } from '../predicates/make-agent-routing-decision.js';
import type { AgentMessageRoutingPipelineContext } from '../types.js';

export const routeAgentAmbiguousReferenceStep: PipelineStep<AgentMessageRoutingPipelineContext> = {
  name: 'routing.agent.ambiguous-reference',
  run(context) {
    if (context.decision || context.references.ambiguousAliases.length === 0) return context;
    const trace = [
      ...context.trace,
      {
        id: 'ambiguous-reference',
        result: 'blocked' as const,
        reason: 'agent reference was ambiguous and produced no unambiguous handoff target',
        aliases: context.references.ambiguousAliases,
      },
    ];
    return {
      ...context,
      trace,
      decision: makeAgentRoutingDecision({
        action: 'no-handoff',
        reason: 'ambiguous-agent-reference',
        references: context.references,
        trace,
      }),
    };
  },
};
