import type { AgentId } from '../../../../agents/types.js';
import type { Room } from '../../../../repos/rooms.js';
import type { RoomAgentReferenceResult } from '../../../../routing/agent-references.js';
import { uniqueAgents } from '../../shared/unique-agents.js';

export function referencedResponders(
  room: Room,
  references: RoomAgentReferenceResult,
  authorId: string,
): AgentId[] {
  return uniqueAgents(
    references.agentIds.filter((agent) => room.agents.includes(agent) && agent !== authorId),
  );
}
