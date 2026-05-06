// client/app/overview-view/overview-view.ts
// Mission overview hero. Owns every derivation it renders: tabbed
// brief/active card, attention frame (warnings/blockers/queued messages
// across the active room), the agent telemetry rail, runtime/token tiles,
// mission-progress bar, and phase markers. Reads source data from
// MissionStore + AgentDisplayService + AgentRingService and ticks its own
// `now` signal so duration labels stay live. Emits an `attentionItemOpened`
// event when the user clicks a row that targets a specific run — App
// handles that by opening the run-detail modal.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { MissionStore } from '../mission-store';
import {
  elapsedLabel as fmtElapsedLabel,
  formatDurationMs as fmtDurationMs,
  formatRelativeAgo as fmtRelativeAgo,
  formatTokenCount as fmtTokenCount,
  oneLine as fmtOneLine,
  pad2 as fmtPad2,
} from '../formatters';
import { permissionRequestLabel as permRequestLabel } from '../permissions';
import { initOverviewRays } from '../overview-rays';
import { ACTIVE_TASK_STATUSES } from '../task-constants';
import type { OpsTone } from '../mission-graph';
import type {
  AgentId,
  AgentRun,
  AgentRunAction,
  PermissionRequest,
  Task,
  TaskChecklistItem,
  TaskControl,
} from '../api.types';

export type MissionTab = 'brief' | 'active';

export type AgentRailKind = 'running' | 'yolo' | 'idle' | 'ready' | 'waiting' | 'blocked' | 'stale';

export type OverviewAgentRow = {
  agentId: AgentId;
  status: string;
  detail: string;
  kind: AgentRailKind;
  working: boolean;
  idle: boolean;
};

export type OverviewPhaseMarker = {
  id: string;
  title: string;
  isDone: boolean;
  isCurrent: boolean;
};

export type AttentionItem = {
  id: string;
  tone: OpsTone;
  label: string;
  title: string;
  detail: string;
  createdAt: number;
  agentId?: AgentId | undefined;
  runId?: string | undefined;
};

type PhaseRepairState = {
  count: number;
  phaseTitle: string;
  itemTitle: string;
  itemDetail: string;
};

const ATTENTION_TONE_PRIORITY: Record<OpsTone, number> = {
  danger: 0,
  warn: 1,
  info: 2,
  good: 3,
  muted: 4,
};

@Component({
  selector: 'fs-overview-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overview-view.html',
  styleUrl: './overview-view.css',
})
export class OverviewView implements OnDestroy {
  protected readonly display = inject(AgentDisplayService);
  private readonly store = inject(MissionStore);

  readonly attentionItemOpened = output<AttentionItem>();

  readonly missionTab = signal<MissionTab>('active');

  // Time tick for duration-sensitive labels (runtime, "X ago", retry-due-in).
  private readonly now = signal(Date.now());
  private readonly clockTimer = window.setInterval(() => this.now.set(Date.now()), 1000);

  // ---- Domain accessors -------------------------------------------------

  readonly taskControl = computed<TaskControl | null>(() => this.store.taskControl());
  readonly activeTask = computed<Task | null>(
    () => this.store.tasks().find((task) => ACTIVE_TASK_STATUSES.includes(task.status)) ?? null,
  );

  // Sorted checklist items — open first, then blocked, then done, then
  // skipped. Used by the "current work item" pointer and "up next" list.
  private readonly sortedChecklistItems = computed(() => {
    const items = this.store.taskControl()?.checklistItems ?? [];
    const order: Record<string, number> = { open: 0, blocked: 1, done: 2, skipped: 3 };
    return [...items].sort((a, b) => {
      const statusDelta = (order[a.status] ?? 4) - (order[b.status] ?? 4);
      if (statusDelta !== 0) return statusDelta;
      return a.sortOrder - b.sortOrder;
    });
  });

  // Run/message slices used by attentionItems below.
  private readonly retryingRuns = computed(() =>
    this.store.runs().filter((run) => run.lifecycleState === 'retry_queued'),
  );
  private readonly stalledRuns = computed(() =>
    this.store.runs().filter(
      (run) =>
        run.lifecycleState === 'stalled' ||
        (run.status === 'running' && this.runIdleMs(run) >= 5 * 60 * 1000),
    ),
  );
  private readonly failedRuns = computed(() =>
    this.store.runs()
      .filter((run) => run.status === 'failed')
      .sort((a, b) => (b.completedAt ?? b.startedAt ?? 0) - (a.completedAt ?? a.startedAt ?? 0))
      .slice(0, 4),
  );
  private readonly queuedHumanMessages = computed(() =>
    this.store.messages().filter(
      (message) => message.authorKind === 'human' && message.deliveryStatus === 'queued',
    ),
  );

