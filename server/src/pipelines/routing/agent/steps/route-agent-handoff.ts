import type { PipelineStep } from '../../../core/pipeline.js';
import { makeAgentRoutingDecision } from '../predicates/make-agent-routing-decision.js';
import type { AgentMessageRoutingPipelineContext } from '../types.js';

export const routeAgentHandoffStep: PipelineStep<AgentMessageRoutingPipelineContext> = {
  name: 'routing.agent.agent-handoff',
  run(context) {
    if (context.decision || context.responders.length === 0) return context;
    const trace =
      context.references.ambiguousAliases.length > 0
        ? [
            ...context.trace,
            {
              id: 'ambiguous-alias-tolerated',
              result: 'matched' as const,
              reason: 'unambiguous room-local targets were kept despite unrelated ambiguous aliases',
              agents: context.responders,
              aliases: context.references.ambiguousAliases,
            },
          ]
        : context.trace;
    return {
      ...context,
      trace,
      decision: makeAgentRoutingDecision({
        action: 'agent-handoff',
        reason: 'agent-mentioned-room-participant',
        responders: context.responders,
        references: context.references,
        trace,
      }),
    };
  },
};
