import type { AgentId } from '../../../../agents/types.js';
import type {
  RoomAgentReferenceResult,
  RoutingRuleTrace,
} from '../../../../routing/agent-references.js';
import type { HumanRoutingAction, HumanRoutingDecision } from '../types.js';

export function makeHumanRoutingDecision(input: {
  action: HumanRoutingAction;
  reason: string;
  responders?: AgentId[] | undefined;
  yoloResponders?: AgentId[] | undefined;
  bypassRoomYolo?: boolean | undefined;
  references: RoomAgentReferenceResult;
  trace: RoutingRuleTrace[];
}): HumanRoutingDecision {
  return {
    action: input.action,
    reason: input.reason,
    responders: input.responders ?? [],
    yoloResponders: input.yoloResponders ?? [],
    bypassRoomYolo: input.bypassRoomYolo ?? false,
    references: input.references,
    trace: input.trace,
  };
}