  // ---- Top-line labels --------------------------------------------------

  readonly phaseProgressLabel = computed(() => {
    const control = this.taskControl();
    const phases = control?.phases ?? [];
    if (phases.length === 0) return 'none';
    const currentId = control?.currentPhase?.id;
    const idx = phases.findIndex((p) => p.id === currentId);
    if (idx < 0 && this.phaseRepairState()) return 'needs repair';
    if (idx < 0) return 'complete';
    const ord = idx >= 0 ? idx + 1 : 0;
    return `${this.pad2(ord)} of ${this.pad2(phases.length)}`;
  });
  readonly phaseRepairState = computed<PhaseRepairState | null>(() => {
    const control = this.taskControl();
    if (!control) return null;
    const completedPhaseIds = new Set(
      control.phases.filter((phase) => phase.status === 'done').map((phase) => phase.id),
    );
    if (completedPhaseIds.size === 0) return null;
    const unfinished = control.checklistItems
      .filter(
        (item) =>
          item.phaseId !== null &&
          completedPhaseIds.has(item.phaseId) &&
          item.status !== 'done' &&
          item.status !== 'skipped',
      )
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const first = unfinished[0];
    if (!first) return null;
    const phase = control.phases.find((candidate) => candidate.id === first.phaseId);
    return {
      count: unfinished.length,
      phaseTitle: phase?.title ?? 'completed phase',
      itemTitle: first.title,
      itemDetail: first.detail || first.statusNote || first.blockedReason,
    };
  });
  readonly activeTaskStartedLabel = computed(() => {
    const task = this.activeTask();
    if (!task) return '—';
    return fmtRelativeAgo(task.createdAt, this.now());
  });
  readonly activeTaskRepoPath = computed(() => {
    const task = this.activeTask();
    return task?.repoPath || 'not set';
  });
  readonly currentWorkItem = computed<TaskChecklistItem | null>(
    () => this.sortedChecklistItems().find((item) => item.status === 'open') ?? null,
  );

  // ---- Attention frame --------------------------------------------------

  readonly attentionItems = computed<AttentionItem[]>(() => {
    const items: AttentionItem[] = [];
    const now = this.now();
    const repair = this.phaseRepairState();
    if (repair) {
      const task = this.activeTask();
      items.push({
        id: 'phase-repair',
        tone: 'warn',
        label: 'mission control',
        title: 'Phase state needs repair',
        detail: `${repair.count} unfinished item(s) are attached to completed phase(s); start with ${repair.phaseTitle}.`,
        createdAt: task?.updatedAt ?? task?.createdAt ?? now,
      });
    }

    for (const request of this.store.permissionRequests().filter(
      (request) => request.status === 'pending',
    )) {
      items.push({
        id: `permission:${request.id}`,
        tone: 'warn',
        label: 'permission',
        title: `${this.activityActor(request.agentId)} needs ${permRequestLabel(request)}`,
        detail: `${request.target}: ${fmtOneLine(request.reason, 180)}`,
        createdAt: request.createdAt,
        agentId: request.agentId,
      });
    }

    for (const message of this.queuedHumanMessages()) {
      items.push({
        id: `queued:${message.id}`,
        tone: 'info',
        label: 'queued message',
        title: `${message.authorId} message waiting for active run`,
        detail: fmtOneLine(message.text, 180),
        createdAt: message.createdAt,
      });
    }

    for (const run of this.retryingRuns()) {
      const retryMs = run.retryAfter ? Math.max(0, run.retryAfter - now) : 0;
      items.push({
        id: `retry:${run.id}`,
        tone: 'warn',
        label: 'retry',
        title: `${this.activityActor(run.agentId)} retry queued`,
        detail: `${run.attempt && run.attempt > 1 ? `attempt ${run.attempt}; ` : ''}${retryMs ? `due in ${fmtDurationMs(retryMs)}; ` : ''}${fmtOneLine(run.lifecycleReason || run.error || 'waiting for retry window', 180)}`,
        createdAt:
          run.retryAfter || run.lifecycleUpdatedAt || run.completedAt || run.startedAt || 0,
        agentId: run.agentId,
        runId: run.id,
      });
    }

    for (const run of this.stalledRuns()) {
      if (run.lifecycleState === 'retry_queued') continue;
      items.push({
        id: `stalled:${run.id}`,
        tone: 'danger',
        label: 'stalled',
        title: `${this.activityActor(run.agentId)} may be stalled`,
        detail: fmtOneLine(
          run.lifecycleReason ||
            `no provider signal for ${fmtDurationMs(this.runIdleMs(run))}`,
          180,
        ),
        createdAt: run.lifecycleUpdatedAt || run.lastSignalAt || run.startedAt || 0,
        agentId: run.agentId,
        runId: run.id,
      });
    }

    for (const run of this.failedRuns()) {
      items.push({
        id: `failed:${run.id}`,
        tone: 'danger',
        label: 'failed',
        title: `${this.activityActor(run.agentId)} run failed`,
        detail: fmtOneLine(
          run.error || run.lifecycleReason || 'failure recorded without detail',
          180,
        ),
        createdAt: run.completedAt || run.startedAt || 0,
        agentId: run.agentId,
        runId: run.id,
      });
    }

    for (const item of this.taskControl()?.blockedChecklistItems ?? []) {
      items.push({
        id: `blocked-item:${item.id}`,
        tone: item.councilRequired ? 'danger' : 'warn',
        label: item.councilRequired ? 'council' : 'blocked task',
        title: item.title,
        detail: fmtOneLine(
          item.blockedReason || item.statusNote || 'blocked without recorded reason',
          180,
        ),
        createdAt: item.updatedAt || item.createdAt,
        agentId: item.ownerAgentId || undefined,
      });
    }

    return items
      .sort(
        (a, b) =>
          (ATTENTION_TONE_PRIORITY[a.tone] ?? 4) - (ATTENTION_TONE_PRIORITY[b.tone] ?? 4) ||
          b.createdAt - a.createdAt,
      )
      .slice(0, 12);
  });

