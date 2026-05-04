// client/app/mission-graph.service.ts
// Pure derivations off the mission-control state: graph lanes, board
// swimlanes, summary roll-ups, the chat-side activity feed, and the
// formatting helpers that render those derivations into UI strings. Reads
// source data from MissionStore + AgentDisplayService; consumers (overview-
// view, board-view, roadmap-view, plan-view, task-inspector-modal, App's
// chatTimeline) inject this service rather than receiving callbacks from
// App.
//
// Helper methods are arrow class fields so they auto-bind, which lets
// templates pass them as inputs (`[runLabel]="graph.runLabel"`) without
// the `.bind(this)` ceremony App was doing previously.

import { Injectable, computed, inject } from '@angular/core';

import { AgentDisplayService } from './agent-display.service';
import { MissionStore } from './mission-store';
import {
  buildMissionBoardSwimlanes,
  buildMissionGraphLanes,
  buildMissionGraphSummary,
  emptyMissionBoardColumns,
  missionBoardColumnForCard,
  type MissionBoardColumnId,
  type MissionBoardSwimlane,
  type MissionGraphCard,
  type MissionGraphLane,
  type MissionGraphSummary,
} from './mission-graph';
import {
  actionDetailText,
  activityTaskTitle,
  parseActivityDetail,
} from './run-detail';
import { elapsedLabel as fmtElapsedLabel, oneLine as fmtOneLine } from './formatters';
import type { AgentId, AgentRunAction } from './api.types';
import type { MissionActivityEvent } from './chat-types';

@Injectable({ providedIn: 'root' })
export class MissionGraphService {
  private readonly store = inject(MissionStore);
  private readonly display = inject(AgentDisplayService);

  // ---- Reactive derivations ---------------------------------------------

  readonly lanes = computed<MissionGraphLane[]>(() =>
    buildMissionGraphLanes({
      taskControl: this.store.taskControl(),
      runs: this.store.runs(),
      runActions: this.store.runActions(),
      planLabel: (id) => this.planLabel(id),
    }),
  );

  readonly summary = computed<MissionGraphSummary>(() =>
    buildMissionGraphSummary({
      taskControl: this.store.taskControl(),
      lanes: this.lanes(),
      artifactsCount: this.store.artifacts()?.files.length ?? 0,
      collaborationCount: this.store.collaboration().length,
    }),
  );

  readonly swimlanes = computed<MissionBoardSwimlane[]>(() =>
    buildMissionBoardSwimlanes(this.lanes()),
  );

  readonly activity = computed<MissionActivityEvent[]>(() => this.buildActivity());

  // ---- Lookups ----------------------------------------------------------

  emptyBoardColumns(): Record<MissionBoardColumnId, MissionGraphCard[]> {
    return emptyMissionBoardColumns();
  }

  boardColumnForCard(card: MissionGraphCard): MissionBoardColumnId {
    return missionBoardColumnForCard(card);
  }

  findCard(itemId: string | null): MissionGraphCard | null {
    if (!itemId) return null;
    for (const lane of this.lanes()) {
      const card = lane.cards.find((candidate) => candidate.item.id === itemId);
      if (card) return card;
    }
    return null;
  }

  planLabel(planId: string | null | undefined): string {
    if (!planId) return '';
    const plan = this.store.taskControl()?.plans.find((candidate) => candidate.id === planId);
    return plan?.title ?? planId;
  }

  // ---- Formatting helpers (arrow fields → auto-bound for templates) -----

  readonly laneClass = (lane: MissionGraphLane): string => `is-${lane.tone}`;

  readonly runLabel = (card: MissionGraphCard): string => {
    const run = card.activeRun ?? card.latestRun;
    if (!run) return '';
    const prefix = run.status === 'running' ? 'running' : run.status;
    const duration = fmtElapsedLabel(run.startedAt, run.completedAt, Date.now());
    return `${prefix} / ${this.actorLabel(run.agentId)} / ${duration}`;
  };

  readonly notePreview = (card: MissionGraphCard): string => {
    const note = card.latestNote;
    if (!note) return '';
    return `${this.actorLabel(note.authorId)} / ${note.kind}: ${fmtOneLine(note.body, 160)}`;
  };

