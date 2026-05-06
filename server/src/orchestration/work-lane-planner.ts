import type { AgentId } from '../agents/types.js';
import type { TaskChecklistItem } from '../repos/task-checklist.js';

export interface WorkLaneAssignment {
  item: TaskChecklistItem;
}

export interface WorkLaneScopeContract {
  itemId: string;
  title: string;
  agentId: AgentId | '';
  expectedTouches: string[];
  parallelism: TaskChecklistItem['parallelism'];
  conflictGroup: string;
  workRole: string;
  source: 'checklist' | 'active-job';
}

export type TaskParallelismCellStatus =
  | 'can-run-together'
  | 'blocked-by-dependency'
  | 'same-conflict-group'
  | 'expected-touch-overlap'
  | 'exclusive-lane'
  | 'not-ready';

export interface TaskParallelismCell {
  leftId: string;
  rightId: string;
  status: TaskParallelismCellStatus;
  reason: string;
}

export interface TaskParallelismBatchItem {
  itemId: string;
  title: string;
  ownerAgentId: string;
  reason: string;
}

export interface TaskParallelismSummary {
  phaseId: string | null;
  phaseTitle: string;
  candidateCount: number;
  readyCount: number;
  nextBatch: TaskParallelismBatchItem[];
  cells: TaskParallelismCell[];
}

export interface PlanWorkLanesInput {
  agents: AgentId[];
  items: TaskChecklistItem[];
  activeItemIds: Set<string>;
  activeContracts: WorkLaneScopeContract[];
  busyAgents: Set<AgentId>;
  suppressedItemIdsByAgent?: Map<AgentId, Set<string>>;
}

export interface WorkLaneOwnerUpdate {
  agentId: AgentId;
  item: TaskChecklistItem;
}

export interface PlanWorkLanesResult {
  assignments: Map<AgentId, WorkLaneAssignment>;
  ownerUpdates: WorkLaneOwnerUpdate[];
}

export function checklistDependenciesSatisfied(
  item: TaskChecklistItem,
  byId: Map<string, TaskChecklistItem>,
): boolean {
  return item.dependencyIds.every((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return dependency?.status === 'done' || dependency?.status === 'skipped';
  });
}

export function workLaneScopeContract(
  item: TaskChecklistItem,
  agentId: AgentId | '' = '',
  source: WorkLaneScopeContract['source'] = 'checklist',
): WorkLaneScopeContract {
  return {
    itemId: item.id,
    title: item.title,
    agentId,
    expectedTouches: item.expectedTouches,
    parallelism: item.parallelism,
    conflictGroup: item.conflictGroup.trim().toLowerCase(),
    workRole: item.workRole,
    source,
  };
}

