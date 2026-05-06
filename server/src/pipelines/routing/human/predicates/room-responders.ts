import type { AgentId } from '../../../../agents/types.js';
import type { Room } from '../../../../repos/rooms.js';

export function roomResponders(room: Room, authorId: string): AgentId[] {
  return room.agents.filter((agent) => agent !== authorId);
}