  readonly taskInspectorReference = (card: MissionGraphCard): string => {
    const item = card.item;
    const detail = item.detail ? ` - ${item.detail}` : '';
    return `Checklist item ${item.id}: ${item.title}${detail}`;
  };

  readonly taskInspectorMissionBlock = (card: MissionGraphCard): string => {
    return [
      '/mission-task',
      'action: update',
      `id: ${card.item.id}`,
      `status: ${card.item.status}`,
      (card.item.expectedTouches ?? []).length
        ? `expected_touches: ${card.item.expectedTouches.join(', ')}`
        : '',
      card.item.parallelism && card.item.parallelism !== 'parallel-safe'
        ? `parallelism: ${card.item.parallelism}`
        : '',
      card.item.conflictGroup ? `conflict_group: ${card.item.conflictGroup}` : '',
      card.item.workRole ? `work_role: ${card.item.workRole}` : '',
      'note: ',
      '/end-mission-task',
    ]
      .filter(Boolean)
      .join('\n');
  };

  readonly taskInspectorBlockedSummary = (card: MissionGraphCard): string => {
    if (card.item.blockedReason) return card.item.blockedReason;
    if (card.waiting && card.dependencies.length) {
      return `Waiting on ${card.dependencies
        .filter((dependency) => !dependency.done)
        .map((dependency) => dependency.title)
        .join(', ')}.`;
    }
    if (card.item.status === 'blocked') return 'Blocked without a recorded reason.';
    return '';
  };

  // ---- Activity feed builder --------------------------------------------

  private buildActivity(): MissionActivityEvent[] {
    const runsById = new Map(this.store.runs().map((run) => [run.id, run]));
    const laneByRun = new Map<string, { title: string; createdAt: number; actionId: string }>();
    const events: MissionActivityEvent[] = [];

    for (const action of this.store.runActions()) {
      if (action.label === 'YOLO lane assigned') {
        const title = activityTaskTitle(action.detail);
        if (!title) continue;
        const actor = this.actorLabel(action.agentId);
        laneByRun.set(action.runId, { title, createdAt: action.createdAt, actionId: action.id });
        events.push({
          id: `lane-start:${action.id}`,
          createdAt: action.createdAt,
          agentId: action.agentId,
          tone: 'work',
          title: `${actor} began work on "${title}"`,
          detail: 'parallel checklist lane assigned',
          runId: action.runId,
        });
      }
    }

    for (const run of this.store.runs()) {
      const lane = laneByRun.get(run.id);
      if (lane && run.completedAt && run.status !== 'running') {
        const elapsed = fmtElapsedLabel(run.startedAt, run.completedAt, Date.now());
        const actor = this.actorLabel(run.agentId);
        events.push({
          id: `lane-finish:${run.id}:${run.status}`,
          createdAt: run.completedAt,
          agentId: run.agentId,
          tone: run.status === 'completed' || run.status === 'empty' ? 'done' : 'blocked',
          title:
            run.status === 'completed' || run.status === 'empty'
              ? `${actor} finished "${lane.title}" in ${elapsed}`
              : `${actor} hit a failure on "${lane.title}" after ${elapsed}`,
          detail: run.error ? fmtOneLine(run.error, 180) : '',
          runId: run.id,
        });
      }
      if (run.lifecycleState === 'stalled' && run.lifecycleUpdatedAt) {
        events.push({
          id: `run-stalled:${run.id}:${run.lifecycleUpdatedAt}`,
          createdAt: run.lifecycleUpdatedAt,
          agentId: run.agentId,
          tone: 'blocked',
          title: `${this.actorLabel(run.agentId)} may be stalled`,
          detail: run.lifecycleReason || 'no provider signal recently',
          runId: run.id,
        });
      }
    }

    const laneRunIds = new Set(laneByRun.keys());
    for (const action of this.store.runActions()) {
      if (action.label === 'retry scheduled') {
        const run = runsById.get(action.runId);
        const laneTitle = laneByRun.get(action.runId)?.title;
        const actor = this.actorLabel(action.agentId);
        events.push({
          id: `retry:${action.id}`,
          createdAt: action.createdAt,
          agentId: action.agentId,
          tone: 'retry',
          title: `${actor} scheduled a retry${laneTitle ? ` for "${laneTitle}"` : ''}`,
          detail: actionDetailText(action, 180),
          runId: run?.id ?? action.runId,
        });
        continue;
      }

      const missionEvent = this.activityFromMissionAction(action, laneRunIds);
      if (missionEvent) events.push(missionEvent);
    }

    return this.dedupe(events)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(-160);
  }

