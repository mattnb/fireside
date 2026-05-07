import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  untracked,
  viewChild,
  ViewChild,
  ViewEncapsulation,
} from '@angular/core';

import { FiresideApi } from './api.service';
import { PlanView } from './plan-view/plan-view';
import { SetupView, type MissionsChangedEvent } from './setup-view/setup-view';
import { EvidenceView } from './evidence-view/evidence-view';
import { BriefingsTab } from './briefings-tab/briefings-tab';
import { ChecklistView } from './checklist-view/checklist-view';
import { BoardView } from './board-view/board-view';
import { RoadmapView } from './roadmap-view/roadmap-view';
import { AutonomyHealthView } from './autonomy-health-view/autonomy-health-view';
import { OverviewView, type AttentionItem } from './overview-view/overview-view';
import { AgentDisplayService } from './agent-display.service';
import { AgentRingService } from './agent-ring.service';
import { ChatPane } from './chat-pane/chat-pane';
import { AgentsPanel } from './agents-panel/agents-panel';
import { RunDetailModal } from './run-detail-modal/run-detail-modal';
import { TaskInspectorModal } from './task-inspector-modal/task-inspector-modal';
import { CreateRoomModal } from './create-room-modal/create-room-modal';
import { EditAgentsModal } from './edit-agents-modal/edit-agents-modal';
import { CompactAgentModal } from './compact-agent-modal/compact-agent-modal';
import { Sidebar } from './sidebar/sidebar';
import { ToastHost } from './toast-host/toast-host';
import { ToastService } from './toast.service';
import { ArchivesView } from './archives-view/archives-view';
import { DeleteProjectModal } from './delete-project-modal/delete-project-modal';
import { Topbar } from './topbar/topbar';
import {
  MissionToolbar,
  MISSION_ACTIONS,
  type MissionActionDefinition,
  type MissionActionKind,
  type MissionActionScope,
} from './mission-toolbar/mission-toolbar';
import { MissionOutline } from './mission-outline/mission-outline';
import { TokenBurnPanel } from './token-burn-panel/token-burn-panel';
import { CompletedRunsModal } from './completed-runs-modal/completed-runs-modal';
import type { DraftRoomAgent } from './room-agent-types';
import type { ChatTimelineItem } from './chat-types';
import { type EvidenceEvent, type EvidenceEventKind } from './evidence-timeline';
import { ACTIVE_TASK_STATUSES } from './task-constants';
import {
  elapsedLabel as fmtElapsedLabel,
  formatBytes as fmtBytes,
  formatDateTime as fmtDateTime,
  formatDurationMs as fmtDurationMs,
  formatRelativeAgo as fmtRelativeAgo,
  formatResetWindow as fmtResetWindow,
  formatShortTime as fmtShortTime,
  formatTokenCount as fmtTokenCount,
  oneLine as fmtOneLine,
  pad2 as fmtPad2,
} from './formatters';
import { quotaTone as ringQuotaTone, ringFillDash, ringTrackDash } from './quota-ring';
import {
  permissionModeLabel as permModeLabel,
  permissionRequestLabel as permRequestLabel,
} from './permissions';
import { DEFAULT_AGENT_CATALOG } from './catalog-defaults';
import { MissionStore } from './mission-store';
import { MissionEventRouter, type MissionEventContext } from './mission-event-router';
import { escapeHtml, markdownToHtml as renderMarkdown } from './markdown';
import {
  actionDetailText,
  activityTaskTitle,
  parseActivityDetail,
  readableDetailText,
} from './run-detail';
import type {
  MissionBoardColumnId,
  MissionGraphCard,
  MissionGraphDependency,
  MissionGraphLane,
  MissionGraphTone,
  OpsTone,
} from './mission-graph';
import { MissionGraphService } from './mission-graph.service';
import {
  AgentId,
  AgentCatalog,
  AgentContextUsage,
  AgentPersona,
  AgentProviderCatalogItem,
  AgentRun,
  AgentRunAction,
  AgentRunDetail,
  AgentQuotaUsage,
  AgentQuotaWindowUsage,
  ArtifactListing,
  CapabilityProfile,
  CollaborationItem,
  Message,
  PermissionRequest,
  ProviderId,
  ProviderScoreResponse,
  ProviderScoreSlotResult,
  Room,
  RoomAgentProfile,
  Project,
  StatusSnapshot,
  StatusSnapshotAgentState,
  StatusSnapshotRoom,
  Task,
  TaskChecklistItem,
  TaskChecklistNote,
  TaskChecklistStatus,
  TaskControl,
  TaskPhase,
  TaskPhaseStatus,
  TaskStatus,
  YoloStatus,
} from './api.types';
import { FiresideWs } from './ws.service';

const INLINE_CHAT_TOKEN_RE =
  /`[^`]+`|@file\("[^"]+"\)|(?:^|[\s([{"'`>])@[a-z][a-z0-9-]*(?=$|[\s,;:!?)\]}"'\u2014\u2013-]|\.(?=[\s)\]}"']|$))/gi;
