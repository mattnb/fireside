import type { AgentId } from '../../../../agents/types.js';
import type { Room } from '../../../../repos/rooms.js';
import type { RoomAgentReferenceResult } from '../../../../routing/agent-references.js';
import { uniqueAgents } from '../../shared/unique-agents.js';

export function handoffResponders(input: {
  room: Room;
  references: RoomAgentReferenceResult;
  authorId: AgentId;
  allowedAgents: Set<AgentId> | null;
}): AgentId[] {
  return uniqueAgents(
    input.references.agentIds.filter(
      (agentId) =>
        agentId !== input.authorId &&
        input.room.agents.includes(agentId) &&
        (input.allowedAgents ? input.allowedAgents.has(agentId) : true),
    ),
  );
}
