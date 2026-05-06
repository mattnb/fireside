import type { AgentId } from '../../../agents/types.js';
import type { Room } from '../../../repos/rooms.js';
import type {
  RoomAgentReferenceResult,
  RoutingRuleTrace,
} from '../../../routing/agent-references.js';
import type { MessageSignalPipelineContext } from '../../signal/types.js';

export type AgentMessageRoutingAction = 'agent-handoff' | 'no-handoff';

export interface AgentMessageRoutingDecision {
  action: AgentMessageRoutingAction;
  reason: string;
  responders: AgentId[];
  references: RoomAgentReferenceResult;
  trace: RoutingRuleTrace[];
}

export interface RouteAgentMessageInput {
  room: Room;
  authorId: AgentId;
  text: string;
  allowedAgents?: Set<AgentId> | undefined;
}

export interface AgentMessageRoutingPipelineContext extends MessageSignalPipelineContext {
  authorId: AgentId;
  allowedAgents: Set<AgentId> | null;
  responders: AgentId[];
  decision: AgentMessageRoutingDecision | null;
}