  readonly blockerItems = computed(() =>
    this.attentionItems().filter((item) => item.tone === 'danger' || item.tone === 'warn'),
  );
  readonly upNextItems = computed(() => {
    const skipIds = new Set(this.attentionItems().map((item) => item.id));
    return this.sortedChecklistItems()
      .filter((item) => item.status === 'open' || item.status === 'blocked')
      .filter((item) => !skipIds.has(`work:${item.id}`))
      .slice(0, 3);
  });

  // ---- Agent rail -------------------------------------------------------

  readonly agentRows = computed<OverviewAgentRow[]>(() => {
    const room = this.store.selectedRoom();
    if (!room) return [];
    return room.agents.map((agentId) => {
      const kind = this.display.railKind(agentId);
      return {
        agentId,
        status: this.display.railStatus(agentId),
        detail: this.display.railDetail(agentId),
        kind,
        working: kind === 'running',
        idle: kind === 'idle' || kind === 'ready' || kind === 'waiting' || kind === 'yolo',
      };
    });
  });
  readonly workingCount = computed(
    () => this.agentRows().filter((row) => row.working).length,
  );
  readonly idleCount = computed(() => this.agentRows().filter((row) => row.idle).length);

  // ---- Runtime / tokens tiles -------------------------------------------

  // Pick the most recently started running run (matches the previous
  // behavior of showing rows[0] from buildActiveSessionRows).
  private readonly featuredRunningRun = computed<AgentRun | null>(() => {
    const runs = this.store
      .runs()
      .filter((run) => run.status === 'running')
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return runs[0] ?? null;
  });
  readonly runtimeLabel = computed(() => {
    const run = this.featuredRunningRun();
    if (!run) return '—';
    return fmtElapsedLabel(run.startedAt, null, this.now());
  });
  readonly tokensLabel = computed(() => {
    const usage = this.store.selectedRoomSnapshot()?.tokenUsage;
    if (usage?.totalTokens) return fmtTokenCount(usage.totalTokens);
    return usage?.promptEstimateTokens ? `~${fmtTokenCount(usage.promptEstimateTokens)}` : '0';
  });
  readonly tokenScopeLabel = computed(() => {
    const missionUsage = this.store.selectedRoomSnapshot()?.activeMissionTokenUsage;
    if (missionUsage?.totalTokens) return `mission ${fmtTokenCount(missionUsage.totalTokens)}`;
    return 'room total';
  });
  readonly tokenBreakdownTitle = computed(() => {
    const roomUsage = this.store.selectedRoomSnapshot()?.tokenUsage;
    if (!roomUsage) return 'No room token usage recorded yet';
    const lines = [
      `Room observed: ${fmtTokenCount(roomUsage.totalTokens)} tokens across ${roomUsage.usageEvents} provider usage event(s)`,
      `Prompt estimate: ${fmtTokenCount(roomUsage.promptEstimateTokens)} tokens across ${roomUsage.runs} run(s)`,
      `Input: ${fmtTokenCount(roomUsage.inputTokens)} / output: ${fmtTokenCount(roomUsage.outputTokens)}`,
      roomUsage.cacheCreationInputTokens || roomUsage.cacheReadInputTokens
        ? `Claude cache creation: ${fmtTokenCount(roomUsage.cacheCreationInputTokens)} / cache read: ${fmtTokenCount(roomUsage.cacheReadInputTokens)}`
        : '',
      roomUsage.byProvider.length > 0
        ? `By provider: ${roomUsage.byProvider
            .map((bucket) => `${bucket.label} ${fmtTokenCount(bucket.totalTokens)}`)
            .join(', ')}`
        : '',
    ].filter(Boolean);
    const missionUsage = this.store.selectedRoomSnapshot()?.activeMissionTokenUsage;
    if (missionUsage) {
      lines.splice(
        1,
        0,
        `Active mission observed: ${fmtTokenCount(missionUsage.totalTokens)} tokens`,
      );
    }
    return lines.join('\n');
  });

