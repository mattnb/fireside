import { runPipeline } from '../../core/pipeline.js';
import { createAgentRoutingContext } from './create-agent-routing-context.js';
import { makeAgentRoutingDecision } from './predicates/make-agent-routing-decision.js';
import { routeAgentHandoffStep } from './steps/route-agent-handoff.js';
import { routeAgentAmbiguousReferenceStep } from './steps/route-ambiguous-reference.js';
import { routeNoAgentReferenceStep } from './steps/route-no-agent-reference.js';
import type { AgentMessageRoutingDecision, RouteAgentMessageInput } from './types.js';

export const AGENT_MESSAGE_ROUTING_PIPELINE_STEPS = [
  routeAgentHandoffStep,
  routeAgentAmbiguousReferenceStep,
  routeNoAgentReferenceStep,
] as const;

export function runAgentMessageRoutingPipeline(
  input: RouteAgentMessageInput,
): AgentMessageRoutingDecision {
  const context = runPipeline(
    createAgentRoutingContext(input),
    AGENT_MESSAGE_ROUTING_PIPELINE_STEPS,
  );
  return (
    context.decision ??
    makeAgentRoutingDecision({
      action: 'no-handoff',
      reason: 'no-routing-decision',
      references: context.references,
      trace: context.trace,
    })
  );
}
