import type { PipelineStep } from '../../../core/pipeline.js';
import { makeAgentRoutingDecision } from '../predicates/make-agent-routing-decision.js';
import type { AgentMessageRoutingPipelineContext } from '../types.js';

export const routeNoAgentReferenceStep: PipelineStep<AgentMessageRoutingPipelineContext> = {
  name: 'routing.agent.no-agent-reference',
  run(context) {
    if (context.decision) return context;
    return {
      ...context,
      decision: makeAgentRoutingDecision({
        action: 'no-handoff',
        reason: 'no-agent-reference',
        references: context.references,
        trace: context.trace,
      }),
    };
  },
};
