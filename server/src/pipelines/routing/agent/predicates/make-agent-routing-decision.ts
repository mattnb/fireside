import type { AgentId } from '../../../../agents/types.js';
import type {
  RoomAgentReferenceResult,
  RoutingRuleTrace,
} from '../../../../routing/agent-references.js';
import type { AgentMessageRoutingAction, AgentMessageRoutingDecision } from '../types.js';

export function makeAgentRoutingDecision(input: {
  action: AgentMessageRoutingAction;
  reason: string;
  responders?: AgentId[] | undefined;
  references: RoomAgentReferenceResult;
  trace: RoutingRuleTrace[];
}): AgentMessageRoutingDecision {
  return {
    action: input.action,
    reason: input.reason,
    responders: input.responders ?? [],
    references: input.references,
    trace: input.trace,
  };
}
