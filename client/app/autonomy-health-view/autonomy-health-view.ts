import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { formatShortTime, oneLine } from '../formatters';
import type {
  AgentId,
  AgentRun,
  AgentTurnOutcome,
  MissionCommandEvent,
  RoutingDecision,
  TaskChecklistItem,
  TaskControl,
} from '../api.types';

type HealthTone = 'good' | 'info' | 'warn' | 'danger' | 'muted';

type HealthState = {
  label: string;
  detail: string;
  tone: HealthTone;
};

type HealthMetric = {
  label: string;
  value: number;
  detail: string;
  tone: HealthTone;
};

type WorkDispatchRow = {
  id: string;
  agentId: AgentId;
  title: string;
  reason: string;
  createdAt: number;
};

@Component({
  selector: 'fs-autonomy-health-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './autonomy-health-view.html',
  styleUrl: './autonomy-health-view.css',
})
export class AutonomyHealthView {
  protected readonly display = inject(AgentDisplayService);

  readonly taskControl = input<TaskControl | null>(null);
  readonly roomAgents = input<AgentId[]>([]);
  readonly runningRuns = input<AgentRun[]>([]);
  readonly turnOutcomes = input<AgentTurnOutcome[]>([]);
  readonly routingDecisions = input<RoutingDecision[]>([]);
  readonly missionCommandEvents = input<MissionCommandEvent[]>([]);

  readonly completedItemIds = computed(() => {
    const ids = new Set<string>();
    for (const item of this.taskControl()?.checklistItems ?? []) {
      if (item.status === 'done' || item.status === 'skipped') ids.add(item.id);
    }
    return ids;
  });

  readonly openItems = computed(() =>
    (this.taskControl()?.checklistItems ?? []).filter((item) => item.status === 'open'),
  );

  readonly blockedItems = computed(() =>
    (this.taskControl()?.checklistItems ?? []).filter((item) => item.status === 'blocked'),
  );

  readonly unassignedItems = computed(() =>
    this.openItems().filter((item) => !this.hasRoomOwner(item)),
  );

  readonly readyOwnedItems = computed(() =>
    this.openItems().filter((item) => this.hasRoomOwner(item) && this.dependenciesSatisfied(item)),
  );

  readonly dependencyWaitingItems = computed(() =>
    this.openItems().filter((item) => this.hasRoomOwner(item) && !this.dependenciesSatisfied(item)),
  );

  readonly councilBlockers = computed(() =>
    this.blockedItems().filter((item) => item.councilRequired),
  );

  readonly latestOutcome = computed(() => this.turnOutcomes()[0] ?? null);

  readonly latestProgressOutcome = computed(
    () => this.turnOutcomes().find((outcome) => outcome.progressed) ?? null,
  );

  readonly latestLivenessDecision = computed(
    () => this.routingDecisions().find((decision) => decision.action.startsWith('liveness:')) ?? null,
  );

  readonly lastRoutingDecision = computed(() => this.routingDecisions()[0] ?? null);

  readonly workDispatches = computed<WorkDispatchRow[]>(() =>
    this.turnOutcomes()
      .flatMap((outcome) =>
        outcome.workDispatches.map((dispatch) => ({
          id: `${outcome.id}:${dispatch.agentId}:${dispatch.itemId}`,
          agentId: dispatch.agentId,
          title: dispatch.title,
          reason: dispatch.reason,
          createdAt: outcome.createdAt,
        })),
      )
      .slice(0, 6),
  );

  readonly recentCommands = computed(() => this.missionCommandEvents().slice(0, 8));