  // ---- Progress bar -----------------------------------------------------

  readonly progressPercent = computed(() => {
    const items = this.taskControl()?.checklistItems ?? [];
    if (items.length === 0) return 0;
    const done = items.filter((item) => item.status === 'done').length;
    return Math.round((done / items.length) * 100);
  });
  readonly progressDoneLabel = computed(() => {
    const items = this.taskControl()?.checklistItems ?? [];
    if (items.length === 0) return '— / —';
    const done = items.filter((item) => item.status === 'done').length;
    return `${this.pad2(done)} / ${this.pad2(items.length)} items`;
  });

  readonly phaseMarkers = computed<OverviewPhaseMarker[]>(() => {
    const control = this.taskControl();
    const phases = control?.phases ?? [];
    const currentId = control?.currentPhase?.id;
    const currentIdx = phases.findIndex((p) => p.id === currentId);
    return phases.map((phase, i) => ({
      id: phase.id,
      title: phase.title,
      isDone: phase.status === 'done' || (currentIdx >= 0 && i < currentIdx),
      isCurrent: phase.id === currentId,
    }));
  });

  // ---- WebGL god-rays renderer wiring -----------------------------------

  private readonly raysCanvas = viewChild<ElementRef<HTMLCanvasElement>>('overviewRaysCanvas');
  private readonly attnCard = viewChild<ElementRef<HTMLElement>>('overviewAttnCard');
  private raysTeardown: (() => void) | null = null;

  constructor() {
    effect(() => {
      const canvasRef = this.raysCanvas();
      const cardRef = this.attnCard();

      if (this.raysTeardown) {
        this.raysTeardown();
        this.raysTeardown = null;
      }

      if (canvasRef && cardRef) {
        untracked(() => {
          this.raysTeardown = initOverviewRays(
            canvasRef.nativeElement,
            cardRef.nativeElement,
          );
        });
      }
    });
  }

  ngOnDestroy(): void {
    window.clearInterval(this.clockTimer);
    if (this.raysTeardown) {
      this.raysTeardown();
      this.raysTeardown = null;
    }
  }

  selectMissionTab(tab: MissionTab): void {
    this.missionTab.set(tab);
  }

  emitAttentionOpened(item: AttentionItem): void {
    this.attentionItemOpened.emit(item);
  }

  pad2(value: number): string {
    return fmtPad2(value);
  }

  oneLine(text: string | null | undefined, max: number): string {
    return fmtOneLine(text, max);
  }

  // ---- Helpers ----------------------------------------------------------

  private activityActor(agentId: AgentId | undefined): string {
    return agentId ? this.display.name(agentId) : 'agent';
  }

  private runIdleMs(run: AgentRun): number {
    const latestActionAt = this.latestRawActionForRun(run.id)?.createdAt ?? 0;
    const reference = Math.max(
      run.lastSignalAt || 0,
      latestActionAt,
      run.lifecycleUpdatedAt || 0,
      run.startedAt || 0,
    );
    return reference ? Math.max(0, this.now() - reference) : 0;
  }

  private latestRawActionForRun(runId: string): AgentRunAction | null {
    return (
      this.store
        .runActions()
        .filter((action) => action.runId === runId)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    );
  }
}
