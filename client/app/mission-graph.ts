// client/app/mission-graph.ts
// Pure builder for the mission graph: takes the loaded TaskControl + AgentRuns
// and produces lanes, cards, summary stats, and board swimlanes. The board,
// roadmap, and checklist views all consume the same lane/card data.
//
// All functions here are pure: no signal reads, no DI. Inputs are passed in.
// The App component (or, in the future, MissionStore) is responsible for
// wiring this up to live data via computeds.

import type {
  AgentRun,
  AgentRunAction,
  TaskChecklistItem,
  TaskChecklistNote,
  TaskControl,
  TaskPhase,
  TaskPhaseStatus,
} from './api.types';
import {
  activityTaskTitle,
  normalizeMissionGraphTitle,
  parseActivityDetail,
} from './run-detail';

export type OpsTone = 'good' | 'warn' | 'danger' | 'info' | 'muted';

export type MissionGraphTone =
  | 'active'
  | 'ready'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'open'
  | 'skipped';

export type MissionGraphDependency = {
  id: string;
  title: string;
  status: TaskChecklistItem['status'];
  done: boolean;
};

export type MissionGraphCard = {
  item: TaskChecklistItem;
  tone: MissionGraphTone;
  ready: boolean;
  waiting: boolean;
  dependencies: MissionGraphDependency[];
  dependents: MissionGraphDependency[];
  notesCount: number;
  evidenceCount: number;
  linkedRuns: AgentRun[];
  activeRun: AgentRun | null;
  latestRun: AgentRun | null;
  latestNote: TaskChecklistNote | null;
};

export type MissionGraphLane = {
  id: string;
  phase: TaskPhase | null;
  title: string;
  status: TaskPhaseStatus | 'backlog';
  gate: string;
  planLabel: string;
  cards: MissionGraphCard[];
  counts: {
    total: number;
    done: number;
    open: number;
    blocked: number;
    ready: number;
  };
  tone: OpsTone;
};

export type MissionGraphSummary = {
  phasesDone: number;
  phasesTotal: number;
  itemsDone: number;
  itemsTotal: number;
  ready: number;
  blocked: number;
  activeRuns: number;
  evidence: number;
  artifacts: number;
  collaboration: number;
};

export type MissionBoardColumnId = 'ready' | 'active' | 'blocked' | 'review' | 'done';

export type MissionBoardSwimlane = {
  id: string;
  title: string;
  status: TaskPhaseStatus | 'backlog';
  gate: string;
  planLabel: string;
  cardsByColumn: Record<MissionBoardColumnId, MissionGraphCard[]>;
  totalCards: number;
};

export interface BuildMissionGraphInput {
  taskControl: TaskControl | null;
  runs: AgentRun[];
  runActions: AgentRunAction[];
  planLabel: (planId: string | null | undefined) => string;
}

export function buildMissionGraphLanes(input: BuildMissionGraphInput): MissionGraphLane[] {
  const control = input.taskControl;
  if (!control) return [];

  const items = control.checklistItems;
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const notesByItemId = new Map<string, TaskChecklistNote[]>();
  for (const note of control.checklistNotes) {
    const notes = notesByItemId.get(note.itemId) ?? [];
    notes.push(note);
    notesByItemId.set(note.itemId, notes);
  }
  for (const notes of notesByItemId.values()) notes.sort((a, b) => a.createdAt - b.createdAt);

  const dependentsByItemId = new Map<string, TaskChecklistItem[]>();
  for (const item of items) {
    for (const dependencyId of item.dependencyIds) {
      const dependents = dependentsByItemId.get(dependencyId) ?? [];
      dependents.push(item);
      dependentsByItemId.set(dependencyId, dependents);
    }
  }

  const runsByItemId = buildChecklistRunMap(items, input.runs, input.runActions);
  const phaseIds = new Set(control.phases.map((phase) => phase.id));
  const cardFor = (item: TaskChecklistItem): MissionGraphCard =>
    buildMissionGraphCard(item, {
      itemsById,
      notesByItemId,
      dependentsByItemId,
      runsByItemId,
    });

  const lanes: MissionGraphLane[] = control.phases.map((phase) => {
    const cards = items
      .filter((item) => item.phaseId === phase.id)
      .map(cardFor)
      .sort((a, b) => a.item.sortOrder - b.item.sortOrder || a.item.createdAt - b.item.createdAt);
    return buildMissionGraphLane({
      id: phase.id,
      phase,
      title: phase.title,
      status: phase.status,
      gate: phase.gate || phase.description,
      planLabel: input.planLabel(phase.planId),
      cards,
    });
  });

  const backlogCards = items
    .filter((item) => !item.phaseId || !phaseIds.has(item.phaseId))
    .map(cardFor)
    .sort((a, b) => a.item.sortOrder - b.item.sortOrder || a.item.createdAt - b.item.createdAt);
  if (backlogCards.length > 0 || lanes.length === 0) {
    lanes.push(
      buildMissionGraphLane({
        id: 'backlog',
        phase: null,
        title: lanes.length === 0 ? 'Mission Backlog' : 'Unphased Work',
        status: 'backlog',
        gate:
          lanes.length === 0
            ? 'Checklist work without phase gates yet.'
            : 'Items not tied to a phase gate.',
        planLabel: control.activePlan?.title ?? '',
        cards: backlogCards,
      }),
    );
  }

  return lanes;
}