  readonly state = computed<HealthState>(() => {
    const control = this.taskControl();
    if (!control) {
      return {
        label: 'No active mission',
        detail: 'Create or activate a mission before autonomy can evaluate work flow.',
        tone: 'muted',
      };
    }
    if (control.task.status === 'done') {
      return {
        label: 'Mission complete',
        detail: 'The active mission is marked done.',
        tone: 'good',
      };
    }
    const running = this.runningRuns();
    if (running.length > 0) {
      return {
        label: 'Waiting for agent',
        detail: `${running.length} provider run${running.length === 1 ? '' : 's'} still active.`,
        tone: 'info',
      };
    }
    if (this.readyOwnedItems().length > 0) {
      return {
        label: 'Ready work available',
        detail: `${this.readyOwnedItems().length} owned checklist item${
          this.readyOwnedItems().length === 1 ? '' : 's'
        } can be dispatched.`,
        tone: 'good',
      };
    }
    if (this.councilBlockers().length > 0) {
      return {
        label: 'Waiting for human',
        detail: `${this.councilBlockers().length} council blocker${
          this.councilBlockers().length === 1 ? '' : 's'
        } needs a decision.`,
        tone: 'warn',
      };
    }
    if (this.unassignedItems().length > 0) {
      return {
        label: 'Needs assignment',
        detail: `${this.unassignedItems().length} open item${
          this.unassignedItems().length === 1 ? '' : 's'
        } need an owner.`,
        tone: 'warn',
      };
    }
    if (this.dependencyWaitingItems().length > 0) {
      return {
        label: 'Waiting on dependencies',
        detail: `${this.dependencyWaitingItems().length} open item${
          this.dependencyWaitingItems().length === 1 ? '' : 's'
        } blocked by unfinished prerequisites.`,
        tone: 'info',
      };
    }
    if (this.blockedItems().length > 0) {
      return {
        label: 'Blocked',
        detail: `${this.blockedItems().length} checklist item${
          this.blockedItems().length === 1 ? '' : 's'
        } marked blocked.`,
        tone: 'danger',
      };
    }
    return {
      label: 'No open work detected',
      detail: 'Checklist has no open executable items. The mission may be ready for verification or closeout.',
      tone: 'good',
    };
  });

  readonly metrics = computed<HealthMetric[]>(() => [
    {
      label: 'ready',
      value: this.readyOwnedItems().length,
      detail: 'owned and dependency-clear',
      tone: this.readyOwnedItems().length > 0 ? 'good' : 'muted',
    },
    {
      label: 'unassigned',
      value: this.unassignedItems().length,
      detail: 'open without a room owner',
      tone: this.unassignedItems().length > 0 ? 'warn' : 'muted',
    },
    {
      label: 'blocked',
      value: this.blockedItems().length,
      detail: `${this.councilBlockers().length} council`,
      tone: this.blockedItems().length > 0 ? 'danger' : 'muted',
    },
    {
      label: 'running',
      value: this.runningRuns().length,
      detail: 'provider runs active',
      tone: this.runningRuns().length > 0 ? 'info' : 'muted',
    },
  ]);

  dependenciesSatisfied(item: TaskChecklistItem): boolean {
    const done = this.completedItemIds();
    return item.dependencyIds.every((id) => done.has(id));
  }

  hasRoomOwner(item: TaskChecklistItem): boolean {
    return !!item.ownerAgentId && this.roomAgents().includes(item.ownerAgentId);
  }

  formatShortTime(timestamp: number | undefined | null): string {
    return formatShortTime(timestamp ?? undefined);
  }

  oneLine(text: string | null | undefined, max = 120): string {
    return oneLine(text, max);
  }

  routingActionLabel(decision: RoutingDecision | null): string {
    if (!decision) return 'none yet';
    return decision.action.replace(/^liveness:/, '');
  }

  commandLabel(event: MissionCommandEvent): string {
    const action = event.action ? ` / ${event.action}` : '';
    return `${event.commandKind}${action}`;
  }

  outcomeSummary(outcome: AgentTurnOutcome): string {
    if (outcome.summary) return outcome.summary;
    const parts = [
      outcome.visibleMessageEmitted ? 'visible message' : 'no visible message',
      outcome.missionUpdates ? `${outcome.missionUpdates} mission updates` : '',
      outcome.missionReceipts ? `${outcome.missionReceipts} receipts` : '',
      outcome.workDispatches.length ? `${outcome.workDispatches.length} dispatches` : '',
    ].filter(Boolean);
    return parts.join(' / ') || outcome.status;
  }
}