  private dedupe(events: MissionActivityEvent[]): MissionActivityEvent[] {
    const seen = new Set<string>();
    const deduped: MissionActivityEvent[] = [];
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      deduped.push(event);
    }
    return deduped;
  }

  private activityFromMissionAction(
    action: AgentRunAction,
    laneRunIds: Set<string>,
  ): MissionActivityEvent | null {
    const actor = this.actorLabel(action.agentId);
    if (action.label === 'mission created') {
      return {
        id: `mission-created:${action.id}`,
        createdAt: action.createdAt,
        agentId: action.agentId,
        tone: 'mission',
        title: `${actor} created mission "${activityTaskTitle(action.detail)}"`,
        detail: '',
        runId: action.runId,
      };
    }

    if (/^mission plan (create|update)$/i.test(action.label)) {
      const parsed = parseActivityDetail(action.detail);
      if (!parsed || (parsed.status && parsed.status !== 'active')) return null;
      return {
        id: `plan:${action.id}`,
        createdAt: action.createdAt,
        agentId: action.agentId,
        tone: 'plan',
        title: `${actor} ${/create$/i.test(action.label) ? 'created' : 'updated'} active plan "${parsed.title}"`,
        runId: action.runId,
      };
    }

    if (action.label === 'mission phase auto-advance') {
      const [closed, opened] = (action.detail ?? '').split(/\s+done;\s+/i);
      return {
        id: `phase-auto:${action.id}`,
        createdAt: action.createdAt,
        agentId: action.agentId,
        tone: 'phase',
        title: `team closed "${closed || 'current phase'}" and opened "${(opened || '').replace(/\s+active$/i, '') || 'next phase'}"`,
        detail: 'phase gate advanced',
        runId: action.runId,
      };
    }

    if (/^mission phase (create|update)$/i.test(action.label)) {
      const parsed = parseActivityDetail(action.detail);
      if (!parsed) return null;
      const verb =
        parsed.status === 'done'
          ? 'closed phase gate'
          : parsed.status === 'active'
            ? 'opened phase gate'
            : parsed.status === 'blocked'
              ? 'blocked phase gate'
              : /^mission phase create$/i.test(action.label)
                ? 'added phase gate'
                : '';
      if (!verb) return null;
      return {
        id: `phase:${action.id}`,
        createdAt: action.createdAt,
        agentId: action.agentId,
        tone: parsed.status === 'blocked' ? 'blocked' : 'phase',
        title: `team ${verb} "${parsed.title}"`,
        detail: parsed.status ? `status: ${parsed.status}` : '',
        runId: action.runId,
      };
    }

    if (/^mission task (create|update)$/i.test(action.label)) {
      const parsed = parseActivityDetail(action.detail);
      if (!parsed) return null;
      if (parsed.status === 'done' && laneRunIds.has(action.runId)) return null;
      if (/^mission task create$/i.test(action.label)) {
        return {
          id: `task-create:${action.id}`,
          createdAt: action.createdAt,
          agentId: action.agentId,
          tone: 'work',
          title: `${actor} added checklist item "${parsed.title}"`,
          detail: parsed.status ? `status: ${parsed.status}` : '',
          runId: action.runId,
        };
      }
      if (parsed.status === 'done') {
        return {
          id: `task-done:${action.id}`,
          createdAt: action.createdAt,
          agentId: action.agentId,
          tone: 'done',
          title: `${actor} marked "${parsed.title}" done`,
          runId: action.runId,
        };
      }
      if (parsed.status === 'blocked') {
        return {
          id: `task-blocked:${action.id}`,
          createdAt: action.createdAt,
          agentId: action.agentId,
          tone: 'blocked',
          title: `${actor} blocked "${parsed.title}"`,
          runId: action.runId,
        };
      }
    }

    return null;
  }

  private actorLabel(agentId: AgentId | undefined): string {
    return agentId ? this.display.name(agentId) : 'agent';
  }
}