interface CardContext {
  itemsById: Map<string, TaskChecklistItem>;
  notesByItemId: Map<string, TaskChecklistNote[]>;
  dependentsByItemId: Map<string, TaskChecklistItem[]>;
  runsByItemId: Map<string, AgentRun[]>;
}

function buildMissionGraphCard(item: TaskChecklistItem, context: CardContext): MissionGraphCard {
  const dependencies = item.dependencyIds
    .map((id) => context.itemsById.get(id))
    .filter((dependency): dependency is TaskChecklistItem => Boolean(dependency))
    .map((dependency) => missionGraphDependency(dependency));
  const dependents = (context.dependentsByItemId.get(item.id) ?? []).map((dependent) =>
    missionGraphDependency(dependent),
  );
  const notes = context.notesByItemId.get(item.id) ?? [];
  const linkedRuns = [...(context.runsByItemId.get(item.id) ?? [])].sort(
    (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0),
  );
  const activeRun = linkedRuns.find((run) => run.status === 'running') ?? null;
  const latestRun = linkedRuns[0] ?? null;
  const waiting = dependencies.some((dependency) => !dependency.done);
  const ready = item.status === 'open' && !waiting && !activeRun;
  const evidenceCount =
    notes.filter((note) => note.kind === 'completion').length +
    linkedRuns.filter((run) => run.status === 'completed' || run.status === 'empty').length;
  const tone: MissionGraphTone = activeRun
    ? 'active'
    : item.status === 'blocked'
      ? 'blocked'
      : item.status === 'done'
        ? 'done'
        : item.status === 'skipped'
          ? 'skipped'
          : waiting
            ? 'waiting'
            : ready
              ? 'ready'
              : 'open';
  return {
    item,
    tone,
    ready,
    waiting,
    dependencies,
    dependents,
    notesCount: notes.length,
    evidenceCount,
    linkedRuns,
    activeRun,
    latestRun,
    latestNote: notes[notes.length - 1] ?? null,
  };
}

function buildMissionGraphLane(input: {
  id: string;
  phase: TaskPhase | null;
  title: string;
  status: TaskPhaseStatus | 'backlog';
  gate: string;
  planLabel: string;
  cards: MissionGraphCard[];
}): MissionGraphLane {
  const counts = {
    total: input.cards.length,
    done: input.cards.filter((card) => card.item.status === 'done').length,
    open: input.cards.filter((card) => card.item.status === 'open').length,
    blocked: input.cards.filter((card) => card.item.status === 'blocked').length,
    ready: input.cards.filter((card) => card.ready).length,
  };
  const tone: OpsTone =
    input.status === 'blocked' || counts.blocked > 0
      ? 'warn'
      : input.status === 'done'
        ? 'good'
        : input.status === 'active' || counts.ready > 0
          ? 'info'
          : 'muted';
  return {
    ...input,
    counts,
    tone,
  };
}

function missionGraphDependency(item: TaskChecklistItem): MissionGraphDependency {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    done: item.status === 'done' || item.status === 'skipped',
  };
}

