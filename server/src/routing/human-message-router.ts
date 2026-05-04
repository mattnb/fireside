import type { AgentId } from '../agents/types.js';
import type { YoloPermissionProfile } from '../permissions.js';
import type { Room } from '../repos/rooms.js';
import {
  resolveRoomAgentReferences,
  type RoomAgentReferenceResult,
  type RoutingRuleTrace,
} from './agent-references.js';

export type HumanRoutingAction =
  | 'direct-agent-turn'
  | 'group-discussion'
  | 'start-yolo'
  | 'queue-human-message'
  | 'append-only';

export interface HumanRoutingDecision {
  action: HumanRoutingAction;
  reason: string;
  responders: AgentId[];
  yoloResponders: AgentId[];
  bypassRoomYolo: boolean;
  references: RoomAgentReferenceResult;
  trace: RoutingRuleTrace[];
}

export interface RouteHumanMessageInput {
  room: Room;
  authorId: string;
  text: string;
  roomHasActiveWork: boolean;
  activeYolo: boolean;
  busyAgents: Set<AgentId>;
  inlineYoloProfile?: YoloPermissionProfile | undefined;
}

function uniqueAgents(agents: AgentId[]): AgentId[] {
  return agents.filter((agent, index) => agents.indexOf(agent) === index);
}

function roomResponders(room: Room, authorId: string): AgentId[] {
  return room.agents.filter((agent) => agent !== authorId);
}

function referencedResponders(
  room: Room,
  references: RoomAgentReferenceResult,
  authorId: string,
): AgentId[] {
  return uniqueAgents(
    references.agentIds.filter((agent) => room.agents.includes(agent) && agent !== authorId),
  );
}

function yoloSubset(room: Room, responders: AgentId[]): AgentId[] {
  return responders.filter((agent) => room.yoloAgents.includes(agent));
}

function decision(input: {
  action: HumanRoutingAction;
  reason: string;
  responders?: AgentId[];
  yoloResponders?: AgentId[];
  bypassRoomYolo?: boolean;
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

export function routeHumanMessage(input: RouteHumanMessageInput): HumanRoutingDecision {
  const references = resolveRoomAgentReferences(input.room, input.text);
  const trace: RoutingRuleTrace[] = [...references.trace];
  const targetedResponders = referencedResponders(input.room, references, input.authorId);
  const active = input.roomHasActiveWork || input.activeYolo;

  if (active) {
    trace.push({
      id: 'active-work',
      result: 'matched',
      reason: input.activeYolo
        ? 'room has an active YOLO discussion'
        : 'room has active provider work',
    });
    if (targetedResponders.length > 0) {
      const freeResponders = targetedResponders.filter((agent) => !input.busyAgents.has(agent));
      if (freeResponders.length > 0) {
        trace.push({
          id: 'targeted-busy-check',
          result: 'matched',
          reason: 'at least one explicitly targeted agent is free',
          agents: freeResponders,
        });
        return decision({
          action: 'direct-agent-turn',
          reason: 'explicit-human-mention-to-free-agent-while-active',
          responders: freeResponders,
          bypassRoomYolo: true,
          references,
          trace,
        });
      }
      trace.push({
        id: 'targeted-busy-check',
        result: 'blocked',
        reason: 'all explicitly targeted agents are busy',
        agents: targetedResponders,
      });
    }
    return decision({
      action: 'queue-human-message',
      reason: targetedResponders.length > 0 ? 'target-agents-busy' : 'room-active-without-free-target',
      responders: targetedResponders,
      references,
      trace,
    });
  }

  if (input.inlineYoloProfile) {
    const responders = roomResponders(input.room, input.authorId);
    trace.push({
      id: 'inline-yolo',
      result: 'matched',
      reason: 'message requested YOLO/autopilot mode explicitly',
      agents: responders,
    });
    return decision({
      action: 'start-yolo',
      reason: 'inline-yolo-request',
      responders,
      yoloResponders: yoloSubset(input.room, responders),
      references,
      trace,
    });
  }

  if (targetedResponders.length > 0) {
    trace.push({
      id: 'explicit-target-precedence',
      result: 'matched',
      reason: 'explicit @agent/direct handoff takes precedence over room-level YOLO',
      agents: targetedResponders,
    });
    return decision({
      action: 'direct-agent-turn',
      reason: 'explicit-human-mention',
      responders: targetedResponders,
      bypassRoomYolo: true,
      references,
      trace,
    });
  }

  if (references.ambiguousAliases.length > 0) {
    trace.push({
      id: 'ambiguous-reference',
      result: 'blocked',
      reason: 'agent reference was ambiguous and produced no unambiguous target',
      aliases: references.ambiguousAliases,
    });
    return decision({
      action: 'append-only',
      reason: 'ambiguous-agent-reference',
      references,
      trace,
    });
  }

  const responders = roomResponders(input.room, input.authorId);
  const yoloResponders = yoloSubset(input.room, responders);
  if (yoloResponders.length > 0) {
    trace.push({
      id: 'room-yolo',
      result: 'matched',
      reason: 'unaddressed message can be handled by room YOLO participants',
      agents: yoloResponders,
    });
    return decision({
      action: 'start-yolo',
      reason: 'room-yolo-unaddressed-message',
      responders,
      yoloResponders,
      references,
      trace,
    });
  }

  if (responders.length > 0) {
    trace.push({
      id: 'room-discussion',
      result: 'matched',
      reason: 'unaddressed message fans out to room agents',
      agents: responders,
    });
    return decision({
      action: 'group-discussion',
      reason: 'room-discussion-unaddressed-message',
      responders,
      references,
      trace,
    });
  }

  trace.push({
    id: 'no-responders',
    result: 'skipped',
    reason: 'room has no available responders',
  });
  return decision({
    action: 'append-only',
    reason: 'no-responders',
    references,
    trace,
  });
}
