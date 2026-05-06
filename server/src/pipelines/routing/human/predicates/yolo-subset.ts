import type { AgentId } from '../../../../agents/types.js';
import type { Room } from '../../../../repos/rooms.js';

export function yoloSubset(room: Room, responders: AgentId[]): AgentId[] {
  return responders.filter((agent) => room.yoloAgents.includes(agent));
}