function buildChecklistRunMap(
  items: TaskChecklistItem[],
  runs: AgentRun[],
  runActions: AgentRunAction[],
): Map<string, AgentRun[]> {
  const runsByItemId = new Map<string, AgentRun[]>();
  const addedRunIds = new Map<string, Set<string>>();
  const runsById = new Map(runs.map((run) => [run.id, run]));

  for (const action of runActions) {
    if (
      action.label !== 'YOLO lane assigned' &&
      !/^mission task (create|update)$/i.test(action.label)
    ) {
      continue;
    }
    const item = checklistItemForRunAction(items, action);
    const run = runsById.get(action.runId);
    if (!item || !run) continue;
    const runIds = addedRunIds.get(item.id) ?? new Set<string>();
    if (runIds.has(run.id)) continue;
    runIds.add(run.id);
    addedRunIds.set(item.id, runIds);
    const linkedRuns = runsByItemId.get(item.id) ?? [];
    linkedRuns.push(run);
    runsByItemId.set(item.id, linkedRuns);
  }

  return runsByItemId;
}

function checklistItemForRunAction(
  items: TaskChecklistItem[],
  action: AgentRunAction,
): TaskChecklistItem | null {
  const detail = action.detail || '';
  const idMatch = /\[id=([^\]]+)\]/i.exec(detail);
  if (idMatch?.[1]) {
    const byId = items.find((item) => item.id === idMatch[1]);
    if (byId) return byId;
  }

  const parsed = parseActivityDetail(detail);
  const candidateTitle =
    parsed?.title || activityTaskTitle(detail) || detail.replace(/\s+\([^()]+\)$/i, '');
  const normalized = normalizeMissionGraphTitle(candidateTitle);
  if (!normalized) return null;
  return (
    items.find((item) => normalizeMissionGraphTitle(item.title) === normalized) ??
    items.find((item) => {
      const title = normalizeMissionGraphTitle(item.title);
      return title.length > 0 && (normalized.startsWith(title) || title.startsWith(normalized));
    }) ??
    null
  );
}

export interface BuildMissionGraphSummaryInput {
  taskControl: TaskControl | null;
  lanes: MissionGraphLane[];
  artifactsCount: number;
  collaborationCount: number;
}

export function buildMissionGraphSummary(input: BuildMissionGraphSummaryInput): MissionGraphSummary {
  const cards = input.lanes.flatMap((lane) => lane.cards);
  return {
    phasesDone: input.taskControl?.phases.filter((phase) => phase.status === 'done').length ?? 0,
    phasesTotal: input.taskControl?.phases.length ?? 0,
    itemsDone: cards.filter((card) => card.item.status === 'done').length,
    itemsTotal: cards.length,
    ready: cards.filter((card) => card.ready).length,
    blocked: cards.filter((card) => card.item.status === 'blocked').length,
    activeRuns: cards.filter((card) => card.activeRun).length,
    evidence: cards.reduce((total, card) => total + card.evidenceCount, 0),
    artifacts: input.artifactsCount,
    collaboration: input.collaborationCount,
  };
}

export function emptyMissionBoardColumns(): Record<MissionBoardColumnId, MissionGraphCard[]> {
  return {
    ready: [],
    active: [],
    blocked: [],
    review: [],
    done: [],
  };
}

export function missionBoardColumnForCard(card: MissionGraphCard): MissionBoardColumnId {
  if (card.item.status === 'done' || card.item.status === 'skipped') return 'done';
  if (card.activeRun) return 'active';
  if (card.item.status === 'blocked' || card.waiting) return 'blocked';
  if (
    card.latestRun &&
    card.latestRun.status !== 'running' &&
    (card.latestRun.status === 'completed' ||
      card.latestRun.status === 'empty' ||
      card.evidenceCount > 0)
  ) {
    return 'review';
  }
  return 'ready';
}

export function buildMissionBoardSwimlanes(lanes: MissionGraphLane[]): MissionBoardSwimlane[] {
  return lanes.map((lane) => {
    const cardsByColumn = emptyMissionBoardColumns();
    for (const card of lane.cards) {
      cardsByColumn[missionBoardColumnForCard(card)].push(card);
    }
    return {
      id: lane.id,
      title: lane.title,
      status: lane.status,
      gate: lane.gate,
      planLabel: lane.planLabel,
      cardsByColumn,
      totalCards: lane.cards.length,
    };
  });
}
