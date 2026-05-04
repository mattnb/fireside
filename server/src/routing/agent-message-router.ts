import type { AgentId } from '../agents/types.js';
import type { Room } from '../repos/rooms.js';
import {
  resolveRoomAgentReferences,
  type RoomAgentReferenceResult,
  type RoutingRuleTrace,
} from './agent-references.js';

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

function uniqueAgents(agents: AgentId[]): AgentId[] {
  return agents.filter((agent, index) => agents.indexOf(agent) === index);
}

export function routeAgentMessage(input: RouteAgentMessageInput): AgentMessageRoutingDecision {
  const references = resolveRoomAgentReferences(input.room, input.text);
  const trace: RoutingRuleTrace[] = [...references.trace];
  const responders = uniqueAgents(
    references.agentIds.filter(
      (agentId) =>
        agentId !== input.authorId &&
        input.room.agents.includes(agentId) &&
        (input.allowedAgents ? input.allowedAgents.has(agentId) : true),
    ),
  );

  if (responders.length > 0) {
    if (references.ambiguousAliases.length > 0) {
      trace.push({
        id: 'ambiguous-alias-tolerated',
        result: 'matched',
        reason: 'unambiguous room-local targets were kept despite unrelated ambiguous aliases',
        agents: responders,
        aliases: references.ambiguousAliases,
      });
    }
    return {
      action: 'agent-handoff',
      reason: 'agent-mentioned-room-participant',
      responders,
      references,
      trace,
    };
  }

  if (references.ambiguousAliases.length > 0) {
    trace.push({
      id: 'ambiguous-reference',
      result: 'blocked',
      reason: 'agent reference was ambiguous and produced no unambiguous handoff target',
      aliases: references.ambiguousAliases,
    });
    return {
      action: 'no-handoff',
      reason: 'ambiguous-agent-reference',
      responders: [],
      references,
      trace,
    };
  }

  return {
    action: 'no-handoff',
    reason: 'no-agent-reference',
    responders: [],
    references,
    trace,
  };
}
