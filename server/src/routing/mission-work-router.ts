import type { AgentId } from '../agents/types.js';
import type { TaskChecklistItem } from '../repos/task-checklist.js';
import type { RoutingRuleTrace } from './agent-references.js';

export interface MissionWorkDispatch {
  agentId: AgentId;
  item: TaskChecklistItem;
  reason: string;
}

export interface MissionWorkRoutingDecision {
  dispatches: MissionWorkDispatch[];
  trace: RoutingRuleTrace[];
}

export interface RouteMissionWorkUpdatesInput {
  changedItems: TaskChecklistItem[];
  allItems: TaskChecklistItem[];
  roomAgents: AgentId[];
  authorId: AgentId;
  busyAgents: Set<AgentId>;
  activeItemIds: Set<string>;
}

function dependenciesSatisfied(
  item: TaskChecklistItem,
  itemsById: Map<string, TaskChecklistItem>,
): boolean {
  return item.dependencyIds.every((dependencyId) => {
    const dependency = itemsById.get(dependencyId);
    return dependency?.status === 'done' || dependency?.status === 'skipped';
  });
}

export function routeMissionWorkUpdates(
  input: RouteMissionWorkUpdatesInput,
): MissionWorkRoutingDecision {
  const trace: RoutingRuleTrace[] = [];
  const dispatches: MissionWorkDispatch[] = [];
  const roomAgents = new Set(input.roomAgents);
  const itemsById = new Map(input.allItems.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const dispatchedAgents = new Set<AgentId>();

  for (const changed of input.changedItems) {
    const item = itemsById.get(changed.id) ?? changed;
    const owner = item.ownerAgentId as AgentId;
    if (!owner) {
      trace.push({
        id: 'mission-work-owner',
        result: 'skipped',
        reason: `${item.title} has no assigned owner`,
      });
      continue;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (item.status !== 'open') {
      trace.push({
        id: 'mission-work-status',
        result: 'skipped',
        reason: `${item.title} is ${item.status}, not open`,
        agents: [owner],
      });
      continue;
    }
    if (!roomAgents.has(owner)) {
      trace.push({
        id: 'mission-work-room-member',
        result: 'blocked',
        reason: `${owner} is not in the room`,
        agents: [owner],
      });
      continue;
    }
    if (owner === input.authorId) {
      trace.push({
        id: 'mission-work-self',
        result: 'skipped',
        reason: `${owner} created or updated their own assigned work`,
        agents: [owner],
      });
      continue;
    }
    if (input.busyAgents.has(owner)) {
      trace.push({
        id: 'mission-work-busy',
        result: 'blocked',
        reason: `${owner} is already busy`,
        agents: [owner],
      });
      continue;
    }
    if (input.activeItemIds.has(item.id)) {
      trace.push({
        id: 'mission-work-active-item',
        result: 'blocked',
        reason: `${item.title} is already attached to active work`,
        agents: [owner],
      });
      continue;
    }
    if (dispatchedAgents.has(owner)) {
      trace.push({
        id: 'mission-work-agent-dedupe',
        result: 'skipped',
        reason: `${owner} already has a mission work dispatch in this routing pass`,
        agents: [owner],
      });
      continue;
    }
    if (!dependenciesSatisfied(item, itemsById)) {
      trace.push({
        id: 'mission-work-dependencies',
        result: 'blocked',
        reason: `${item.title} has unfinished dependencies`,
        agents: [owner],
      });
      continue;
    }
    dispatches.push({
      agentId: owner,
      item,
      reason: `assigned open checklist item ${item.id}`,
    });
    dispatchedAgents.add(owner);
    trace.push({
      id: 'mission-work-dispatch',
      result: 'matched',
      reason: `${owner} owns newly available checklist work`,
      agents: [owner],
    });
  }

  if (dispatches.length === 0 && trace.length === 0) {
    trace.push({
      id: 'mission-work-dispatch',
      result: 'skipped',
      reason: 'no changed checklist items to dispatch',
    });
  }

  return { dispatches, trace };
}