const CHAT_MENTION_RE =
  /(?:^|[\s([{"'`>])@[a-z][a-z0-9-]*(?=$|[\s,;:!?)\]}"'\u2014\u2013-]|\.(?=[\s)\]}"']|$))/gi;

/** Display cap on chat scrollback. The full history stays in the DB and is
 *  served by the API; the chat pane just renders the most-recent N messages
 *  to keep the DOM (and the user's eye) bounded. Permissions + activity
 *  events older than the oldest visible message are also filtered so the
 *  rendered timeline stays coherent. */
const CHAT_TIMELINE_MESSAGE_CAP = 50;

type TabId = 'chat' | 'mission' | 'briefings' | 'archives';
type MissionViewId =
  | 'overview'
  | 'health'
  | 'board'
  | 'checklist'
  | 'roadmap'
  | 'plan'
  | 'evidence'
  | 'setup';
type AgentRailKind = 'running' | 'yolo' | 'idle' | 'ready' | 'waiting' | 'blocked' | 'stale';
type MissionBoardColumn = {
  id: MissionBoardColumnId;
  label: string;
  summary: string;
};
const FRIENDLY_AGENT_NAMES = [
  'Ada',
  'Grace',
  'Katherine',
  'Margaret',
  'Radia',
  'Barbara',
  'Frances',
  'Mary',
  'Dorothy',
  'Joan',
  'Edsger',
  'Ken',
  'Dennis',
  'Donald',
  'Niklaus',
  'Tim',
  'Vint',
  'Leslie',
  'Evelyn',
  'Sophie',
  'Emmy',
  'Alan',
  'Anita',
  'Francesco',
];
const DEFAULT_AGENT_AUTO_COMPACT_PERCENT = 70;

@Component({
  selector: 'fs-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PlanView,
    SetupView,
    EvidenceView,
    BriefingsTab,
    ChecklistView,
    BoardView,
    RoadmapView,
    AutonomyHealthView,
    OverviewView,
    ChatPane,
    AgentsPanel,
    RunDetailModal,
    TaskInspectorModal,
    CreateRoomModal,
    EditAgentsModal,
    CompactAgentModal,
    Sidebar,
    Topbar,
    MissionToolbar,
    MissionOutline,
    TokenBurnPanel,
    CompletedRunsModal,
    ArchivesView,
    DeleteProjectModal,
    ToastHost,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
  // app.css carries the layout grammar for the whole shell — `.sidebar`,
  // `.presence`, `.context-rail`, `.workspace`, plus shared utility classes
  // referenced by extracted child components. Angular's default Emulated
  // encapsulation would scope those rules to App's view, so when children
  // render their own `<aside class="sidebar">` etc. inside their own scopes
  // the rules wouldn't apply and the layout collapses. Switching to None
  // makes app.css global. Each extracted child still keeps its own
  // Emulated scope (default), so `:host { display: contents }` etc. inside
  // child CSS files continue to apply only to those hosts.
  encapsulation: ViewEncapsulation.None,
})
export class App implements OnDestroy {
  @ViewChild('chatPane') private chatPaneRef?: ChatPane;

  private readonly api = inject(FiresideApi);
  private readonly store = inject(MissionStore);
  private readonly ws = inject(FiresideWs);
  private readonly eventRouter = inject(MissionEventRouter);
  private readonly toasts = inject(ToastService);
  protected readonly display = inject(AgentDisplayService);
  protected readonly ring = inject(AgentRingService);
  protected readonly graph = inject(MissionGraphService);
  private scrollFrame: number | null = null;
  private deleteConfirmTimer: number | null = null;
  private draftAgentCounter = 0;
  private newRoomProviderScoreRequest = 0;
  private editRoomProviderScoreRequest = 0;
  private readonly clockTimer = window.setInterval(() => this.now.set(Date.now()), 1000);

  readonly agentChoices: AgentId[] = ['claude', 'codex', 'gemini'];
  get agentCatalog() {
    return this.store.agentCatalog;
  }
  readonly tabs: Array<{ id: TabId; label: string }> = [
    { id: 'chat', label: 'Chat' },
    { id: 'mission', label: 'Mission Control' },
  ];
  readonly missionViews: Array<{ id: MissionViewId; label: string; summary: string }> = [
    { id: 'overview', label: 'Overview', summary: 'health, blockers, active work' },
    { id: 'health', label: 'Health', summary: 'why autonomy is moving or waiting' },
    { id: 'board', label: 'Board', summary: 'status lanes and phase swimlanes' },
    { id: 'checklist', label: 'Checklist', summary: 'task details and ownership' },
    { id: 'roadmap', label: 'Roadmap', summary: 'phase gates and dependencies' },
    { id: 'plan', label: 'Plan', summary: 'team agreement and rationale' },
    { id: 'evidence', label: 'Evidence', summary: 'runs, artifacts, receipts' },
    { id: 'setup', label: 'Setup', summary: 'mission parameters' },
  ];
  readonly missionActions = MISSION_ACTIONS;
  readonly missionBoardColumns: MissionBoardColumn[] = [
    { id: 'ready', label: 'Ready', summary: 'unblocked work agents can take' },
    { id: 'active', label: 'In Progress', summary: 'active provider runs' },
    { id: 'blocked', label: 'Blocked', summary: 'blocked or waiting on dependencies' },
    { id: 'review', label: 'Review', summary: 'evidence exists but state is not closed' },
    { id: 'done', label: 'Done', summary: 'completed or skipped work' },
  ];
  readonly checklistStatuses: TaskChecklistStatus[] = ['open', 'blocked', 'done', 'skipped'];

  readonly selectedTab = signal<TabId>('chat');
  readonly selectedMissionView = signal<MissionViewId>('overview');
  readonly now = signal(Date.now());
  readonly authorName = signal(localStorage.getItem('fireside.author') || 'human');
  readonly creatingProject = signal(false);
  readonly creatingMissionProjectId = signal<string | null>(null);
  readonly pendingProjectDeletion = signal<Project | null>(null);
  readonly completedRunsModalOpen = signal(false);
  readonly newRoomAgentRows = signal<DraftRoomAgent[]>(this.defaultDraftRoomAgents());
  readonly newRoomLeadClientId = signal<string>('');
  readonly newRoomProviderRecommendations = signal<
    Record<string, ProviderScoreSlotResult | undefined>
  >({});
  readonly deletingRoomId = signal<string | null>(null);
  readonly editingAgents = signal(false);
  readonly editRoomAgentRows = signal<DraftRoomAgent[]>([]);
  readonly editRoomLeadClientId = signal<string>('');
  readonly editRoomProviderRecommendations = signal<
    Record<string, ProviderScoreSlotResult | undefined>
  >({});
  readonly newRoomAgentValidationError = computed(() =>
    this.agentDraftValidationError(this.newRoomAgentRows()),
  );
  readonly editRoomAgentValidationError = computed(() =>
    this.agentDraftValidationError(this.editRoomAgentRows()),
  );
  readonly compactAgent = signal<AgentId | null>(null);
  get compactingAgent() {
    return this.store.compactingAgent;
  }
  readonly compactError = signal('');
  get projects() {
    return this.store.projects;
  }
  get rooms() {
    return this.store.rooms;
  }
  get stateSnapshot() {
    return this.store.stateSnapshot;
  }
  get selectedProjectId() {
    return this.store.selectedProjectId;
  }
  get selectedRoomId() {
    return this.store.selectedRoomId;
  }
  get messages() {
    return this.store.messages;
  }
  get permissionRequests() {
    return this.store.permissionRequests;
  }
  get tasks() {
    return this.store.tasks;
  }
  get runs() {
    return this.store.runs;
  }
  get runActions() {
    return this.store.runActions;
  }
  get routingDecisions() {
    return this.store.routingDecisions;
  }
  get missionCommandEvents() {
    return this.store.missionCommandEvents;
  }
  get turnOutcomes() {
    return this.store.turnOutcomes;
  }
  get artifacts() {
    return this.store.artifacts;
  }
  get collaboration() {
    return this.store.collaboration;
  }
  get briefings() {
    return this.store.briefings;
  }
  get taskControl() {
    return this.store.taskControl;
  }
  get yoloStatus() {
    return this.store.yoloStatus;
  }
  get missionActionPopoverOpen() {
    return this.store.missionActionPopoverOpen;
  }
  get selectedMissionAction() {
    return this.store.selectedMissionAction;
  }
  get missionActionScope() {
    return this.store.missionActionScope;
  }
  get missionActionAgent() {
    return this.store.missionActionAgent;
  }
  get selectedMissionActionAgents() {
    return this.store.selectedMissionActionAgents;
  }
  get missionActionChecklistItemId() {
    return this.store.missionActionChecklistItemId;
  }
  readonly openRunDetailId = signal<string | null>(null);
  get runDetail() {
    return this.store.runDetail;
  }
  readonly runDetailLoading = signal(false);
  readonly runDetailError = signal('');
  readonly taskInspectorItemId = signal<string | null>(null);
  readonly showLowSignalRunEvents = signal(
    localStorage.getItem('fireside.showLowSignalRunEvents') === 'true',
  );

  get selectedRoom() {
    return this.store.selectedRoom;
  }
  readonly selectedProject = computed(
    () => this.projects().find((project) => project.id === this.selectedProjectId()) ?? null,
  );
  readonly projectGroups = computed(() =>
    this.projects()
      .filter((project) => project.archivedAt === null)
      .map((project) => ({
        project,
        missions: this.rooms().filter((room) => room.projectId === project.id),
      })),
  );
  readonly archivedProjectsCount = computed(
    () => this.projects().filter((project) => project.archivedAt !== null).length,
  );
  readonly topbarChannelName = computed(() => {
    if (this.selectedTab() === 'briefings') return 'briefing room';
    return this.selectedRoom()?.name ?? this.selectedProject()?.name ?? 'no project selected';
  });
  readonly topbarHashShown = computed(
    () => this.selectedTab() !== 'briefings' && !!this.selectedRoom(),
  );
  readonly showProjectDashboardChip = computed(
    () => !this.selectedRoom() && this.selectedTab() !== 'briefings',
  );
  readonly selectedProjectRooms = computed(() => {
    const projectId = this.selectedProjectId();
    return projectId ? this.rooms().filter((room) => room.projectId === projectId) : [];
  });
  readonly selectedProjectAgents = computed(() => [
    ...new Set(this.selectedProjectRooms().flatMap((room) => room.agents)),
  ]);
  readonly selectedProjectYoloAgents = computed(() => [
    ...new Set(this.selectedProjectRooms().flatMap((room) => room.yoloAgents)),
  ]);
  readonly selectedProjectRoomSnapshots = computed(() => {
    const snapshot = this.stateSnapshot();
    const roomIds = new Set(this.selectedProjectRooms().map((room) => room.id));
    return snapshot?.rooms.filter((room) => roomIds.has(room.id)) ?? [];
  });
  get selectedRoomSnapshot() {
    return this.store.selectedRoomSnapshot;
  }
  readonly projectDashboardSummary = computed(() =>
    this.buildProjectDashboardSummary(this.selectedProjectRoomSnapshots()),
  );
  readonly activeTask = computed(
    () => this.tasks().find((task) => ACTIVE_TASK_STATUSES.includes(task.status)) ?? null,
  );
  readonly roomAgents = computed(() => this.selectedRoom()?.agents ?? []);
  get roomYoloAgents() {
    return this.store.roomYoloAgents;
  }
  readonly agentProviders = computed(() => this.agentCatalog().providers);
  readonly agentPersonas = computed(() => this.agentCatalog().personas);
  readonly latestContextUsageByAgent = computed(() => {
    const usageByAgent = new Map<AgentId, AgentContextUsage>();
    const mergeQuota = (
      existing: AgentQuotaUsage | undefined,
      next: AgentQuotaUsage | undefined,
    ): AgentQuotaUsage | undefined => {
      if (!next) return existing;
      const mergeWindow = (
        current: AgentQuotaWindowUsage | undefined,
        incoming: AgentQuotaWindowUsage | undefined,
      ): AgentQuotaWindowUsage | undefined =>
        incoming ? { ...(current ?? {}), ...incoming } : current;
      const merged: AgentQuotaUsage = {
        ...(existing ?? {}),
        ...next,
        source: next.source,
      };
      const fiveHour = mergeWindow(existing?.fiveHour, next.fiveHour);
      const sevenDay = mergeWindow(existing?.sevenDay, next.sevenDay);
      const daily = mergeWindow(existing?.daily, next.daily);
      if (fiveHour) merged.fiveHour = fiveHour;
      if (sevenDay) merged.sevenDay = sevenDay;
      if (daily) merged.daily = daily;
      return merged;
    };
    for (const entry of this.stateSnapshot()?.contextUsage?.byAgent ?? []) {
      usageByAgent.set(entry.agentId, { ...entry.usage });
    }
    const actions = [...this.runActions()].sort((a, b) => a.createdAt - b.createdAt);
    for (const action of actions) {
      if (!action.agentId || !action.contextUsage) continue;
      const existing = usageByAgent.get(action.agentId);
      if (action.contextUsage.quotaOnly && existing) {
        const merged = { ...existing };
        const quota = mergeQuota(existing.quota, action.contextUsage.quota);
        if (quota) merged.quota = quota;
        usageByAgent.set(action.agentId, merged);
        continue;
      }
      const merged = { ...action.contextUsage };
      const quota = mergeQuota(existing?.quota, merged.quota);
      if (quota) merged.quota = quota;
      usageByAgent.set(action.agentId, merged);
    }
    return usageByAgent;
  });
  readonly humans = computed(() => {
    const names = new Set<string>();
    for (const message of this.messages()) {
      if (message.authorKind === 'human') names.add(message.authorId);
    }
    names.add(this.authorName());
    return [...names].sort((a, b) => a.localeCompare(b));
  });
  get runningRuns() {
    return this.store.runningRuns;
  }
  readonly isRoomWorking = computed(() => this.runningRuns().length > 0);
  readonly visibleArtifacts = computed(() => this.artifacts()?.files.slice(0, 8) ?? []);
  readonly completedRuns = computed(() =>
    this.runs()
      .filter((run) => run.status !== 'running')
      .slice(0, 8),
  );
  readonly taskInspectorCard = computed(() => this.graph.findCard(this.taskInspectorItemId()));
  readonly chatTimeline = computed(() => {
    const visibleMessages = this.messages().filter(
      (message) => !this.isHiddenSystemMessage(message),
    );
    const cappedMessages = visibleMessages.slice(-CHAT_TIMELINE_MESSAGE_CAP);
    // Drop permissions + activity older than the oldest visible message so the
    // rendered window doesn't show orphaned events from the deep past. When the
    // chat is short (< cap) this is a no-op since oldestVisibleAt is 0.
    const oldestVisibleAt = cappedMessages[0]?.createdAt ?? 0;
    const runByReplyMessageId = new Map(
      this.runs()
        .filter((run) => run.replyMessageId)
        .map((run) => [run.replyMessageId as string, run]),
    );

    const rawItems: ChatTimelineItem[] = [
      ...cappedMessages.map((message) => {
        const run =
          message.authorKind === 'agent' ? runByReplyMessageId.get(message.id) : undefined;
        const workedFor = this.workedForLabel(run);
        return {
          id: `message:${message.id}`,
          kind: 'message' as const,
          createdAt: message.createdAt,
          message,
          grouped: false,
          html: this.renderMessageHtml(message.text),
          isError: message.authorKind === 'system' && /failed|timed out|error/i.test(message.text),
          humanMentioned: this.messageMentionsHuman(message),
          ...(workedFor ? { workedFor } : {}),
          ...(message.authorKind === 'system'
            ? {}
            : { seenAgents: this.display.messageSeenAgents(message) }),
        };
      }),
      ...this.permissionRequests()
        .filter((request) => request.createdAt >= oldestVisibleAt)
        .map((request) => ({
          id: `permission:${request.id}`,
          kind: 'permission' as const,
          createdAt: request.createdAt,
          request,
          grouped: false,
        })),
      ...this.graph
        .activity()
        .filter((activity) => activity.createdAt >= oldestVisibleAt)
        .map((activity) => ({
          id: `activity:${activity.id}`,
          kind: 'activity' as const,
          createdAt: activity.createdAt,
          activity,
          grouped: false,
        })),
    ].sort((a, b) => a.createdAt - b.createdAt);

    let lastAuthor = '';
    return rawItems.map((item) => {
      if (item.activity || !item.message || item.message.authorKind === 'system') {
        lastAuthor = '';
        return item;
      }
      const grouped = lastAuthor === item.message.authorId;
      lastAuthor = item.message.authorId;
      return { ...item, grouped };
    });
  });

  private workedForLabel(run: AgentRun | undefined): string | undefined {
    if (!run?.startedAt) return undefined;
    const now = run.completedAt ?? this.now();
    return fmtElapsedLabel(run.startedAt, run.completedAt ?? now, now);
  }

  readonly missionReceiptActions = computed(() => {
    const taskId = this.activeTask()?.id;
    return this.runActions()
      .filter((action) => action.taskId === taskId && this.isMissionReceiptAction(action))
      .slice(0, 8);
  });
  readonly hasCollaborationTrail = computed(
    () => this.collaboration().length > 0 || this.missionReceiptActions().length > 0,
  );

  readonly evidenceTimeline = computed<EvidenceEvent[]>(() => {
    const events: EvidenceEvent[] = [];

    for (const action of this.missionReceiptActions()) {
      events.push({
        id: `receipt:${action.id}`,
        kind: 'receipt',
        bucket: 'receipts',
        title: action.label.replace(/^mission receipt:\s*/i, ''),
        body: this.missionReceiptDetail(action),
        meta: action.status === 'failed' ? 'failed' : 'sealed',
        time: action.createdAt ?? Date.now(),
      });
    }

    for (const item of this.collaboration()) {
      const isDecision = item.kind === 'decision';
      const isBlocked = item.status === 'blocked' || item.status === 'rejected';
      const kind: EvidenceEventKind = isBlocked ? 'blocker' : isDecision ? 'decision' : 'note';
      const bucket: EvidenceEvent['bucket'] = isBlocked
        ? 'blockers'
        : isDecision
          ? 'decisions'
          : 'notes';
      events.push({
        id: `collab:${item.id}`,
        kind,
        bucket,
        title: item.title || `${item.kind}`,
        body: item.body,
        meta: `${item.kind} · ${item.status}`,
        actor: item.authorId ? this.display.name(item.authorId) : undefined,
        time: item.createdAt,
      });
    }

    for (const artifact of this.visibleArtifacts()) {
      events.push({
        id: `artifact:${artifact.path}`,
        kind: 'artifact',
        bucket: 'artifacts',
        title: artifact.name,
        body: artifact.path,
        meta: `${this.formatBytes(artifact.size)} · ${artifact.kind}`,
        time: artifact.updatedAt ?? Date.now(),
        artifact,
      });
    }

    for (const run of this.completedRuns()) {
      const failed = run.status !== 'completed';
      events.push({
        id: `run:${run.id}`,
        kind: failed ? 'run-failed' : 'run-completed',
        bucket: 'runs',
        title: `${this.display.name(run.agentId)} · ${run.status}`,
        body: this.runActionSignal(run) || '',
        meta: this.runMeta(run),
        time: run.completedAt ?? run.startedAt ?? 0,
        actor: this.display.name(run.agentId),
        runId: run.id,
      });
    }

    return events.sort((a, b) => b.time - a.time);
  });

  readonly missionActionWorkItems = computed(() => {
    const items = this.taskControl()?.checklistItems ?? [];
    const order: Record<string, number> = { open: 0, blocked: 1, done: 2, skipped: 3 };
    return [...items].sort((a, b) => {
      const statusDelta = (order[a.status] ?? 4) - (order[b.status] ?? 4);
      if (statusDelta !== 0) return statusDelta;
      return a.sortOrder - b.sortOrder;
    });
  });

  constructor() {
    this.ws.connect();
    this.loadAgentCatalog();
    this.loadProjects();
    this.loadRooms();
    this.loadStateSnapshot();

    effect(() => {
      const roomId = this.selectedRoomId();
      if (!roomId) return;
      untracked(() => {
        this.loadRoomDetail(roomId);
        this.ws.subscribe(roomId);
      });
    });

    const eventContext: MissionEventContext = {
      openRunDetailId: this.openRunDetailId,
      activeTask: this.activeTask,
      editingAgents: this.editingAgents,
      setEditRoomAgentRows: (rows) => this.editRoomAgentRows.set(rows),
      isChatNearBottom: () => this.isChatNearBottom(),
      scheduleChatScrollToBottom: () => this.scheduleChatScrollToBottom(),
      loadStateSnapshot: () => this.loadStateSnapshot(),
      loadAutonomyDiagnostics: (roomId) => this.loadAutonomyDiagnostics(roomId),
      loadArtifacts: (roomId) => this.loadArtifacts(roomId),
      loadTaskControl: (roomId, taskId) => this.loadTaskControl(roomId, taskId),
      loadCollaboration: (roomId, taskId) => this.loadCollaboration(roomId, taskId),
      openRunDetail: (runId, refresh) => this.openRunDetail(runId, refresh),
      handleRoomDeleted: (roomId) => this.handleRoomDeleted(roomId),
      draftRowsFromRoom: (room) => this.draftRowsFromRoom(room),
      isActivityRunUpdate: (run) => this.isActivityRunUpdate(run),
      isActivityRunAction: (action) => this.isActivityRunAction(action),
      isAutonomyDiagnosticAction: (action) => this.isAutonomyDiagnosticAction(action),
    };

    this.ws.stream$.subscribe((event) => this.eventRouter.route(event, eventContext));
  }

  ngOnDestroy(): void {
    window.clearInterval(this.clockTimer);
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    if (this.deleteConfirmTimer !== null) window.clearTimeout(this.deleteConfirmTimer);
  }

  selectRoom(roomId: string): void {
    const room = this.rooms().find((candidate) => candidate.id === roomId);
    if (room) this.selectedProjectId.set(room.projectId);
    this.selectedRoomId.set(roomId);
    if (this.selectedTab() === 'briefings') {
      this.selectedTab.set('chat');
      this.scheduleChatScrollToBottom();
    }
    this.closeRunDetail();
    this.closeTaskInspector();
  }

  selectProject(projectId: string): void {
    this.selectedProjectId.set(projectId);
    this.selectedRoomId.set(null);
    this.clearRoomState();
    if (this.selectedTab() === 'briefings' || this.selectedTab() === 'archives') {
      this.selectedTab.set('chat');
    }
  }

  selectTab(tabId: TabId): void {
    this.selectedTab.set(tabId);
    if (tabId === 'chat') this.scheduleChatScrollToBottom();
  }

  openBriefings(): void {
    this.selectTab('briefings');
  }

  openArchives(): void {
    this.selectTab('archives');
  }

  toggleCreateProject(): void {
    this.creatingProject.update((value) => !value);
    this.creatingMissionProjectId.set(null);
  }

  cancelCreateProject(input: HTMLInputElement): void {
    input.value = '';
    this.creatingProject.set(false);
  }

  createProject(input: HTMLInputElement): void {
    const name = input.value.trim();
    if (!name) return;
    this.api.projects.create({ name }).subscribe((project) => {
      this.projects.update((projects) => this.upsert(projects, project));
      this.selectedProjectId.set(project.id);
      this.selectedRoomId.set(null);
      input.value = '';
      this.creatingProject.set(false);
      this.clearRoomState();
    });
  }

  archiveProject(project: Project): void {
    if (project.id === 'general' || project.archivedAt !== null) return;
    this.api.projects.archive(project.id).subscribe({
      next: (updated) => {
        this.projects.update((projects) => this.upsert(projects, updated));
        if (this.selectedProjectId() === updated.id) {
          this.selectedProjectId.set(null);
          this.selectedRoomId.set(null);
          this.clearRoomState();
        }
        this.toasts.push({
          message: `archived "${updated.name}"`,
          action: { label: 'undo', run: () => this.unarchiveProject(updated) },
        });
      },
      error: () => {
        this.toasts.push({ message: `failed to archive "${project.name}"` });
      },
    });
  }

  unarchiveProject(project: Project): void {
    this.api.projects.unarchive(project.id).subscribe({
      next: (updated) => {
        this.projects.update((projects) => this.upsert(projects, updated));
      },
      error: () => {
        this.toasts.push({ message: `failed to restore "${project.name}"` });
      },
    });
  }

  requestDeleteProject(project: Project): void {
    if (project.id === 'general') return;
    this.pendingProjectDeletion.set(project);
  }

  cancelDeleteProject(): void {
    this.pendingProjectDeletion.set(null);
  }

  openCompletedRunsModal(): void {
    this.completedRunsModalOpen.set(true);
  }

  closeCompletedRunsModal(): void {
    this.completedRunsModalOpen.set(false);
  }

  confirmDeleteProject(project: Project): void {
    this.pendingProjectDeletion.set(null);
    if (project.id === 'general') return;
    this.api.projects.delete(project.id).subscribe({
      next: () => {
        this.projects.update((projects) => projects.filter((p) => p.id !== project.id));
        this.rooms.update((rooms) => rooms.filter((room) => room.projectId !== project.id));
        if (this.selectedProjectId() === project.id) {
          this.selectedProjectId.set(null);
          this.selectedRoomId.set(null);
          this.clearRoomState();
        }
        this.toasts.push({ message: `deleted "${project.name}"` });
      },
      error: () => {
        this.toasts.push({ message: `failed to delete "${project.name}"` });
      },
    });
  }

  toggleCreateRoom(projectId?: string): void {
    const targetProjectId = projectId ?? this.selectedProjectId();
    if (!targetProjectId) return;
    this.creatingProject.set(false);
    const nextProjectId =
      this.creatingMissionProjectId() === targetProjectId ? null : targetProjectId;
    this.creatingMissionProjectId.set(nextProjectId);
    if (nextProjectId) {
      this.refreshNewRoomProviderRecommendations();
    } else {
      this.newRoomProviderRecommendations.set({});
    }
  }

  cancelCreateRoom(input?: HTMLInputElement): void {
    if (input) input.value = '';
    this.newRoomAgentRows.set(this.defaultDraftRoomAgents());
    this.newRoomLeadClientId.set('');
    this.newRoomProviderRecommendations.set({});
    this.creatingMissionProjectId.set(null);
  }

  projectName(projectId: string | null): string {
    return this.projects().find((project) => project.id === projectId)?.name ?? 'this project';
  }

  addNewRoomAgent(): void {
    this.newRoomAgentRows.update((rows) => [
      ...rows,
      this.createDraftAgent(
        'claude',
        'generalist',
        false,
        this.suggestDraftAgentName('claude', rows),
      ),
    ]);
    this.refreshNewRoomProviderRecommendations();
  }

  removeNewRoomAgent(clientId: string): void {
    this.newRoomAgentRows.update((rows) => rows.filter((row) => row.clientId !== clientId));
    if (this.newRoomLeadClientId() === clientId) this.newRoomLeadClientId.set('');
    this.refreshNewRoomProviderRecommendations();
  }

  setNewRoomAgentProvider(clientId: string, event: Event): void {
    const providerId = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (!providerId) return;
    this.newRoomAgentRows.update((rows) =>
      rows.map((row) =>
        row.clientId === clientId
          ? {
              ...row,
              providerId,
              displayName: this.nextDraftDisplayName(row, rows, providerId, row.personaId),
              modelId: '',
              reasoningEffort: '',
            }
          : row,
      ),
    );
    this.refreshNewRoomProviderRecommendations();
  }

  setNewRoomAgentPersona(clientId: string, event: Event): void {
    const personaId = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (!personaId) return;
    this.newRoomAgentRows.update((rows) =>
      rows.map((row) =>
        row.clientId === clientId
          ? {
              ...row,
              personaId,
              displayName: this.nextDraftDisplayName(row, rows, row.providerId, personaId),
            }
          : row,
      ),
    );
    this.refreshNewRoomProviderRecommendations();
  }

  setNewRoomAgentName(clientId: string, event: Event): void {
    const displayName = event.target instanceof HTMLInputElement ? event.target.value : '';
    this.newRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, displayName } : row)),
    );
  }

  setNewRoomAgentModel(clientId: string, event: Event): void {
    const modelId = this.cleanAgentModelId(this.formControlValue(event));
    this.newRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, modelId } : row)),
    );
  }

  setNewRoomAgentReasoning(clientId: string, event: Event): void {
    const reasoningEffort = this.cleanAgentReasoningEffort(this.formControlValue(event));
    this.newRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, reasoningEffort } : row)),
    );
  }

  toggleNewRoomAgentAutoCompact(clientId: string, event: Event): void {
    const autoCompactEnabled =
      event.target instanceof HTMLInputElement ? event.target.checked : true;
    this.newRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, autoCompactEnabled } : row)),
    );
  }

  setNewRoomAgentAutoCompactPercent(clientId: string, event: Event): void {
    const autoCompactPercent = this.cleanAutoCompactPercent(this.formControlValue(event));
    this.newRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, autoCompactPercent } : row)),
    );
  }

  toggleNewRoomAgentYolo(clientId: string, event: Event): void {
    const yolo = event.target instanceof HTMLInputElement ? event.target.checked : false;
    this.newRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, yolo } : row)),
    );
  }

  setNewRoomLeadAgent(clientId: string): void {
    this.newRoomLeadClientId.set(this.newRoomLeadClientId() === clientId ? '' : clientId);
  }

  applyNewRoomProviderRecommendation(clientId: string, providerId: ProviderId): void {
    this.newRoomAgentRows.update((rows) =>
      rows.map((row) =>
        row.clientId === clientId
          ? {
              ...row,
              providerId,
              displayName: this.nextDraftDisplayName(row, rows, providerId, row.personaId),
              modelId: '',
              reasoningEffort: '',
            }
          : row,
      ),
    );
    this.refreshNewRoomProviderRecommendations();
  }

  addEditRoomAgent(): void {
    this.editRoomAgentRows.update((rows) => [
      ...rows,
      this.createDraftAgent(
        'claude',
        'generalist',
        false,
        this.suggestDraftAgentName('claude', rows),
      ),
    ]);
    this.refreshEditRoomProviderRecommendations();
  }

  removeEditRoomAgent(clientId: string): void {
    this.editRoomAgentRows.update((rows) => rows.filter((row) => row.clientId !== clientId));
    if (this.editRoomLeadClientId() === clientId) this.editRoomLeadClientId.set('');
    this.refreshEditRoomProviderRecommendations();
  }

  setEditRoomAgentProvider(clientId: string, event: Event): void {
    const providerId = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (!providerId) return;
    this.editRoomAgentRows.update((rows) =>
      rows.map((row) =>
        row.clientId === clientId
          ? {
              ...row,
              providerId,
              displayName: this.nextDraftDisplayName(row, rows, providerId, row.personaId),
              modelId: '',
              reasoningEffort: '',
            }
          : row,
      ),
    );
    this.refreshEditRoomProviderRecommendations();
  }

  setEditRoomAgentPersona(clientId: string, event: Event): void {
    const personaId = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (!personaId) return;
    this.editRoomAgentRows.update((rows) =>
      rows.map((row) =>
        row.clientId === clientId
          ? {
              ...row,
              personaId,
              displayName: this.nextDraftDisplayName(row, rows, row.providerId, personaId),
            }
          : row,
      ),
    );
    this.refreshEditRoomProviderRecommendations();
  }

  setEditRoomAgentName(clientId: string, event: Event): void {
    const displayName = event.target instanceof HTMLInputElement ? event.target.value : '';
    this.editRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, displayName } : row)),
    );
  }

  setEditRoomAgentModel(clientId: string, event: Event): void {
    const modelId = this.cleanAgentModelId(this.formControlValue(event));
    this.editRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, modelId } : row)),
    );
  }

  setEditRoomAgentReasoning(clientId: string, event: Event): void {
    const reasoningEffort = this.cleanAgentReasoningEffort(this.formControlValue(event));
    this.editRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, reasoningEffort } : row)),
    );
  }

  toggleEditRoomAgentAutoCompact(clientId: string, event: Event): void {
    const autoCompactEnabled =
      event.target instanceof HTMLInputElement ? event.target.checked : true;
    this.editRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, autoCompactEnabled } : row)),
    );
  }

  setEditRoomAgentAutoCompactPercent(clientId: string, event: Event): void {
    const autoCompactPercent = this.cleanAutoCompactPercent(this.formControlValue(event));
    this.editRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, autoCompactPercent } : row)),
    );
  }

  toggleEditRoomAgentYolo(clientId: string, event: Event): void {
    const yolo = event.target instanceof HTMLInputElement ? event.target.checked : false;
    this.editRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, yolo } : row)),
    );
  }

  setEditRoomLeadAgent(clientId: string): void {
    this.editRoomLeadClientId.set(this.editRoomLeadClientId() === clientId ? '' : clientId);
  }

  applyEditRoomProviderRecommendation(clientId: string, providerId: ProviderId): void {
    this.editRoomAgentRows.update((rows) =>
      rows.map((row) =>
        row.clientId === clientId
          ? {
              ...row,
              providerId,
              displayName: this.nextDraftDisplayName(row, rows, providerId, row.personaId),
              modelId: '',
              reasoningEffort: '',
            }
          : row,
      ),
    );
    this.refreshEditRoomProviderRecommendations();
  }

  draftAgentPreview(row: DraftRoomAgent): string {
    const name = this.cleanDisplayName(row.displayName);
    return name || this.draftDefaultDisplayName(row.providerId, row.personaId);
  }

  private providerRecommendationMap(
    response: ProviderScoreResponse,
  ): Record<string, ProviderScoreSlotResult | undefined> {
    return Object.fromEntries(response.slots.map((slot) => [slot.id, slot]));
  }

  private refreshProviderRecommendations(
    rows: DraftRoomAgent[],
    apply: (recommendations: Record<string, ProviderScoreSlotResult | undefined>) => void,
    sequence: number,
    currentSequence: () => number,
  ): void {
    if (rows.length === 0) {
      apply({});
      return;
    }
    this.api.agents
      .providerScore({
        slots: rows.map((row) => ({
          id: row.clientId,
          providerId: row.providerId,
          personaId: row.personaId,
        })),
      })
      .subscribe({
        next: (response) => {
          if (currentSequence() !== sequence) return;
          apply(this.providerRecommendationMap(response));
        },
        error: () => {
          if (currentSequence() === sequence) apply({});
        },
      });
  }

  private refreshNewRoomProviderRecommendations(): void {
    const sequence = ++this.newRoomProviderScoreRequest;
    this.refreshProviderRecommendations(
      this.newRoomAgentRows(),
      (recommendations) => this.newRoomProviderRecommendations.set(recommendations),
      sequence,
      () => this.newRoomProviderScoreRequest,
    );
  }

  private refreshEditRoomProviderRecommendations(): void {
    const sequence = ++this.editRoomProviderScoreRequest;
    this.refreshProviderRecommendations(
      this.editRoomAgentRows(),
      (recommendations) => this.editRoomProviderRecommendations.set(recommendations),
      sequence,
      () => this.editRoomProviderScoreRequest,
    );
  }

  createRoom(input: HTMLInputElement): void {
    const name = input.value.trim();
    const projectId = this.creatingMissionProjectId() ?? this.selectedProjectId();
    if (!name || !projectId) return;
    const validationError = this.newRoomAgentValidationError();
    if (validationError) {
      this.toasts.push({ message: validationError });
      return;
    }
    const agentProfiles = this.buildRoomAgentProfiles(this.newRoomAgentRows());
    const agents = agentProfiles.map((profile) => profile.id);
    if (agents.length === 0) return;
    const leadAgentId = this.draftLeadAgentId(
      this.newRoomAgentRows(),
      agentProfiles,
      this.newRoomLeadClientId(),
    );
    this.api.rooms
      .create({
        projectId,
        name,
        agents,
        yoloAgents: this.yoloAgentsFromDraftRows(this.newRoomAgentRows(), agentProfiles),
        leadAgentId,
        agentProfiles,
        humanName: this.authorName(),
      })
      .subscribe((room) => {
        this.rooms.update((rooms) => this.upsert(rooms, room));
        this.selectedProjectId.set(room.projectId);
        this.selectedRoomId.set(room.id);
        input.value = '';
        this.newRoomAgentRows.set(this.defaultDraftRoomAgents());
        this.newRoomLeadClientId.set('');
        this.newRoomProviderRecommendations.set({});
        this.creatingMissionProjectId.set(null);
        this.loadStateSnapshot();
      });
  }

  private createDraftAgent(
    providerId: ProviderId,
    personaId = 'generalist',
    yolo = false,
    displayName = '',
    agentId?: AgentId,
    modelId = '',
    reasoningEffort = '',
    autoCompactEnabled = true,
    autoCompactPercent = DEFAULT_AGENT_AUTO_COMPACT_PERCENT,
  ): DraftRoomAgent {
    this.draftAgentCounter += 1;
    return {
      clientId: `draft-${Date.now()}-${this.draftAgentCounter}`,
      ...(agentId ? { agentId } : {}),
      providerId,
      displayName: displayName || this.draftDefaultDisplayName(providerId, personaId),
      personaId,
      ...(modelId ? { modelId } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      autoCompactEnabled,
      autoCompactPercent: this.cleanAutoCompactPercent(String(autoCompactPercent)),
      yolo,
    };
  }

  private defaultDraftRoomAgents(): DraftRoomAgent[] {
    const rows: DraftRoomAgent[] = [];
    for (const agentId of this.agentChoices) {
      rows.push(
        this.createDraftAgent(
          agentId,
          'generalist',
          false,
          this.suggestDraftAgentName(agentId, rows),
        ),
      );
    }
    return rows;
  }

  private personaForId(personaId: string): AgentPersona {
    return (
      this.agentCatalog().personas.find((persona) => persona.id === personaId) ??
      DEFAULT_AGENT_CATALOG.personas[0]!
    );
  }

  private providerForId(providerId: ProviderId): AgentProviderCatalogItem {
    return (
      this.agentCatalog().providers.find((provider) => provider.id === providerId) ?? {
        id: providerId,
        displayName: providerId,
        summary: '',
      }
    );
  }

  private buildRoomAgentProfiles(rows: DraftRoomAgent[]): RoomAgentProfile[] {
    const seen = new Set<string>();
    const seenDisplayNames = new Set<string>();
    const humanName = this.cleanDisplayName(this.authorName()).toLowerCase();
    if (humanName) seenDisplayNames.add(humanName);
    return rows.map((row) => {
      const provider = this.display.providerForId(row.providerId);
      const persona = this.display.personaForId(row.personaId);
      const displayName = this.uniqueDisplayName(
        this.cleanDisplayName(row.displayName) ||
          (persona.id === 'generalist'
            ? provider.displayName
            : `${provider.displayName} ${persona.name}`),
        seenDisplayNames,
      );
      const base =
        row.agentId ||
        (persona.id === 'generalist'
          ? row.providerId
          : `${row.providerId}-${persona.id.replace(/-(engineer|reviewer|specialist|expert)$/i, '')}`);
      const id = this.uniqueAgentId(base, seen);
      return {
        id,
        providerId: row.providerId,
        displayName,
        personaId: persona.id,
        personaName: persona.name,
        personaSummary: persona.summary,
        ...(this.cleanAgentModelId(row.modelId ?? '')
          ? { modelId: this.cleanAgentModelId(row.modelId ?? '') }
          : {}),
        ...(this.cleanAgentReasoningEffort(row.reasoningEffort ?? '')
          ? { reasoningEffort: this.cleanAgentReasoningEffort(row.reasoningEffort ?? '') }
          : {}),
        autoCompactEnabled: row.autoCompactEnabled !== false,
        autoCompactPercent: this.cleanAutoCompactPercent(String(row.autoCompactPercent)),
      };
    });
  }

  private draftDefaultDisplayName(providerId: ProviderId, personaId: string): string {
    const provider = this.display.providerForId(providerId);
    const persona = this.display.personaForId(personaId);
    return persona.id === 'generalist'
      ? provider.displayName
      : `${provider.displayName} ${persona.name}`;
  }

  private nextDraftDisplayName(
    row: DraftRoomAgent,
    rows: DraftRoomAgent[],
    providerId: ProviderId,
    personaId: string,
  ): string {
    const current = this.cleanDisplayName(row.displayName);
    const currentDefault = this.draftDefaultDisplayName(row.providerId, row.personaId);
    if (current && current !== currentDefault) return row.displayName;
    return this.suggestDraftAgentName(providerId, rows, row.clientId, personaId);
  }

  private suggestDraftAgentName(
    providerId: ProviderId,
    rows: DraftRoomAgent[],
    excludeClientId?: string,
    personaId = 'generalist',
  ): string {
    const existing = new Set(
      rows
        .filter((row) => row.clientId !== excludeClientId)
        .map((row) => this.cleanDisplayName(row.displayName).toLowerCase())
        .filter(Boolean),
    );
    const humanName = this.cleanDisplayName(this.authorName()).toLowerCase();
    if (humanName) existing.add(humanName);
    const providerName = this.draftDefaultDisplayName(providerId, personaId);
    if (!existing.has(providerName.toLowerCase())) return providerName;
    for (const name of FRIENDLY_AGENT_NAMES) {
      if (!existing.has(name.toLowerCase())) return name;
    }
    const providerLabel = this.display.providerForId(providerId).displayName;
    let counter = 2;
    let candidate = this.duplicateDisplayName(providerLabel, counter);
    while (existing.has(candidate.toLowerCase())) {
      counter += 1;
      candidate = this.duplicateDisplayName(providerLabel, counter);
    }
    return candidate;
  }

  private cleanDisplayName(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  private formControlValue(event: Event): string {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
      return target.value;
    }
    return '';
  }

  private cleanAgentModelId(value: string): string {
    return value.replace(/\s+/g, '').trim().slice(0, 120);
  }

  private cleanAgentReasoningEffort(value: string): string {
    return value
      .replace(/\s+/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 32);
  }

  private cleanAutoCompactPercent(value: string): number {
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed)) return DEFAULT_AGENT_AUTO_COMPACT_PERCENT;
    return Math.max(1, Math.min(100, Math.floor(parsed)));
  }

  private routeHandleSlug(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  private duplicateDisplayName(base: string, counter: number): string {
    if (counter === 2) return `${base} Jr.`;
    if (counter === 3) return `${base} III`;
    return `${base} ${counter}`;
  }

  private draftAgentHandle(
    row: DraftRoomAgent,
    rows: DraftRoomAgent[],
    displayName: string,
  ): string {
    const displaySlug = this.routeHandleSlug(displayName);
    const sameProviderCount = rows.filter(
      (candidate) => candidate.providerId === row.providerId,
    ).length;
    if (displaySlug && (sameProviderCount <= 1 || displaySlug !== row.providerId))
      return displaySlug;
    return this.routeHandleSlug((row.agentId ?? displaySlug) || row.providerId) || row.providerId;
  }

  private participantValidationError(
    participants: Array<{ label: string; displayName: string; handle: string }>,
  ): string {
    const seenNames = new Map<string, string>();
    const seenHandles = new Map<string, string>();
    for (const participant of participants) {
      const name = this.cleanDisplayName(participant.displayName);
      if (!name) return `${participant.label} needs a display name`;
      const nameKey = name.toLowerCase();
      const existingName = seenNames.get(nameKey);
      if (existingName) {
        return `${participant.label} name "${name}" conflicts with ${existingName}`;
      }
      seenNames.set(nameKey, participant.label);

      const handleKey = this.routeHandleSlug(participant.handle || name);
      if (!handleKey) return `${participant.label} needs a routeable @handle`;
      const existingHandle = seenHandles.get(handleKey);
      if (existingHandle) {
        return `${participant.label} handle @${handleKey} conflicts with ${existingHandle}`;
      }
      seenHandles.set(handleKey, participant.label);
    }
    return '';
  }

  private agentDraftValidationError(rows: DraftRoomAgent[]): string {
    const participants: Array<{ label: string; displayName: string; handle: string }> = [];
    const humanName = this.cleanDisplayName(this.authorName());
    if (humanName) {
      participants.push({
        label: `human "${humanName}"`,
        displayName: humanName,
        handle: humanName,
      });
    }
    for (const row of rows) {
      const displayName =
        this.cleanDisplayName(row.displayName) ||
        this.draftDefaultDisplayName(row.providerId, row.personaId);
      participants.push({
        label: `agent "${displayName}"`,
        displayName,
        handle: this.draftAgentHandle(row, rows, displayName),
      });
    }
    return this.participantValidationError(participants);
  }

  private authorNameValidationError(name: string): string {
    const room = this.selectedRoom();
    if (!room) return '';
    const participants: Array<{ label: string; displayName: string; handle: string }> = [
      { label: `human "${name}"`, displayName: name, handle: name },
    ];
    const providerCounts = new Map<ProviderId, number>();
    for (const profile of room.agentProfiles) {
      providerCounts.set(profile.providerId, (providerCounts.get(profile.providerId) ?? 0) + 1);
    }
    for (const profile of room.agentProfiles) {
      participants.push({
        label: `agent "${profile.displayName}"`,
        displayName: profile.displayName,
        handle: this.mentionHandleForProfile(profile, providerCounts),
      });
    }
    return this.participantValidationError(participants);
  }

  private uniqueDisplayName(base: string, seen: Set<string>): string {
    const cleanBase = this.cleanDisplayName(base) || 'Agent';
    let candidate = cleanBase;
    let counter = 2;
    while (seen.has(candidate.toLowerCase())) {
      candidate = this.duplicateDisplayName(cleanBase, counter);
      counter += 1;
    }
    seen.add(candidate.toLowerCase());
    return candidate;
  }

  private uniqueAgentId(base: string, seen: Set<string>): AgentId {
    const cleanBase =
      base
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'agent';
    let candidate = cleanBase;
    let counter = 2;
    while (seen.has(candidate)) {
      candidate = `${cleanBase}-${counter}`;
      counter += 1;
    }
    seen.add(candidate);
    return candidate;
  }

  private yoloAgentsFromDraftRows(rows: DraftRoomAgent[], profiles: RoomAgentProfile[]): AgentId[] {
    return rows
      .map((row, index) => (row.yolo ? profiles[index]?.id : ''))
      .filter((agentId): agentId is AgentId => Boolean(agentId));
  }

  private draftLeadAgentId(
    rows: DraftRoomAgent[],
    profiles: RoomAgentProfile[],
    leadClientId: string,
  ): AgentId | null {
    if (!leadClientId) return null;
    const index = rows.findIndex((row) => row.clientId === leadClientId);
    return profiles[index]?.id ?? null;
  }

  private draftRowsFromRoom(room: Room): DraftRoomAgent[] {
    return room.agents.map((agentId) => {
      const profile = this.display.roomAgentProfile(room, agentId);
      return this.createDraftAgent(
        profile.providerId,
        profile.personaId || 'generalist',
        room.yoloAgents.includes(agentId),
        profile.displayName,
        agentId,
        profile.modelId ?? '',
        profile.reasoningEffort ?? '',
        profile.autoCompactEnabled ?? true,
        profile.autoCompactPercent ?? DEFAULT_AGENT_AUTO_COMPACT_PERCENT,
      );
    });
  }

  deleteRoom(room: Room, event: Event): void {
    event.preventDefault();
    event.stopPropagation();

    if (this.deletingRoomId() !== room.id) {
      this.deletingRoomId.set(room.id);
      if (this.deleteConfirmTimer !== null) window.clearTimeout(this.deleteConfirmTimer);
      this.deleteConfirmTimer = window.setTimeout(() => {
        if (this.deletingRoomId() === room.id) this.deletingRoomId.set(null);
        this.deleteConfirmTimer = null;
      }, 2500);
      return;
    }

    if (this.deleteConfirmTimer !== null) {
      window.clearTimeout(this.deleteConfirmTimer);
      this.deleteConfirmTimer = null;
    }
    this.deletingRoomId.set(null);
    this.api.rooms.delete(room.id).subscribe(() => this.handleRoomDeleted(room.id));
  }

  setAuthor(input: HTMLInputElement): void {
    const name = input.value.trim() || 'human';
    const validationError = this.authorNameValidationError(name);
    if (validationError) {
      this.toasts.push({ message: validationError });
      input.value = this.authorName();
      return;
    }
    this.authorName.set(name);
    input.value = name;
    localStorage.setItem('fireside.author', name);
  }

  openEditAgents(): void {
    const room = this.selectedRoom();
    if (!room) return;
    const rows = this.draftRowsFromRoom(room);
    this.editRoomAgentRows.set(rows);
    this.editRoomLeadClientId.set(
      rows.find((row) => row.agentId === room.leadAgentId)?.clientId ?? '',
    );
    this.editingAgents.set(true);
    this.refreshEditRoomProviderRecommendations();
  }

  cancelEditAgents(): void {
    this.editingAgents.set(false);
    this.editRoomAgentRows.set([]);
    this.editRoomLeadClientId.set('');
    this.editRoomProviderRecommendations.set({});
  }

  saveEditAgents(): void {
    const room = this.selectedRoom();
    if (!room) return;
    const validationError = this.editRoomAgentValidationError();
    if (validationError) {
      this.toasts.push({ message: validationError });
      return;
    }
    const agentProfiles = this.buildRoomAgentProfiles(this.editRoomAgentRows());
    const agents = agentProfiles.map((profile) => profile.id);
    const leadAgentId = this.draftLeadAgentId(
      this.editRoomAgentRows(),
      agentProfiles,
      this.editRoomLeadClientId(),
    );
    this.api.rooms
      .update(room.id, {
        agents,
        yoloAgents: this.yoloAgentsFromDraftRows(this.editRoomAgentRows(), agentProfiles),
        leadAgentId,
        agentProfiles,
        humanName: this.authorName(),
      })
      .subscribe((updated) => {
        this.rooms.update((rooms) => this.upsert(rooms, updated));
        this.loadStateSnapshot();
        this.editingAgents.set(false);
        this.editRoomLeadClientId.set('');
        this.editRoomProviderRecommendations.set({});
      });
  }

  openCompactAgent(agentId: AgentId, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!this.display.canCompactAgent(agentId)) return;
    this.compactError.set('');
    this.compactAgent.set(agentId);
  }

  closeCompactAgent(): void {
    if (this.compactingAgent()) return;
    this.compactAgent.set(null);
    this.compactError.set('');
  }

  startCompactAgent(agentId: AgentId): void {
    const roomId = this.selectedRoomId();
    if (!roomId || !this.display.canCompactAgent(agentId) || this.display.isAgentRunning(agentId))
      return;
    this.compactError.set('');
    this.compactingAgent.set(agentId);
    this.api.agents.compact(roomId, agentId, this.authorName()).subscribe({
      next: (run) => {
        this.runs.update((runs) => this.upsert(runs, run));
        this.compactingAgent.set(null);
        this.closeCompactAgent();
      },
      error: (err: unknown) => {
        this.compactingAgent.set(null);
        this.compactError.set(this.compactErrorText(err));
      },
    });
  }

  private compactErrorText(err: unknown): string {
    if (err && typeof err === 'object') {
      const error = 'error' in err ? (err as { error?: unknown }).error : undefined;
      if (error && typeof error === 'object' && 'error' in error) {
        const message = (error as { error?: unknown }).error;
        if (typeof message === 'string' && message.trim()) return message;
      }
      if ('message' in err) {
        const message = (err as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) return message;
      }
    }
    return 'failed to start compaction';
  }

  private loadRooms(): void {
    this.api.rooms.list().subscribe((rooms) => {
      this.rooms.set(rooms);
      const selectedRoomId = this.selectedRoomId();
      const selectedRoom = selectedRoomId ? rooms.find((room) => room.id === selectedRoomId) : null;
      if (selectedRoom) {
        this.selectedProjectId.set(selectedRoom.projectId);
        return;
      }
      const selectedProjectId = this.selectedProjectId();
      if (
        selectedProjectId &&
        this.projects().some((project) => project.id === selectedProjectId)
      ) {
        this.selectedRoomId.set(null);
        this.clearRoomState();
        return;
      }
      const firstProjectId = this.projects()[0]?.id ?? rooms[0]?.projectId ?? null;
      this.selectedProjectId.set(firstProjectId);
      this.selectedRoomId.set(null);
      this.clearRoomState();
    });
  }

  private loadProjects(): void {
    this.api.projects.list().subscribe((projects) => {
      this.projects.set(projects);
      if (!this.selectedProjectId() && projects[0]) {
        this.selectedProjectId.set(projects[0].id);
      }
    });
  }

  private loadAgentCatalog(): void {
    this.api.agents.catalog().subscribe({
      next: (catalog) => {
        if (catalog.providers.length > 0 && catalog.personas.length > 0) {
          this.agentCatalog.set(catalog);
          if (this.creatingMissionProjectId()) this.refreshNewRoomProviderRecommendations();
          if (this.editingAgents()) this.refreshEditRoomProviderRecommendations();
        }
      },
      error: () => {
        this.agentCatalog.set(DEFAULT_AGENT_CATALOG);
      },
    });
  }

  private loadStateSnapshot(): void {
    this.api.state.get().subscribe((snapshot) => this.stateSnapshot.set(snapshot));
  }

  private loadRoomDetail(roomId: string): void {
    this.api.messages.list(roomId).subscribe((messages) => {
      this.messages.set(messages);
      this.scheduleChatScrollToBottom();
    });
    this.api.permissions
      .list(roomId)
      .subscribe((requests) => this.permissionRequests.set(requests));
    this.api.tasks.list(roomId).subscribe((tasks) => {
      this.applyTaskList(roomId, tasks);
    });
    this.api.runs.list(roomId).subscribe((runs) => this.runs.set(runs));
    this.api.runs.actions(roomId).subscribe((actions) => this.runActions.set(actions));
    this.loadAutonomyDiagnostics(roomId);
    this.loadArtifacts(roomId);
  }

  composerPlaceholder(): string {
    return this.isRoomWorking() ? 'queue context for the active agent run' : 'message the room';
  }

  stopActiveRuns(): void {
    const roomId = this.selectedRoomId();
    if (!roomId) return;
    this.ws.stopRuns(roomId, this.authorName());
  }

  attachFileToMessage(input: HTMLTextAreaElement): void {
    const roomId = this.selectedRoomId();
    if (!roomId) return;
    const initialPath = this.activeTask()?.repoPath ?? '';
    this.api.system.pickFile(initialPath).subscribe(({ path }) => {
      if (!path) return;
      this.api.artifacts.attachFixture(roomId, path).subscribe((fixture) => {
        this.insertIntoInput(input, `@file("${fixture.storedPath}")`);
        this.loadArtifacts(roomId);
      });
    });
  }

  decidePermission(request: PermissionRequest, decision: 'approved' | 'denied'): void {
    this.api.permissions
      .decide(request.roomId, request.id, decision, this.authorName())
      .subscribe((updated) => {
        this.permissionRequests.update((requests) => this.upsert(requests, updated));
      });
  }

  openRunDetail(runId: string, refresh = false): void {
    const roomId = this.selectedRoomId();
    if (!roomId) return;
    this.openRunDetailId.set(runId);
    if (!refresh) {
      this.runDetail.set(null);
      this.runDetailError.set('');
      this.runDetailLoading.set(true);
    }
    this.api.runs.detail(roomId, runId).subscribe({
      next: (detail) => {
        if (this.openRunDetailId() !== runId) return;
        this.runDetail.set(detail);
        this.runDetailError.set('');
        this.runDetailLoading.set(false);
      },
      error: (err: unknown) => {
        if (this.openRunDetailId() !== runId) return;
        this.runDetailError.set(err instanceof Error ? err.message : 'failed to load run detail');
        this.runDetailLoading.set(false);
      },
    });
  }

  closeRunDetail(): void {
    this.openRunDetailId.set(null);
    this.runDetail.set(null);
    this.runDetailError.set('');
    this.runDetailLoading.set(false);
  }

  onRunDetailStopRequested(runId: string): void {
    const roomId = this.store.selectedRoomId();
    if (!roomId) return;
    this.api.runs.stop(roomId, runId, this.authorName()).subscribe({
      next: (updated) => {
        this.toasts.push({ message: `stopped @${updated.agentId}'s active run` });
        // Refresh the modal so the UI reflects the canceled state immediately.
        if (this.openRunDetailId() === runId) this.openRunDetail(runId, true);
      },
      error: (err: unknown) => {
        const message = err instanceof Error ? err.message : 'failed to stop run';
        this.toasts.push({ message: `stop failed: ${message}` });
      },
    });
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
      this.runActions()
        .filter((action) => action.runId === runId)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    );
  }

  private formatDurationMs(ms: number): string {
    return fmtDurationMs(ms);
  }

  private runTurnLabel(run: AgentRun): string {
    if (run.maxTurns && run.maxTurns > 1 && run.continuationTurn) {
      return `${run.continuationTurn}/${run.maxTurns}`;
    }
    return run.continuationTurn ? String(run.continuationTurn) : '1';
  }

  opsToneClass(tone: OpsTone): string {
    return `is-${tone}`;
  }

  openAttentionItem(item: AttentionItem): void {
    if (item.runId) this.openRunDetail(item.runId);
  }

  copyRunSession(run: AgentRun, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!run.cliSessionId) return;
    void navigator.clipboard?.writeText(run.cliSessionId);
  }

  projectRoomSnapshot(roomId: string): StatusSnapshotRoom | null {
    return this.stateSnapshot()?.rooms.find((room) => room.id === roomId) ?? null;
  }

  projectRoomMeta(room: Room): string {
    const snapshot = this.projectRoomSnapshot(room.id);
    const active = snapshot?.counts.activeMissions ?? 0;
    const running = snapshot?.counts.runs.running ?? 0;
    const blocked = snapshot?.counts.tasks.blocked ?? 0;
    const parts = [
      `${room.agents.length} agent${room.agents.length === 1 ? '' : 's'}`,
      `${active} active`,
      `${running} running`,
    ];
    if (blocked) parts.push(`${blocked} blocked`);
    return parts.join(' / ');
  }

  projectRoomSignal(room: Room): string {
    const snapshot = this.projectRoomSnapshot(room.id);
    if (!snapshot) return 'no mission telemetry yet';
    const task = snapshot.activeMissions[0];
    if (task) return `${task.status}: ${task.title}`;
    if (snapshot.lastAction) return this.humanizedRunAction(snapshot.lastAction, 120);
    if (snapshot.lastRun)
      return this.runLifecycleSignal(snapshot.lastRun) || snapshot.lastRun.status;
    return 'no active mission';
  }

  private buildProjectDashboardSummary(rooms: StatusSnapshotRoom[]) {
    return rooms.reduce(
      (summary, room) => {
        summary.missions += room.counts.activeMissions;
        summary.running += room.counts.runs.running;
        summary.blocked += room.counts.tasks.blocked;
        summary.agents += room.agents.length;
        return summary;
      },
      { missions: 0, running: 0, blocked: 0, agents: 0 },
    );
  }

  selectMissionView(view: MissionViewId): void {
    this.selectedMissionView.set(view);
  }

  focusMissionGraphItem(item: TaskChecklistItem): void {
    this.store.selectedMissionAction.set('execute');
    this.store.missionActionChecklistItemId.set(item.id);
    this.taskInspectorItemId.set(item.id);
  }

  selectMissionActionItem(itemId: string): void {
    this.store.selectedMissionAction.set('execute');
    this.store.missionActionChecklistItemId.set(itemId);
    this.taskInspectorItemId.set(itemId);
  }

  dispatchParallelBatch(): void {
    const roomId = this.selectedRoomId();
    const parallelism = this.taskControl()?.parallelism;
    const batch = parallelism?.nextBatch ?? [];
    if (!roomId || batch.length === 0) return;

    const owners = [
      ...new Set(
        batch.map((item) => item.ownerAgentId).filter((owner): owner is string => !!owner),
      ),
    ];
    const address = owners.length ? owners.map((owner) => `@${owner}`).join(' ') : 'Team';
    const batchLines = batch.map((item) => {
      const owner = item.ownerAgentId ? ` owner: ${this.display.name(item.ownerAgentId)}.` : '';
      return `- ${item.title} (id: ${item.itemId}).${owner} ${item.reason}`;
    });
    const prompt = [
      `${address} execute this Mission Control parallel batch.`,
      '',
      `Phase: ${parallelism?.phaseTitle ?? 'current phase'}`,
      ...batchLines,
      '',
      'Each owner should take only their listed lane, update the checklist before/while working, coordinate only on conflicts or blockers, and post visible status plus hidden Mission Control updates when the lane completes or blocks.',
    ].join('\n');
    this.selectTab('chat');
    this.ws.postMessage(roomId, this.authorName(), prompt);
  }

  closeTaskInspector(): void {
    this.taskInspectorItemId.set(null);
  }

  shortTaskId(id: string): string {
    return id.length > 10 ? id.slice(0, 10) : id;
  }

  onRoadmapPhaseAdded(payload: { title: string; gate: string; status: TaskPhaseStatus }): void {
    const roomId = this.selectedRoomId();
    const task = this.activeTask();
    if (!roomId || !task) return;
    this.api.tasks
      .createPhase(roomId, task.id, {
        planId: this.taskControl()?.activePlan?.id ?? null,
        title: payload.title,
        gate: payload.gate,
        status: payload.status,
        sortOrder: (this.taskControl()?.phases.length ?? 0) + 1,
      })
      .subscribe(() => this.loadTaskControl(roomId, task.id));
  }

  copyTaskId(id: string, event: Event): void {
    event.stopPropagation();
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(id).catch((err) => {
        console.warn('Failed to copy task id', err);
      });
    }
  }

  taskInspectorPhaseLabel(item: TaskChecklistItem): string {
    if (!item.phaseId) return 'unphased';
    return (
      this.taskControl()?.phases.find((phase) => phase.id === item.phaseId)?.title ?? item.phaseId
    );
  }

  taskScopeContractLabel(item: TaskChecklistItem): string {
    const expectedTouches = item.expectedTouches ?? [];
    const touches =
      expectedTouches.length === 0
        ? 'no touch map'
        : `${expectedTouches.length} expected touch${expectedTouches.length === 1 ? '' : 'es'}`;
    const group = item.conflictGroup ? `group ${item.conflictGroup}` : 'no group';
    return `${item.parallelism ?? 'parallel-safe'} / ${touches} / ${group}`;
  }

  taskExpectedTouchesLabel(item: TaskChecklistItem): string {
    const expectedTouches = item.expectedTouches ?? [];
    return expectedTouches.length ? expectedTouches.join(', ') : 'none recorded';
  }

  copyChecklistItemId(item: TaskChecklistItem): void {
    void navigator.clipboard?.writeText(item.id);
  }

  copyTaskInspectorReference(card: MissionGraphCard): void {
    void navigator.clipboard?.writeText(this.graph.taskInspectorReference(card));
  }

  copyTaskInspectorMissionBlock(card: MissionGraphCard): void {
    void navigator.clipboard?.writeText(this.graph.taskInspectorMissionBlock(card));
  }

  changeChecklistStatus(item: TaskChecklistItem, event: Event): void {
    const status =
      event.target instanceof HTMLSelectElement
        ? (event.target.value as TaskChecklistStatus)
        : item.status;
    this.updateChecklistItemFromUi(item, {
      status,
      statusNote: `${this.authorName()} set status to ${status}.`,
      ...(status !== 'blocked' ? { blockedReason: '', councilRequired: false } : {}),
    });
  }

  markChecklistDone(item: TaskChecklistItem): void {
    this.updateChecklistItemFromUi(item, {
      status: 'done',
      statusNote: `${this.authorName()} marked this work item complete.`,
      blockedReason: '',
      councilRequired: false,
    });
  }

  reopenChecklistItem(item: TaskChecklistItem): void {
    this.updateChecklistItemFromUi(item, {
      status: 'open',
      statusNote: `${this.authorName()} reopened this work item.`,
      blockedReason: '',
      councilRequired: false,
    });
  }

  assignChecklistOwner(item: TaskChecklistItem, event: Event): void {
    const ownerAgentId =
      event.target instanceof HTMLSelectElement ? event.target.value : (item.ownerAgentId ?? '');
    if (ownerAgentId === (item.ownerAgentId ?? '')) return;
    this.updateChecklistItemFromUi(item, {
      ownerAgentId,
      statusNote: ownerAgentId
        ? `${this.authorName()} assigned this item to ${this.display.name(ownerAgentId)}.`
        : `${this.authorName()} unassigned this item.`,
    });
  }

  checklistNotes(itemId: string): TaskChecklistNote[] {
    return (this.taskControl()?.checklistNotes ?? []).filter((note) => note.itemId === itemId);
  }

  saveTaskInspectorNotes(
    item: TaskChecklistItem,
    statusNoteInput: HTMLTextAreaElement,
    blockedReasonInput: HTMLTextAreaElement,
    councilInput: HTMLInputElement,
  ): void {
    this.updateChecklistItemFromUi(item, {
      statusNote: statusNoteInput.value.trim(),
      blockedReason: blockedReasonInput.value.trim(),
      councilRequired: councilInput.checked,
      status: blockedReasonInput.value.trim() ? 'blocked' : item.status,
    });
  }

  private updateChecklistItemFromUi(
    item: TaskChecklistItem,
    patch: Partial<TaskChecklistItem>,
  ): void {
    const roomId = this.selectedRoomId();
    const task = this.activeTask();
    if (!roomId || !task) return;
    this.api.tasks
      .updateChecklistItem(roomId, task.id, item.id, patch)
      .subscribe(() => this.loadTaskControl(roomId, task.id));
  }

  openMissionGraphCardRun(card: MissionGraphCard, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    const run = card.activeRun ?? card.latestRun;
    if (!run) return;
    this.openRunDetail(run.id);
  }

  elapsedLabel(startedAt?: number, completedAt?: number | null): string {
    return fmtElapsedLabel(startedAt, completedAt, this.now());
  }

  targetStatusText(item: PermissionRequest | AgentRun): string {
    const kind = 'targetKind' in item ? item.targetKind : item.permissionTargetKind || 'unknown';
    const exists = 'targetExists' in item ? item.targetExists : item.permissionTargetExists;
    if (exists === true) return `exists (${kind})`;
    if (exists === false) return `missing (${kind})`;
    return kind || 'unknown';
  }

  formatBytes(bytes: number | undefined): string {
    return fmtBytes(bytes);
  }

  formatShortTime(timestamp: number | undefined): string {
    return fmtShortTime(timestamp);
  }

  formatRelativeAgo(timestamp: number | undefined): string {
    return fmtRelativeAgo(timestamp, this.now());
  }

  pad2(value: number): string {
    return fmtPad2(value);
  }

  formatDateTime(timestamp: number | undefined | null): string {
    return fmtDateTime(timestamp);
  }

  oneLine(text: string | undefined | null, maxChars = 220): string {
    return fmtOneLine(text, maxChars);
  }

  capabilityText(capabilities: string[] | undefined): string {
    return capabilities && capabilities.length > 0 ? capabilities.join(', ') : 'none';
  }

  permissionModeLabel(mode: string | undefined): string {
    return permModeLabel(mode);
  }

  permissionRequestLabel(request: PermissionRequest): string {
    return permRequestLabel(request);
  }

  latestActionForRun(runId: string): AgentRunAction | null {
    return (
      this.runActions().find(
        (action) => action.runId === runId && this.isVisibleRunAction(action),
      ) ?? null
    );
  }

  runMeta(run: AgentRun): string {
    const tokens = run.estimatedPromptTokens ? `${run.estimatedPromptTokens}t` : 'unknown tokens';
    const mode = run.permissionMode ? this.permissionModeLabel(run.permissionMode) : 'mode unknown';
    const attempt = run.attempt && run.attempt > 1 ? ` / attempt ${run.attempt}` : '';
    const turn =
      run.maxTurns && run.maxTurns > 1 && run.continuationTurn
        ? ` / turn ${run.continuationTurn}/${run.maxTurns}`
        : '';
    return `${this.elapsedLabel(run.startedAt, run.completedAt)} / ${tokens} / ${mode}${attempt}${turn}`;
  }

  ringCtxClick(agentId: AgentId, event: Event): void {
    if (!this.display.canCompactAgent(agentId)) return;
    if (this.display.isAgentRunning(agentId) || this.compactingAgent() === agentId) return;
    this.openCompactAgent(agentId, event);
  }

  recheckAgentQuota(agentId: AgentId): void {
    const providerId = this.display.agentProviderId(agentId);
    const providerLabel = this.display.providerForId(providerId).displayName || providerId;
    this.toasts.push({ message: `rechecking ${providerLabel} quota…` });
    this.api.providers.recheckQuota(providerId).subscribe({
      next: (result) => {
        if (result.ok) {
          const cleared = result.cleared || 0;
          this.toasts.push({
            message:
              cleared > 0
                ? `${providerLabel} quota cleared (${cleared} block${cleared === 1 ? '' : 's'} removed)`
                : `${providerLabel} quota looks fresh — no blocks to clear`,
          });
        } else {
          const detail = result.detail || result.status || 'still exhausted';
          this.toasts.push({ message: `${providerLabel} quota ${detail}` });
        }
      },
      error: (err: unknown) => {
        const message = err instanceof Error ? err.message : 'recheck failed';
        this.toasts.push({ message: `${providerLabel} quota recheck failed: ${message}` });
      },
    });
  }

  private parseActivityDetail(
    detail: string | undefined,
  ): { title: string; status: string } | null {
    return parseActivityDetail(detail);
  }

  private activityTaskTitle(detail: string | undefined): string {
    return activityTaskTitle(detail);
  }

  private isActivityRunAction(action: AgentRunAction): boolean {
    return (
      action.label === 'YOLO lane assigned' ||
      action.label === 'retry scheduled' ||
      action.label === 'mission phase auto-advance' ||
      /^mission (created|plan (?:create|update)|phase (?:create|update)|task (?:create|update))$/i.test(
        action.label,
      )
    );
  }

  private isAutonomyDiagnosticAction(action: AgentRunAction): boolean {
    return (
      action.label === 'turn outcome recorded' ||
      action.label === 'mission liveness decision' ||
      action.label === 'mission work routing decision' ||
      action.label.startsWith('mission ') ||
      action.label.includes('routing decision')
    );
  }

  private isActivityRunUpdate(run: AgentRun): boolean {
    if (run.lifecycleState === 'stalled') return true;
    if (run.status === 'running') return false;
    return this.runActions().some(
      (action) => action.runId === run.id && action.label === 'YOLO lane assigned',
    );
  }

  runActionSignal(run: AgentRun): string {
    const action = this.latestActionForRun(run.id);
    if (!action)
      return (
        this.runLifecycleSignal(run) ||
        run.lastSignal ||
        run.summary ||
        'waiting for first broker signal'
      );
    return this.humanizedRunAction(action, 120);
  }

  humanizedRunAction(action: AgentRunAction, maxChars = 180): string {
    const label = action.label.trim();
    const normalized = label.toLowerCase();
    const detail = this.actionDetailText(action, maxChars);

    if (normalized === 'yolo lane assigned') {
      return `lane assigned: ${this.activityTaskTitle(action.detail) || detail || 'checklist work'}`;
    }
    if (normalized === 'retry scheduled') {
      return detail ? `retry scheduled: ${detail}` : 'retry scheduled';
    }
    if (normalized === 'agent process completed') {
      return detail ? `provider process completed (${detail})` : 'provider process completed';
    }
    if (/mission phase auto-advance/i.test(label)) {
      return detail ? `phase gate advanced: ${detail}` : 'phase gate advanced';
    }
    if (/^mission task (create|update)$/i.test(label)) {
      const parsed = this.parseActivityDetail(action.detail);
      return parsed
        ? `checklist ${parsed.status || 'updated'}: ${parsed.title}`
        : 'checklist updated';
    }
    if (/^mission phase (create|update)$/i.test(label)) {
      const parsed = this.parseActivityDetail(action.detail);
      return parsed ? `phase ${parsed.status || 'updated'}: ${parsed.title}` : 'phase gate updated';
    }
    if (/^mission plan (create|update)$/i.test(label)) {
      const parsed = this.parseActivityDetail(action.detail);
      return parsed ? `plan ${parsed.status || 'updated'}: ${parsed.title}` : 'plan updated';
    }
    if (/assistant text streaming/i.test(label)) {
      return detail ? `drafting: ${detail}` : 'drafting response';
    }
    if (/assistant message ready|assistant text|agent_message/i.test(label)) {
      return detail ? `message ready: ${detail}` : 'message ready';
    }
    if (/command|execution|exec/i.test(label)) {
      return detail ? `command: ${detail}` : 'command running';
    }
    if (/tool/i.test(label)) {
      return detail ? `tool use: ${detail}` : 'tool use';
    }
    if (/permission/i.test(label)) {
      return detail ? `${label}: ${detail}` : label;
    }
    return detail ? `${label}: ${detail}` : label;
  }

  runLifecycleSignal(run: AgentRun): string {
    if (!run.lifecycleState) return '';
    const state = run.lifecycleState.replace(/_/g, ' ');
    const reason = run.lifecycleReason ? ` / ${run.lifecycleReason}` : '';
    if (run.lifecycleState === 'retry_queued' && run.retryAfter) {
      return `${state} / retry after ${this.elapsedLabel(Date.now(), run.retryAfter)}`;
    }
    if (run.lastSignalAt && run.status === 'running') {
      return `${state} / provider signal ${this.elapsedLabel(run.lastSignalAt, Date.now())} ago${reason}`;
    }
    return `${state}${reason}`;
  }

  runDraftSignal(run: AgentRun): string {
    const action = this.runActions().find(
      (candidate) =>
        candidate.runId === run.id &&
        candidate.kind === 'message' &&
        /assistant (?:message|text)/i.test(candidate.label) &&
        Boolean(this.actionDetailText(candidate, 1)),
    );
    return action ? this.actionDetailText(action, 180) : '';
  }

  isRunStale(run: AgentRun): boolean {
    return this.canDismissRun(run);
  }

  canDismissRun(run: AgentRun): boolean {
    if (run.status !== 'running') return false;
    const action = this.latestActionForRun(run.id);
    const referenceTime =
      run.lastSignalAt || action?.createdAt || run.lifecycleUpdatedAt || run.startedAt || 0;
    if (!referenceTime) return false;
    return Date.now() - referenceTime >= 5 * 60 * 1000;
  }

  dismissRun(run: AgentRun, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const roomId = this.selectedRoomId();
    if (!roomId) return;
    this.api.runs.dismiss(roomId, run.id, this.authorName()).subscribe((updated) => {
      this.runs.update((runs) => this.upsert(runs, updated));
      if (this.openRunDetailId() === run.id) this.openRunDetail(run.id, true);
    });
  }

  onSetupMissionsChanged(event: MissionsChangedEvent): void {
    const roomId = this.selectedRoomId();
    if (!roomId) return;
    this.refreshTasks(roomId, event.preferredTaskId);
  }

  reloadActiveTaskControl(): void {
    const roomId = this.selectedRoomId();
    const task = this.activeTask();
    if (!roomId || !task) return;
    this.loadTaskControl(roomId, task.id);
  }

  // Bound function refs for child components that need to call back into App
  // resolution helpers (agent display, avatar, ownership, plan label). Will
  // move to a shared service once those waves land; for now this keeps the
  // child templates clean.
  readonly planLabelFn = this.planLabel.bind(this);
  readonly permissionRequestLabelFn = this.permissionRequestLabel.bind(this);
  readonly capabilityTextFn = this.capabilityText.bind(this);
  readonly targetStatusTextFn = this.targetStatusText.bind(this);
  readonly elapsedLabelFn = this.elapsedLabel.bind(this);
  readonly runMetaFn = this.runMeta.bind(this);
  readonly runActionSignalFn = this.runActionSignal.bind(this);
  readonly permissionModeLabelFn = this.permissionModeLabel.bind(this);
  readonly formatDateTimeFn = this.formatDateTime.bind(this);
  readonly formatShortTimeFn = this.formatShortTime.bind(this);
  readonly oneLineFn = this.oneLine.bind(this);
  readonly visibleDiagnosticSignalsFn = this.visibleDiagnosticSignals.bind(this);
  readonly hiddenDiagnosticSignalCountFn = this.hiddenDiagnosticSignalCount.bind(this);
  readonly lowSignalDiagnosticSignalCountFn = this.lowSignalDiagnosticSignalCount.bind(this);
  readonly providerSignalDetailFn = this.providerSignalDetail.bind(this);
  readonly visibleRunActionsFn = this.visibleRunActions.bind(this);
  readonly hiddenRunActionCountFn = this.hiddenRunActionCount.bind(this);
  readonly lowSignalRunActionCountFn = this.lowSignalRunActionCount.bind(this);
  readonly runActionDetailFn = this.runActionDetail.bind(this);
  readonly taskInspectorPhaseLabelFn = this.taskInspectorPhaseLabel.bind(this);
  readonly taskScopeContractLabelFn = this.taskScopeContractLabel.bind(this);
  readonly taskExpectedTouchesLabelFn = this.taskExpectedTouchesLabel.bind(this);
  readonly checklistNotesFn = this.checklistNotes.bind(this);
  readonly formatBytesFn = this.formatBytes.bind(this);

  onPermissionDecided(payload: {
    request: PermissionRequest;
    decision: 'approved' | 'denied';
  }): void {
    this.decidePermission(payload.request, payload.decision);
  }

  yoloTurnCounterText(): string {
    const status = this.yoloStatus();
    if (!status) return 'YOLO ready';
    if (!status.active) return `${status.maxTotalReplies ?? 100} turns ready`;
    const max = Math.max(1, status.maxTotalReplies ?? 100);
    const remaining = Math.max(0, status.remainingReplies ?? max - (status.totalRepliesUsed ?? 0));
    return `${remaining}/${max} turns remaining`;
  }

  yoloTurnPercentRemaining(): number {
    const status = this.yoloStatus();
    if (!status?.active) return 100;
    const max = Math.max(1, status.maxTotalReplies ?? 100);
    const remaining = Math.max(0, status.remainingReplies ?? max - (status.totalRepliesUsed ?? 0));
    return Math.max(0, Math.min(100, Math.round((remaining / max) * 100)));
  }

  yoloTurnTone(): 'ready' | 'green' | 'yellow' | 'red' {
    const status = this.yoloStatus();
    if (!status?.active) return 'ready';
    const percent = this.yoloTurnPercentRemaining();
    if (percent <= 20) return 'red';
    if (percent <= 50) return 'yellow';
    return 'green';
  }

  addYoloTurns(): void {
    const roomId = this.selectedRoomId();
    const status = this.yoloStatus();
    if (!roomId || !status?.active) return;
    const defaultTurns = Math.max(1, status.maxTotalReplies ?? 100);
    const raw = window.prompt('Add how many YOLO turns?', String(defaultTurns));
    if (raw === null) return;
    const turns = Math.floor(Number(raw));
    if (!Number.isFinite(turns) || turns < 1) return;
    this.ws.addYoloTurns(roomId, this.authorName(), turns);
  }

  planLabel(planId: string | null | undefined): string {
    if (!planId) return '';
    const plan = this.taskControl()?.plans.find((candidate) => candidate.id === planId);
    return plan?.title ?? planId;
  }

  private loadTaskControl(roomId: string, taskId: string): void {
    this.api.tasks.control(roomId, taskId).subscribe((control) => {
      this.taskControl.set(control);
    });
  }

  private refreshTasks(roomId: string, preferredTaskId?: string | null): void {
    this.api.tasks
      .list(roomId)
      .subscribe((tasks) => this.applyTaskList(roomId, tasks, preferredTaskId));
  }

  private applyTaskList(roomId: string, tasks: Task[], preferredTaskId?: string | null): void {
    this.tasks.set(tasks);
    const preferred = preferredTaskId
      ? tasks.find(
          (task) => task.id === preferredTaskId && ACTIVE_TASK_STATUSES.includes(task.status),
        )
      : null;
    const activeTask =
      preferred ?? tasks.find((task) => ACTIVE_TASK_STATUSES.includes(task.status));
    if (activeTask) {
      this.loadTaskControl(roomId, activeTask.id);
      this.loadCollaboration(roomId, activeTask.id);
    } else {
      this.taskControl.set(null);
      this.collaboration.set([]);
    }
  }

  private loadCollaboration(roomId: string, taskId: string): void {
    this.api.collaboration.list(roomId, taskId).subscribe((items) => {
      if (this.selectedRoomId() === roomId && this.activeTask()?.id === taskId) {
        this.collaboration.set(items);
      }
    });
  }

  private loadArtifacts(roomId: string): void {
    this.api.artifacts.list(roomId).subscribe((listing) => this.artifacts.set(listing));
  }

  private loadAutonomyDiagnostics(roomId: string): void {
    this.api.diagnostics
      .routingDecisions(roomId, 60)
      .subscribe((decisions) => this.routingDecisions.set(decisions));
    this.api.diagnostics
      .missionCommandEvents(roomId, 60)
      .subscribe((events) => this.missionCommandEvents.set(events));
    this.api.diagnostics
      .turnOutcomes(roomId, 60)
      .subscribe((outcomes) => this.turnOutcomes.set(outcomes));
  }

  private handleRoomDeleted(roomId: string): void {
    const deleted = this.rooms().find((room) => room.id === roomId);
    const remaining = this.rooms().filter((room) => room.id !== roomId);
    this.rooms.set(remaining);
    if (this.selectedRoomId() !== roomId) return;
    this.selectedProjectId.set(deleted?.projectId ?? this.selectedProjectId());
    this.selectedRoomId.set(null);
    this.clearRoomState();
  }

  private clearRoomState(): void {
    this.messages.set([]);
    this.permissionRequests.set([]);
    this.tasks.set([]);
    this.runs.set([]);
    this.runActions.set([]);
    this.routingDecisions.set([]);
    this.missionCommandEvents.set([]);
    this.turnOutcomes.set([]);
    this.artifacts.set(null);
    this.collaboration.set([]);
    this.taskControl.set(null);
    this.yoloStatus.set(null);
    this.closeRunDetail();
    this.closeTaskInspector();
  }

  private isChatNearBottom(): boolean {
    if (this.selectedTab() !== 'chat') return true;
    return this.chatPaneRef?.isNearBottom() ?? true;
  }

  private scheduleChatScrollToBottom(): void {
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        if (this.selectedTab() !== 'chat') return;
        this.chatPaneRef?.scrollToBottom();
      });
    });
  }

  private upsert<T extends { id: string }>(items: T[], item: T): T[] {
    return [item, ...items.filter((existing) => existing.id !== item.id)];
  }

  missionReceiptDetail(action: AgentRunAction): string {
    return this.actionDetailText(action, 260);
  }

  private isMissionReceiptAction(action: AgentRunAction): boolean {
    return /^mission receipt(?::| missing| ignored)/i.test(action.label);
  }

  visibleRunActions(actions: AgentRunAction[]): AgentRunAction[] {
    const displayable = actions.filter((action) => !this.isHiddenRunAction(action));
    return this.showLowSignalRunEvents()
      ? displayable
      : displayable.filter((action) => this.isVisibleRunAction(action));
  }

  hiddenRunActionCount(actions: AgentRunAction[]): number {
    const displayable = actions.filter((action) => !this.isHiddenRunAction(action));
    if (this.showLowSignalRunEvents()) return 0;
    return this.lowSignalRunActionCount(displayable);
  }

  lowSignalRunActionCount(actions: AgentRunAction[]): number {
    return actions.length - actions.filter((action) => this.isVisibleRunAction(action)).length;
  }

  visibleDiagnosticSignals(signals: AgentRunDetail['diagnostics']['signals'] | undefined) {
    const items = (signals ?? []).filter((signal) => !this.isHiddenProviderSignal(signal.label));
    return this.showLowSignalRunEvents()
      ? items
      : items.filter((signal) => this.isVisibleProviderSignal(signal.label, signal.detail));
  }

  hiddenDiagnosticSignalCount(
    signals: AgentRunDetail['diagnostics']['signals'] | undefined,
  ): number {
    const displayable = (signals ?? []).filter(
      (signal) => !this.isHiddenProviderSignal(signal.label),
    );
    if (this.showLowSignalRunEvents()) return 0;
    return this.lowSignalDiagnosticSignalCount(displayable);
  }

  lowSignalDiagnosticSignalCount(
    signals: AgentRunDetail['diagnostics']['signals'] | undefined,
  ): number {
    const items = signals ?? [];
    return (
      items.length -
      items.filter((signal) => this.isVisibleProviderSignal(signal.label, signal.detail)).length
    );
  }

  setShowLowSignalRunEvents(event: Event): void {
    const checked = event.target instanceof HTMLInputElement ? event.target.checked : false;
    this.showLowSignalRunEvents.set(checked);
    localStorage.setItem('fireside.showLowSignalRunEvents', String(checked));
  }

  runActionDetail(action: AgentRunAction): string {
    return this.actionDetailText(action, 500) || action.status;
  }

  providerSignalDetail(signal: { kind: string; label: string; detail?: string }): string {
    return this.readableDetailText(signal.detail, 500) || signal.kind;
  }

  private isVisibleRunAction(action: AgentRunAction): boolean {
    return this.isVisibleProviderSignal(action.label, action.detail);
  }

  private isHiddenRunAction(action: AgentRunAction): boolean {
    return this.isHiddenProviderSignal(action.label);
  }

  private isHiddenProviderSignal(label: string): boolean {
    return /\b(?:claude\s+)?rate limit headers\b/i.test(label);
  }

  private isVisibleProviderSignal(label: string, detail: string | undefined): boolean {
    if (!this.isNoisyProviderLabel(label)) return true;
    const readable = this.readableDetailText(detail, 320);
    if (!readable) return false;
    if (/assistant message ready|agent_message/i.test(label)) return true;
    return this.isSubstantiveProviderSignalDetail(readable);
  }

  private isNoisyProviderLabel(label: string): boolean {
    const normalized = label.trim().toLowerCase();
    return [
      /\bmessage_start\b/,
      /\bmessage_delta\b/,
      /\bmessage delta\b/,
      /\bmessage_stop\b/,
      /\bmessage stop\b/,
      /\bcontent_block_start\b/,
      /\bcontent_block_delta\b/,
      /\bcontent_block_stop\b/,
      /\bcontent block (?:start|delta|stop)\b/,
      /\btool_use\b/,
      /\btool use\b/,
      /\bcommand_execution\b/,
      /\bcommand execution\b/,
      /\bthread\.started\b/,
      /\bthread started\b/,
      /\bturn started\b/,
      /\bturn\.started\b/,
      /\bturn\.completed\b/,
      /\bassistant message ready\b/,
      /\bagent_message\b/,
      /^agent process started$/,
      /^still working$/,
      /^(?:claude|codex|gemini)\s+user$/,
      /^(?:claude|codex|gemini)?\s*status$/,
    ].some((pattern) => pattern.test(normalized));
  }

  private isSubstantiveProviderSignalDetail(text: string): boolean {
    const normalized = text.trim();
    if (!normalized) return false;
    const lowered = normalized.toLowerCase();
    if (/last provider signal .*process still running/i.test(normalized)) return false;
    if (/^running$/i.test(normalized)) return false;
    const toolNameOnly = new Set([
      'bash',
      'edit',
      'glob',
      'grep',
      'ls',
      'multiedit',
      'read',
      'todowrite',
      'webfetch',
      'websearch',
      'write',
    ]);
    if (toolNameOnly.has(lowered)) return false;
    if (/^[0-9a-f-]{20,}$/i.test(normalized)) return false;
    const words = normalized.split(/\s+/).filter(Boolean);
    return words.length >= 4 || normalized.length >= 40;
  }

  private actionDetailText(action: AgentRunAction, maxChars: number): string {
    return actionDetailText(action, maxChars);
  }

  private readableDetailText(detail: string | undefined, maxChars: number): string {
    return readableDetailText(detail, maxChars);
  }

  private insertIntoInput(input: HTMLTextAreaElement, text: string): void {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const leading = before && !/\s$/.test(before) ? ' ' : '';
    const trailing = after && !/^\s/.test(after) ? ' ' : '';
    const insert = `${leading}${text}${trailing}`;
    input.value = `${before}${insert}${after}`;
    const cursor = before.length + insert.length;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    // The composer's text model is bound via [value]/(input). Direct .value
    // mutation bypasses that binding, so dispatch an `input` event to wake
    // the composer's onInput handler — it syncs the model + re-fits the
    // textarea to the new content height.
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private mentionHandleForProfile(
    profile: RoomAgentProfile,
    providerCounts: Map<ProviderId, number>,
  ): string {
    const displaySlug = this.display.mentionSlug(profile.displayName);
    const providerIsAmbiguous = (providerCounts.get(profile.providerId) ?? 0) > 1;
    if (displaySlug && (!providerIsAmbiguous || displaySlug !== profile.providerId)) {
      return displaySlug;
    }
    return this.display.mentionSlug(profile.id) || profile.id.toLowerCase();
  }

  private mentionSlug(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private isHiddenSystemMessage(message: Message): boolean {
    if (message.authorKind !== 'system') return false;
    return (
      /^Permission (approved|denied) for /i.test(message.text) ||
      /^\([a-z]+ started approved /i.test(message.text) ||
      /^\([a-z]+ finished the .* follow-up without a visible chat message\.\)$/i.test(
        message.text,
      ) ||
      /^\(fireside workflow contract repair for /i.test(message.text)
    );
  }

  private renderMessageHtml(text: string): string {
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts
      .map((part) => {
        if (part.startsWith('```') && part.endsWith('```') && part.length >= 6) {
          return `<pre>${escapeHtml(part.slice(3, -3).replace(/^\n/, ''))}</pre>`;
        }
        return this.renderInlineMessageHtml(this.collapseBlankLines(part));
      })
      .join('');
  }

  private collapseBlankLines(text: string): string {
    return text.replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, '\n\n');
  }

  private renderInlineMessageHtml(text: string): string {
    let html = '';
    let lastIndex = 0;

    for (const match of text.matchAll(INLINE_CHAT_TOKEN_RE)) {
      const token = match[0] ?? '';
      const index = match.index ?? 0;
      if (index > lastIndex) {
        html += this.renderInlineMarkdown(text.slice(lastIndex, index));
      }
      html += this.renderInlineTokenHtml(token);
      lastIndex = index + token.length;
    }

    if (lastIndex < text.length) {
      html += this.renderInlineMarkdown(text.slice(lastIndex));
    }
    return html;
  }

  private renderInlineTokenHtml(token: string): string {
    if (!token) return '';
    if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
      return `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    }
    if (token.startsWith('@file("')) {
      const filePath = token.slice(7, -2);
      return `<span class="file-mention" title="${escapeHtml(filePath)}">@file ${escapeHtml(this.basename(filePath))}</span>`;
    }

    const atIndex = token.indexOf('@');
    if (atIndex >= 0) {
      const prefix = token.slice(0, atIndex);
      const mentionText = token.slice(atIndex);
      const mention = mentionText.match(/^@([a-z][a-z0-9-]*)$/i);
      if (mention) {
        const mentionClass = this.mentionClassForHandle(mention[1]!);
        if (mentionClass) {
          return `${this.renderInlineMarkdown(prefix)}<span class="mention mention--${mentionClass}">${escapeHtml(mentionText)}</span>`;
        }
      }
    }

    return this.renderInlineMarkdown(token);
  }

  private mentionClassForHandle(handle: string): string | null {
    return (
      this.mentionProviderForHandle(handle) ?? (this.isHumanMentionHandle(handle) ? 'human' : null)
    );
  }

  private mentionProviderForHandle(handle: string): ProviderId | null {
    const normalized = this.display.mentionSlug(handle);
    if (!normalized) return null;
    const room = this.selectedRoom();
    if (room) {
      const providerCounts = new Map<ProviderId, number>();
      for (const agentId of room.agents) {
        const providerId = this.display.roomAgentProfile(room, agentId).providerId;
        providerCounts.set(providerId, (providerCounts.get(providerId) ?? 0) + 1);
      }
      for (const agentId of room.agents) {
        const profile = this.display.roomAgentProfile(room, agentId);
        const aliases = new Set([
          this.display.mentionSlug(profile.id),
          this.display.mentionSlug(profile.displayName),
        ]);
        if ((providerCounts.get(profile.providerId) ?? 0) === 1) {
          aliases.add(profile.providerId);
        }
        if (aliases.has(normalized)) return profile.providerId;
      }
    }
    if (normalized === 'claude' || normalized === 'codex' || normalized === 'gemini') {
      return normalized;
    }
    return null;
  }

  private isHumanMentionHandle(handle: string): boolean {
    const normalized = this.display.mentionSlug(handle);
    return normalized ? this.humanMentionSlugs().has(normalized) : false;
  }

  private messageMentionsHuman(message: Message): boolean {
    if (message.authorKind !== 'agent') return false;
    const humanSlug = this.display.mentionSlug(this.authorName());
    if (!humanSlug) return false;
    return this.extractMentionTokens(message.text).includes(humanSlug);
  }

  private humanMentionSlugs(): Set<string> {
    const slugs = new Set<string>();
    for (const name of this.humans()) {
      const slug = this.display.mentionSlug(name);
      if (slug) slugs.add(slug);
    }
    return slugs;
  }

  private extractMentionTokens(text: string): string[] {
    const found = new Set<string>();
    for (const match of text.matchAll(CHAT_MENTION_RE)) {
      const token = match[0] ?? '';
      const atIndex = token.indexOf('@');
      if (atIndex < 0) continue;
      const normalized = this.display.mentionSlug(token.slice(atIndex + 1));
      if (normalized) found.add(normalized);
    }
    return [...found];
  }

  private renderInlineMarkdown(text: string): string {
    return escapeHtml(text)
      .replace(/(\*\*\*|___)(?=\S)([^\n]*?\S)\1/g, '<strong><em>$2</em></strong>')
      .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '<strong>$2</strong>')
      .replace(/~~(?=\S)([^\n]*?\S)~~/g, '<s>$1</s>')
      .replace(/\+\+(?=\S)([^\n]*?\S)\+\+/g, '<u>$1</u>')
      .replace(/(^|[^\w*])\*(?!\s|\*)([^\n*]*?\S)\*(?![\w*])/g, '$1<em>$2</em>')
      .replace(/(^|[^\w_])_(?!\s|_)([^\n_]*?\S)_(?![\w_])/g, '$1<em>$2</em>');
  }

  private basename(filePath: string): string {
    return filePath.split(/[\\/]/).filter(Boolean).pop() || 'file';
  }

  private markdownToHtml(markdown: string): string {
    return renderMarkdown(markdown);
  }
}