function normalizeTouchScope(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^["']|["']$/g, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function touchScopeRoot(value: string): string {
  const normalized = normalizeTouchScope(value);
  const globIndex = normalized.search(/[*{[]/);
  const base = globIndex >= 0 ? normalized.slice(0, globIndex) : normalized;
  return base.replace(/\/[^/]*$/, '').replace(/\/$/, '') || normalized;
}

function touchScopeHasGlob(value: string): boolean {
  return /[*{[]/.test(value);
}

export function touchScopesOverlap(a: string, b: string): boolean {
  const left = normalizeTouchScope(a);
  const right = normalizeTouchScope(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (!touchScopeHasGlob(left) && !touchScopeHasGlob(right)) {
    return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  }
  const leftRoot = touchScopeRoot(left);
  const rightRoot = touchScopeRoot(right);
  if (!leftRoot || !rightRoot) return false;
  return (
    leftRoot === rightRoot ||
    leftRoot.startsWith(`${rightRoot}/`) ||
    rightRoot.startsWith(`${leftRoot}/`)
  );
}

export function workLaneConflictReason(
  candidate: TaskChecklistItem,
  activeContracts: WorkLaneScopeContract[],
): string {
  const candidateContract = workLaneScopeContract(candidate);
  for (const active of activeContracts) {
    if (active.itemId === candidate.id) {
      return `item already assigned to ${active.agentId || 'another active job'}`;
    }
    if (
      candidateContract.conflictGroup &&
      active.conflictGroup &&
      candidateContract.conflictGroup === active.conflictGroup
    ) {
      return `conflict group ${candidateContract.conflictGroup} is active`;
    }
    const touchesOverlap = candidateContract.expectedTouches.some((left) =>
      active.expectedTouches.some((right) => touchScopesOverlap(left, right)),
    );
    if (touchesOverlap) {
      return `expected touch scope overlaps with ${active.title}`;
    }
    const exclusiveWithoutScope =
      candidateContract.parallelism === 'exclusive' &&
      candidateContract.expectedTouches.length === 0 &&
      !candidateContract.conflictGroup;
    const activeExclusiveWithoutScope =
      active.parallelism === 'exclusive' &&
      active.expectedTouches.length === 0 &&
      !active.conflictGroup;
    if (exclusiveWithoutScope || activeExclusiveWithoutScope) {
      return 'exclusive work is active';
    }
  }
  return '';
}

function classifyDependencyStatus(
  left: TaskChecklistItem,
  right: TaskChecklistItem,
  itemsById: Map<string, TaskChecklistItem>,
): TaskParallelismCell | null {
  if (left.dependencyIds.includes(right.id)) {
    return {
      leftId: left.id,
      rightId: right.id,
      status: 'blocked-by-dependency',
      reason: `${left.title} depends on ${right.title}`,
    };
  }
  if (right.dependencyIds.includes(left.id)) {
    return {
      leftId: left.id,
      rightId: right.id,
      status: 'blocked-by-dependency',
      reason: `${right.title} depends on ${left.title}`,
    };
  }
  const leftReady = checklistDependenciesSatisfied(left, itemsById);
  const rightReady = checklistDependenciesSatisfied(right, itemsById);
  if (!leftReady || !rightReady) {
    return {
      leftId: left.id,
      rightId: right.id,
      status: 'not-ready',
      reason: `${!leftReady ? left.title : right.title} has unfinished dependencies`,
    };
  }
  return null;
}

export function classifyParallelismPair(
  left: TaskChecklistItem,
  right: TaskChecklistItem,
  itemsById: Map<string, TaskChecklistItem>,
): TaskParallelismCell {
  const dependencyStatus = classifyDependencyStatus(left, right, itemsById);
  if (dependencyStatus) return dependencyStatus;
  if (left.parallelism === 'exclusive' || right.parallelism === 'exclusive') {
    return {
      leftId: left.id,
      rightId: right.id,
      status: 'exclusive-lane',
      reason: 'at least one item is marked exclusive',
    };
  }
  const leftGroup = left.conflictGroup.trim().toLowerCase();
  const rightGroup = right.conflictGroup.trim().toLowerCase();
  if (leftGroup && rightGroup && leftGroup === rightGroup) {
    return {
      leftId: left.id,
      rightId: right.id,
      status: 'same-conflict-group',
      reason: `both items use conflict group ${left.conflictGroup}`,
    };
  }
  const overlappingTouch = left.expectedTouches.find((leftTouch) =>
    right.expectedTouches.some((rightTouch) => touchScopesOverlap(leftTouch, rightTouch)),
  );
  if (overlappingTouch) {
    return {
      leftId: left.id,
      rightId: right.id,
      status: 'expected-touch-overlap',
      reason: `expected touch scope overlaps around ${overlappingTouch}`,
    };
  }
  return {
    leftId: left.id,
    rightId: right.id,
    status: 'can-run-together',
    reason: 'no dependency, conflict group, exclusivity, or expected touch overlap detected',
  };
}

function parallelismBatchReason(item: TaskChecklistItem): string {
  const pieces = [
    item.ownerAgentId ? `owner ${item.ownerAgentId}` : 'unowned',
    item.conflictGroup ? `group ${item.conflictGroup}` : 'no conflict group',
    item.expectedTouches.length
      ? `${item.expectedTouches.length} expected touch${item.expectedTouches.length === 1 ? '' : 'es'}`
      : 'no expected touches',
  ];
  return pieces.join(' / ');
}

export function buildTaskParallelismSummary(input: {
  phaseId: string | null;
  phaseTitle: string;
  agentCount: number;
  checklistItems: TaskChecklistItem[];
}): TaskParallelismSummary {
  const itemsById = new Map(input.checklistItems.map((item) => [item.id, item]));
  const phaseScopedItems = input.checklistItems.filter((item) =>
    input.phaseId ? item.phaseId === input.phaseId : true,
  );
  const candidates = phaseScopedItems.filter((item) => item.status === 'open');
  const readyItems = candidates.filter((item) => checklistDependenciesSatisfied(item, itemsById));
  const cells: TaskParallelismCell[] = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      cells.push(classifyParallelismPair(candidates[leftIndex]!, candidates[rightIndex]!, itemsById));
    }
  }

  const nextBatch: TaskParallelismBatchItem[] = [];
  const maxBatchSize = Math.max(1, input.agentCount || 1);
  const sortedReady = [...readyItems].sort(
    (a, b) =>
      b.dependencyIds.length - a.dependencyIds.length ||
      a.sortOrder - b.sortOrder ||
      a.createdAt - b.createdAt,
  );
  for (const item of sortedReady) {
    if (nextBatch.length >= maxBatchSize) break;
    const compatible = nextBatch.every((existing) => {
      const selected = itemsById.get(existing.itemId);
      return selected && classifyParallelismPair(selected, item, itemsById).status === 'can-run-together';
    });
    if (!compatible) continue;
    nextBatch.push({
      itemId: item.id,
      title: item.title,
      ownerAgentId: item.ownerAgentId,
      reason: parallelismBatchReason(item),
    });
  }

  return {
    phaseId: input.phaseId,
    phaseTitle: input.phaseTitle,
    candidateCount: candidates.length,
    readyCount: readyItems.length,
    nextBatch,
    cells,
  };
}

export function planWorkLanes(input: PlanWorkLanesInput): PlanWorkLanesResult {
  const uniqueAgents = input.agents.filter((agent, index) => input.agents.indexOf(agent) === index);
  const assignments = new Map<AgentId, WorkLaneAssignment>();
  const ownerUpdates: WorkLaneOwnerUpdate[] = [];
  if (uniqueAgents.length === 0) return { assignments, ownerUpdates };

  const reservedContracts = [...input.activeContracts];
  const assignableAgents = uniqueAgents.filter((agentId) => !input.busyAgents.has(agentId));
  const agentSet = new Set<AgentId>(assignableAgents);
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const eligibleItems = input.items.filter(
    (item) =>
      item.status === 'open' &&
      !input.activeItemIds.has(item.id) &&
      checklistDependenciesSatisfied(item, byId) &&
      (!item.ownerAgentId || agentSet.has(item.ownerAgentId as AgentId)),
  );
  const assignedItemIds = new Set<string>();
  const suppressedForAgent = (agentId: AgentId, itemId: string): boolean =>
    input.suppressedItemIdsByAgent?.get(agentId)?.has(itemId) === true;

  for (const agentId of assignableAgents) {
    const owned = eligibleItems.find(
      (item) =>
        item.ownerAgentId === agentId &&
        !suppressedForAgent(agentId, item.id) &&
        !assignedItemIds.has(item.id) &&
        !workLaneConflictReason(item, reservedContracts),
    );
    if (!owned) continue;
    assignments.set(agentId, { item: owned });
    assignedItemIds.add(owned.id);
    reservedContracts.push(workLaneScopeContract(owned, agentId));
  }

  const unownedItems = eligibleItems.filter((item) => !item.ownerAgentId);
  const availableAgents = assignableAgents.filter((agentId) => !assignments.has(agentId));
  for (const agentId of availableAgents) {
    const itemIndex = unownedItems.findIndex(
      (candidate) =>
        !suppressedForAgent(agentId, candidate.id) &&
        !assignedItemIds.has(candidate.id) &&
        !workLaneConflictReason(candidate, reservedContracts),
    );
    const item = itemIndex >= 0 ? unownedItems.splice(itemIndex, 1)[0] : undefined;
    if (!item) break;
    assignments.set(agentId, { item });
    ownerUpdates.push({ agentId, item });
    assignedItemIds.add(item.id);
    reservedContracts.push(workLaneScopeContract(item, agentId));
  }

  return { assignments, ownerUpdates };
}
