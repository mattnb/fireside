import { DatePipe } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { FiresideApi } from './api.service';
import { initOverviewRays } from './overview-rays';
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
  Artifact,
  ArtifactListing,
  CapabilityProfile,
  CollaborationItem,
  Message,
  MissionBriefing,
  MissionBriefingSummary,
  PermissionRequest,
  ProviderId,
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
import { VfxSmokeAndEmbersComponent } from './vfx-smoke-and-embers/vfx-smoke-and-embers';

type TabId = 'chat' | 'mission' | 'briefings';
type MissionViewId = 'overview' | 'board' | 'checklist' | 'roadmap' | 'plan' | 'evidence' | 'setup';
type MissionTab = 'brief' | 'active';
type RoadmapStatusFilter = 'ready' | 'in-progress' | 'blocked' | 'done';
type AgentRailKind = 'running' | 'yolo' | 'idle' | 'ready' | 'waiting' | 'blocked' | 'stale';
type OverviewAgentRow = {
  agentId: AgentId;
  status: string;
  detail: string;
  kind: AgentRailKind;
  working: boolean;
  idle: boolean;
};
type OverviewPhaseMarker = {
  id: string;
  title: string;
  isDone: boolean;
  isCurrent: boolean;
};
type ChatTimelineItem = {
  id: string;
  kind: 'message' | 'permission' | 'activity';
  createdAt: number;
  message?: Message;
  request?: PermissionRequest;
  activity?: MissionActivityEvent;
  grouped: boolean;
  html?: string;
  isError?: boolean;
  seenAgents?: AgentId[];
};
type MissionActivityTone = 'work' | 'done' | 'blocked' | 'phase' | 'retry' | 'mission' | 'plan';
type MissionActivityEvent = {
  id: string;
  createdAt: number;
  agentId?: AgentId | undefined;
  tone: MissionActivityTone;
  title: string;
  detail?: string | undefined;
  runId?: string | undefined;
};
type OpsTone = 'good' | 'warn' | 'danger' | 'info' | 'muted';
type OpsMetric = {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone: OpsTone;
};
type AttentionItem = {
  id: string;
  tone: OpsTone;
  label: string;
  title: string;
  detail: string;
  createdAt: number;
  agentId?: AgentId | undefined;
  runId?: string | undefined;
};
type ActiveSessionRow = {
  run: AgentRun;
  runtime: string;
  turns: string;
  tokens: string;
  signal: string;
  contextUsage: AgentContextUsage | null;
};
type ProviderCapacityRow = {
  agentId: AgentId;
  running: boolean;
  usage: AgentContextUsage | null;
  percent: number;
  label: string;
  detail: string;
  tone: OpsTone;
};
type ComposerMentionToken = {
  query: string;
  start: number;
  end: number;
};
type MentionSuggestion = {
  agentId: AgentId;
  handle: string;
  label: string;
  detail: string;
};
type MissionGraphTone = 'active' | 'ready' | 'waiting' | 'blocked' | 'done' | 'open' | 'skipped';
type MissionGraphDependency = {
  id: string;
  title: string;
  status: TaskChecklistItem['status'];
  done: boolean;
};
type MissionGraphCard = {
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
type MissionGraphLane = {
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
type MissionGraphSummary = {
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
type MissionBoardColumnId = 'ready' | 'active' | 'blocked' | 'review' | 'done';
type MissionBoardColumn = {
  id: MissionBoardColumnId;
  label: string;
  summary: string;
};
type MissionBoardSwimlane = {
  id: string;
  title: string;
  status: TaskPhaseStatus | 'backlog';
  gate: string;
  planLabel: string;
  cardsByColumn: Record<MissionBoardColumnId, MissionGraphCard[]>;
  totalCards: number;
};
type MissionActionKind = 'plan' | 'assign' | 'execute' | 'review' | 'sync' | 'verify';
type MissionActionScope = 'team' | 'selected' | 'single';
type MissionActionDefinition = {
  id: MissionActionKind;
  label: string;
  summary: string;
};
type DraftRoomAgent = {
  clientId: string;
  agentId?: AgentId;
  providerId: ProviderId;
  displayName: string;
  personaId: string;
  yolo: boolean;
};

const ACTIVE_TASK_STATUSES: TaskStatus[] = ['active', 'blocked', 'verifying'];
const DEFAULT_AGENT_CATALOG: AgentCatalog = {
  providers: [
    { id: 'claude', displayName: 'Claude', summary: 'Claude Code provider adapter.' },
    { id: 'codex', displayName: 'Codex', summary: 'OpenAI Codex CLI provider adapter.' },
    { id: 'gemini', displayName: 'Gemini', summary: 'Gemini CLI provider adapter.' },
  ],
  personas: [
    {
      id: 'generalist',
      name: 'Generalist',
      category: 'default',
      summary: 'No special lens; collaborate normally across planning, execution, and review.',
      prompt: '',
    },
  ],
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

@Component({
  selector: 'fs-root',
  standalone: true,
  imports: [DatePipe, VfxSmokeAndEmbersComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnDestroy {
  @ViewChild('messagesList') private messagesList?: ElementRef<HTMLOListElement>;
  private readonly overviewRaysCanvas =
    viewChild<ElementRef<HTMLCanvasElement>>('overviewRaysCanvas');
  private readonly overviewAttnCard = viewChild<ElementRef<HTMLElement>>('overviewAttnCard');
  private overviewRaysTeardown: (() => void) | null = null;

  private readonly api = inject(FiresideApi);
  private readonly ws = inject(FiresideWs);
  private scrollFrame: number | null = null;
  private deleteConfirmTimer: number | null = null;
  private mentionCloseTimer: number | null = null;
  private draftAgentCounter = 0;
  private readonly clockTimer = window.setInterval(() => this.now.set(Date.now()), 1000);

  readonly agentChoices: AgentId[] = ['claude', 'codex', 'gemini'];
  readonly agentCatalog = signal<AgentCatalog>(DEFAULT_AGENT_CATALOG);
  readonly tabs: Array<{ id: TabId; label: string }> = [
    { id: 'chat', label: 'Chat' },
    { id: 'mission', label: 'Mission Control' },
  ];
  readonly missionViews: Array<{ id: MissionViewId; label: string; summary: string }> = [
    { id: 'overview', label: 'Overview', summary: 'health, blockers, active work' },
    { id: 'board', label: 'Board', summary: 'status lanes and phase swimlanes' },
    { id: 'checklist', label: 'Checklist', summary: 'task details and ownership' },
    { id: 'roadmap', label: 'Roadmap', summary: 'phase gates and dependencies' },
    { id: 'plan', label: 'Plan', summary: 'team agreement and rationale' },
    { id: 'evidence', label: 'Evidence', summary: 'runs, artifacts, receipts' },
    { id: 'setup', label: 'Setup', summary: 'mission parameters' },
  ];
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
  readonly missionTab = signal<MissionTab>('active');
  readonly roadmapStatusFilter = signal<RoadmapStatusFilter | null>(null);
  readonly roadmapSelectedPhaseId = signal<string | null>(null);
  readonly missionActionPopoverOpen = signal(false);
  readonly collapsedBoardPhases = signal<Set<string>>(new Set());
  private autoCollapsedBoardPhases = new Set<string>();
  readonly collapsedChecklistPhases = signal<Set<string>>(new Set());
  private autoCollapsedChecklistPhases = new Set<string>();
  readonly now = signal(Date.now());
  readonly authorName = signal(localStorage.getItem('fireside.author') || 'human');
  readonly creatingProject = signal(false);
  readonly creatingMissionProjectId = signal<string | null>(null);
  readonly newRoomAgentRows = signal<DraftRoomAgent[]>(this.defaultDraftRoomAgents());
  readonly composerMentionToken = signal<ComposerMentionToken | null>(null);
  readonly mentionSelectedIndex = signal(0);
  readonly deletingRoomId = signal<string | null>(null);
  readonly editingAgents = signal(false);
  readonly editRoomAgentRows = signal<DraftRoomAgent[]>([]);
  readonly compactAgent = signal<AgentId | null>(null);
  readonly compactingAgent = signal<AgentId | null>(null);
  readonly compactError = signal('');
  readonly projects = signal<Project[]>([]);
  readonly rooms = signal<Room[]>([]);
  readonly stateSnapshot = signal<StatusSnapshot | null>(null);
  readonly selectedProjectId = signal<string | null>(null);
  readonly selectedRoomId = signal<string | null>(null);
  readonly messages = signal<Message[]>([]);
  readonly editingQueuedMessageId = signal<string | null>(null);
  readonly queuedMessageError = signal('');
  readonly permissionRequests = signal<PermissionRequest[]>([]);
  readonly tasks = signal<Task[]>([]);
  readonly creatingMissionDraft = signal(false);
  readonly runs = signal<AgentRun[]>([]);
  readonly runActions = signal<AgentRunAction[]>([]);
  readonly artifacts = signal<ArtifactListing | null>(null);
  readonly collaboration = signal<CollaborationItem[]>([]);
  readonly briefings = signal<MissionBriefingSummary[]>([]);
  readonly selectedBriefingId = signal<string | null>(null);
  readonly selectedBriefing = signal<MissionBriefing | null>(null);
  readonly briefingLoading = signal(false);
  readonly briefingError = signal('');
  readonly taskControl = signal<TaskControl | null>(null);
  readonly yoloStatus = signal<YoloStatus | null>(null);
  readonly openRunDetailId = signal<string | null>(null);
  readonly runDetail = signal<AgentRunDetail | null>(null);
  readonly runDetailLoading = signal(false);
  readonly runDetailError = signal('');
  readonly taskInspectorItemId = signal<string | null>(null);
  readonly missionActionScope = signal<MissionActionScope>('team');
  readonly selectedMissionAction = signal<MissionActionKind>('plan');
  readonly missionActionAgent = signal<AgentId>('');
  readonly selectedMissionActionAgents = signal<AgentId[]>([]);
  readonly missionActionChecklistItemId = signal('');
  readonly showLowSignalRunEvents = signal(
    localStorage.getItem('fireside.showLowSignalRunEvents') === 'true',
  );
  readonly collapseCompletedChecklist = signal(
    localStorage.getItem('fireside.collapseCompletedChecklist') !== 'false',
  );

  readonly missionActions: MissionActionDefinition[] = [
    {
      id: 'plan',
      label: 'Create / Revise Plan',
      summary:
        'Agree on direction, phase gates, checklist, evidence needs, and unresolved disagreements.',
    },
    {
      id: 'assign',
      label: 'Assign Next Work',
      summary: 'Choose unblocked checklist items, owners, dependencies, and blocker notes.',
    },
    {
      id: 'execute',
      label: 'Execute Work Item',
      summary: 'Send the target agents into one focused checklist item with status updates.',
    },
    {
      id: 'review',
      label: 'Review Mission State',
      summary: 'Challenge assumptions, risks, evidence gaps, and weak consensus.',
    },
    {
      id: 'sync',
      label: 'Sync Team',
      summary: 'Collect current status, blockers, disagreement, and the recommended next owner.',
    },
    {
      id: 'verify',
      label: 'Verify Gate',
      summary: 'Test whether the current phase gate is satisfied by concrete evidence.',
    },
  ];

  readonly selectedRoom = computed(
    () => this.rooms().find((room) => room.id === this.selectedRoomId()) ?? null,
  );
  readonly selectedProject = computed(
    () => this.projects().find((project) => project.id === this.selectedProjectId()) ?? null,
  );
  readonly projectGroups = computed(() =>
    this.projects().map((project) => ({
      project,
      missions: this.rooms().filter((room) => room.projectId === project.id),
    })),
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
  readonly selectedRoomSnapshot = computed(() => {
    const roomId = this.selectedRoomId();
    return this.stateSnapshot()?.rooms.find((room) => room.id === roomId) ?? null;
  });
  readonly projectDashboardSummary = computed(() =>
    this.buildProjectDashboardSummary(this.selectedProjectRoomSnapshots()),
  );
  readonly activeTask = computed(
    () => this.tasks().find((task) => ACTIVE_TASK_STATUSES.includes(task.status)) ?? null,
  );
  readonly missionHistory = computed(() =>
    [...this.tasks()].sort((a, b) => {
      const activeDelta =
        Number(!ACTIVE_TASK_STATUSES.includes(a.status)) -
        Number(!ACTIVE_TASK_STATUSES.includes(b.status));
      if (activeDelta !== 0) return activeDelta;
      return (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt);
    }),
  );
  readonly roomAgents = computed(() => this.selectedRoom()?.agents ?? []);
  readonly roomYoloAgents = computed(() => this.selectedRoom()?.yoloAgents ?? []);
  readonly agentProviders = computed(() => this.agentCatalog().providers);
  readonly agentPersonas = computed(() => this.agentCatalog().personas);
  readonly mentionSuggestions = computed(() => {
    const token = this.composerMentionToken();
    const room = this.selectedRoom();
    if (!token || !room) return [];
    const query = token.query.toLowerCase();
    const providerCounts = new Map<ProviderId, number>();
    for (const agentId of room.agents) {
      const providerId = this.roomAgentProfile(room, agentId).providerId;
      providerCounts.set(providerId, (providerCounts.get(providerId) ?? 0) + 1);
    }
    return room.agents
      .map((agentId): MentionSuggestion => {
        const profile = this.roomAgentProfile(room, agentId);
        const handle = this.mentionHandleForProfile(profile, providerCounts);
        return {
          agentId,
          handle,
          label: profile.displayName,
          detail:
            profile.personaId === 'generalist'
              ? `${this.draftProviderLabel(profile.providerId)} / ${agentId}`
              : `${this.draftProviderLabel(profile.providerId)} ${profile.personaName} / ${agentId}`,
        };
      })
      .filter((suggestion) =>
        [
          suggestion.handle,
          suggestion.label,
          suggestion.agentId,
          this.agentProviderId(suggestion.agentId),
          this.agentPersonaName(suggestion.agentId),
        ].some((value) => value.toLowerCase().includes(query)),
      )
      .slice(0, 8);
  });
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
      if (fiveHour) merged.fiveHour = fiveHour;
      if (sevenDay) merged.sevenDay = sevenDay;
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
  readonly runningRuns = computed(() => this.runs().filter((run) => run.status === 'running'));
  readonly isRoomWorking = computed(() => this.runningRuns().length > 0);
  readonly visibleArtifacts = computed(() => this.artifacts()?.files.slice(0, 8) ?? []);
  readonly completedRuns = computed(() =>
    this.runs()
      .filter((run) => run.status !== 'running')
      .slice(0, 8),
  );
  readonly queuedHumanMessages = computed(() =>
    this.messages().filter(
      (message) => message.authorKind === 'human' && message.deliveryStatus === 'queued',
    ),
  );
  readonly retryingRuns = computed(() =>
    this.runs().filter((run) => run.lifecycleState === 'retry_queued'),
  );
  readonly stalledRuns = computed(() =>
    this.runs().filter(
      (run) =>
        run.lifecycleState === 'stalled' ||
        (run.status === 'running' && this.runIdleMs(run) >= 5 * 60 * 1000),
    ),
  );
  readonly failedRuns = computed(() =>
    this.runs()
      .filter((run) => run.status === 'failed')
      .sort((a, b) => (b.completedAt ?? b.startedAt ?? 0) - (a.completedAt ?? a.startedAt ?? 0))
      .slice(0, 4),
  );
  readonly attentionItems = computed(() => this.buildAttentionItems());
  readonly operationMetrics = computed(() => this.buildOperationMetrics());
  readonly activeSessionRows = computed(() => this.buildActiveSessionRows());
  readonly providerCapacityRows = computed(() => this.buildProviderCapacityRows());
  readonly missionGraphLanes = computed(() => this.buildMissionGraphLanes());
  readonly missionGraphSummary = computed(() => this.buildMissionGraphSummary());
  readonly missionBoardSwimlanes = computed(() => this.buildMissionBoardSwimlanes());

  // Board swimlanes sorted on two axes: status group (active → queued → done),
  // then phase sortOrder within each group.
  readonly sortedBoardSwimlanes = computed<MissionBoardSwimlane[]>(() => {
    const lanes = this.missionBoardSwimlanes();
    const graphLanes = this.missionGraphLanes();
    const sortOrderById = new Map<string, number>(
      graphLanes.map((l, i) => [l.id, l.phase?.sortOrder ?? i] as const),
    );
    const groupRank = (status: string): number => {
      if (status === 'active') return 0;
      if (status === 'done') return 2;
      return 1;
    };
    return [...lanes].sort((a, b) => {
      const ra = groupRank(a.status);
      const rb = groupRank(b.status);
      if (ra !== rb) return ra - rb;
      const sa = sortOrderById.get(a.id) ?? 0;
      const sb = sortOrderById.get(b.id) ?? 0;
      return sa - sb;
    });
  });

  // === Roadmap (master-detail) ===
  readonly selectedRoadmapLane = computed<MissionGraphLane | null>(() => {
    const lanes = this.missionGraphLanes();
    if (lanes.length === 0) return null;
    const selectedId = this.roadmapSelectedPhaseId();
    if (selectedId) {
      const found = lanes.find((l) => l.id === selectedId);
      if (found) return found;
    }
    const activePhaseId = this.taskControl()?.currentPhase?.id;
    if (activePhaseId) {
      const active = lanes.find((l) => l.phase?.id === activePhaseId);
      if (active) return active;
    }
    return lanes[0] ?? null;
  });

  readonly roadmapFilteredCards = computed<MissionGraphCard[]>(() => {
    const lane = this.selectedRoadmapLane();
    if (!lane) return [];
    const filter = this.roadmapStatusFilter();
    if (!filter) return lane.cards;
    return lane.cards.filter((card) => {
      if (filter === 'ready') return card.ready;
      if (filter === 'in-progress') return !!card.activeRun;
      if (filter === 'blocked') return card.item.status === 'blocked' || card.waiting;
      return card.item.status === 'done';
    });
  });

  // === Overview hero (v39) — derived data for the tabbed mission card,
  // attention frame, and the three stat tiles to its right.
  readonly phaseProgressLabel = computed(() => {
    const control = this.taskControl();
    const phases = control?.phases ?? [];
    if (phases.length === 0) return 'none';
    const currentId = control?.currentPhase?.id;
    const idx = phases.findIndex((p) => p.id === currentId);
    const ord = idx >= 0 ? idx + 1 : 0;
    return `${this.pad2(ord)} of ${this.pad2(phases.length)}`;
  });
  readonly activeTaskStartedLabel = computed(() => {
    const task = this.activeTask();
    if (!task) return '—';
    return this.formatRelativeAgo(task.createdAt);
  });
  readonly activeTaskRepoPath = computed(() => {
    const task = this.activeTask();
    return task?.repoPath || 'not set';
  });
  readonly currentWorkItem = computed(() => {
    return this.missionActionWorkItems().find((item) => item.status === 'open') ?? null;
  });
  readonly overviewBlockerItems = computed(() =>
    this.attentionItems().filter((item) => item.tone === 'danger' || item.tone === 'warn'),
  );
  readonly overviewUpNextItems = computed(() => {
    const skipIds = new Set(this.attentionItems().map((item) => item.id));
    return this.missionActionWorkItems()
      .filter((item) => item.status === 'open' || item.status === 'blocked')
      .filter((item) => !skipIds.has(`work:${item.id}`))
      .slice(0, 3);
  });
  readonly overviewAgentRows = computed<OverviewAgentRow[]>(() => {
    const room = this.selectedRoom();
    if (!room) return [];
    return room.agents.map((agentId) => {
      const kind = this.agentRailKind(agentId);
      return {
        agentId,
        status: this.agentRailStatus(agentId),
        detail: this.agentRailDetail(agentId),
        kind,
        working: kind === 'running',
        idle: kind === 'idle' || kind === 'ready' || kind === 'waiting' || kind === 'yolo',
      };
    });
  });
  readonly overviewWorkingCount = computed(
    () => this.overviewAgentRows().filter((row) => row.working).length,
  );
  readonly overviewIdleCount = computed(
    () => this.overviewAgentRows().filter((row) => row.idle).length,
  );
  readonly overviewRuntimeLabel = computed(() => {
    const rows = this.activeSessionRows();
    if (rows.length === 0) return '—';
    return rows[0]?.runtime ?? '—';
  });
  readonly overviewTokensLabel = computed(() => {
    const rows = this.activeSessionRows();
    if (rows.length === 0) return '0';
    return rows[0]?.tokens ?? '0';
  });
  readonly overviewProgressPercent = computed(() => {
    const summary = this.missionGraphSummary();
    if (!summary || summary.itemsTotal === 0) return 0;
    return Math.round((summary.itemsDone / summary.itemsTotal) * 100);
  });
  readonly overviewProgressDoneLabel = computed(() => {
    const summary = this.missionGraphSummary();
    if (!summary) return '— / —';
    return `${this.pad2(summary.itemsDone)} / ${this.pad2(summary.itemsTotal)} items`;
  });
  readonly overviewPhaseMarkers = computed<OverviewPhaseMarker[]>(() => {
    const control = this.taskControl();
    const phases = control?.phases ?? [];
    const currentId = control?.currentPhase?.id;
    const currentIdx = phases.findIndex((p) => p.id === currentId);
    return phases.map((phase, i) => ({
      id: phase.id,
      title: phase.title,
      isDone: currentIdx >= 0 && i < currentIdx,
      isCurrent: phase.id === currentId,
    }));
  });
  readonly taskInspectorCard = computed(() =>
    this.findMissionGraphCard(this.taskInspectorItemId()),
  );
  readonly missionActivity = computed(() => this.buildMissionActivityEvents());
  readonly chatTimeline = computed(() => {
    const rawItems: ChatTimelineItem[] = [
      ...this.messages()
        .filter((message) => !this.isHiddenSystemMessage(message))
        .map((message) => ({
          id: `message:${message.id}`,
          kind: 'message' as const,
          createdAt: message.createdAt,
          message,
          grouped: false,
          html: this.renderMessageHtml(message.text),
          isError: message.authorKind === 'system' && /failed|timed out|error/i.test(message.text),
          ...(message.authorKind === 'system'
            ? {}
            : { seenAgents: this.messageSeenAgents(message) }),
        })),
      ...this.permissionRequests().map((request) => ({
        id: `permission:${request.id}`,
        kind: 'permission' as const,
        createdAt: request.createdAt,
        request,
        grouped: false,
      })),
      ...this.missionActivity().map((activity) => ({
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
  readonly activePlanHtml = computed(() =>
    this.markdownToHtml(this.taskControl()?.activePlan?.body ?? ''),
  );
  readonly missionReceiptActions = computed(() => {
    const taskId = this.activeTask()?.id;
    return this.runActions()
      .filter((action) => action.taskId === taskId && this.isMissionReceiptAction(action))
      .slice(0, 8);
  });
  readonly hasCollaborationTrail = computed(
    () => this.collaboration().length > 0 || this.missionReceiptActions().length > 0,
  );
  readonly missionActionTargetAgents = computed(() => {
    const roomAgents = this.roomAgents();
    if (this.missionActionScope() === 'team') return roomAgents;
    if (this.missionActionScope() === 'single') {
      const requested = this.missionActionAgent();
      return roomAgents.includes(requested) ? [requested] : roomAgents.slice(0, 1);
    }
    const selected = new Set(this.selectedMissionActionAgents());
    return roomAgents.filter((agent) => selected.has(agent));
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
  readonly missionActionPreview = computed(() =>
    this.buildMissionActionPrompt(this.selectedMissionAction()),
  );

  constructor() {
    this.ws.connect();
    this.loadAgentCatalog();
    this.loadProjects();
    this.loadRooms();
    this.loadStateSnapshot();
    this.loadBriefings();

    effect(() => {
      const roomId = this.selectedRoomId();
      if (!roomId) return;
      untracked(() => {
        this.loadRoomDetail(roomId);
        this.ws.subscribe(roomId);
      });
    });

    // Initialize / tear down the WebGL god-rays renderer whenever the overview
    // canvas + attention card mount or unmount (e.g. when the user navigates to
    // a different mission view, the @if block destroys the canvas; the
    // viewChild signals go undefined and the effect re-runs with cleanup).
    effect(() => {
      const canvasRef = this.overviewRaysCanvas();
      const cardRef = this.overviewAttnCard();

      if (this.overviewRaysTeardown) {
        this.overviewRaysTeardown();
        this.overviewRaysTeardown = null;
      }

      if (canvasRef && cardRef) {
        untracked(() => {
          this.overviewRaysTeardown = initOverviewRays(
            canvasRef.nativeElement,
            cardRef.nativeElement,
          );
        });
      }
    });

    // Auto-collapse done board phases the first time they appear. The user can
    // expand them after that and we won't auto-recollapse — autoCollapsedBoardPhases
    // tracks which phases we've already auto-collapsed so subsequent state
    // refreshes leave the user's choice alone.
    effect(() => {
      const lanes = this.missionBoardSwimlanes();
      untracked(() => {
        const seen = this.autoCollapsedBoardPhases;
        const newlyCollapse: string[] = [];
        for (const lane of lanes) {
          if (lane.status === 'done' && !seen.has(lane.id)) {
            seen.add(lane.id);
            newlyCollapse.push(lane.id);
          }
        }
        if (newlyCollapse.length > 0) {
          const set = new Set(this.collapsedBoardPhases());
          for (const id of newlyCollapse) set.add(id);
          this.collapsedBoardPhases.set(set);
        }
      });
    });

    effect(() => {
      const phases = this.taskControl()?.phases ?? [];
      untracked(() => {
        const seen = this.autoCollapsedChecklistPhases;
        const newlyCollapse: string[] = [];
        for (const phase of phases) {
          if (phase.status === 'done' && !seen.has(phase.id)) {
            seen.add(phase.id);
            newlyCollapse.push(phase.id);
          }
        }
        if (newlyCollapse.length > 0) {
          const set = new Set(this.collapsedChecklistPhases());
          for (const id of newlyCollapse) set.add(id);
          this.collapsedChecklistPhases.set(set);
        }
      });
    });

    this.ws.stream$.subscribe((event) => {
      const roomId = this.selectedRoomId();
      if (event.type === 'messageAppended' && event.message.roomId === roomId) {
        const shouldStickToBottom = this.isChatNearBottom();
        this.messages.update((messages) => [...messages, event.message]);
        if (shouldStickToBottom) this.scheduleChatScrollToBottom();
      }
      if (event.type === 'messageUpdated' && event.message.roomId === roomId) {
        this.messages.update((messages) => this.upsert(messages, event.message));
      }
      if (event.type === 'messageRetracted' && event.update.roomId === roomId) {
        this.messages.update((messages) =>
          messages.filter((message) => message.id !== event.update.messageId),
        );
        if (this.editingQueuedMessageId() === event.update.messageId) {
          this.cancelQueuedMessageEdit();
        }
      }
      if (event.type === 'messageDeliveryUpdated' && event.update.roomId === roomId) {
        this.messages.update((messages) =>
          messages.map((message) =>
            message.id === event.update.messageId
              ? { ...message, deliveryStatus: event.update.deliveryStatus }
              : message,
          ),
        );
      }
      if (event.type === 'messageReadReceiptUpdated' && event.update.roomId === roomId) {
        this.messages.update((messages) =>
          messages.map((message) =>
            message.id === event.update.messageId
              ? { ...message, seenBy: event.update.seenBy }
              : message,
          ),
        );
      }
      if (event.type === 'permissionRequestCreated' && event.request.roomId === roomId) {
        this.permissionRequests.update((requests) => this.upsert(requests, event.request));
        this.scheduleChatScrollToBottom();
      }
      if (event.type === 'permissionRequestUpdated' && event.request.roomId === roomId) {
        this.permissionRequests.update((requests) => this.upsert(requests, event.request));
      }
      if (event.type === 'taskUpdated' && event.task.roomId === roomId) {
        this.loadStateSnapshot();
        this.tasks.update((tasks) => this.upsert(tasks, event.task));
        if (ACTIVE_TASK_STATUSES.includes(event.task.status)) {
          this.loadTaskControl(roomId, event.task.id);
          this.loadCollaboration(roomId, event.task.id);
        } else if (event.task.id === this.taskControl()?.task.id) {
          const activeTask = this.activeTask();
          if (activeTask) {
            this.loadTaskControl(roomId, activeTask.id);
            this.loadCollaboration(roomId, activeTask.id);
          } else {
            this.taskControl.set(null);
            this.collaboration.set([]);
          }
        }
      }
      if (event.type === 'agentRunUpdated' && event.run.roomId === roomId) {
        this.loadStateSnapshot();
        const shouldStickToBottom = this.isChatNearBottom();
        this.runs.update((runs) => this.upsert(runs, event.run));
        if (event.run.id === this.openRunDetailId()) this.openRunDetail(event.run.id, true);
        if (shouldStickToBottom && this.isActivityRunUpdate(event.run)) {
          this.scheduleChatScrollToBottom();
        }
      }
      if (event.type === 'agentRunActionCreated' && event.action.roomId === roomId) {
        this.loadStateSnapshot();
        const shouldStickToBottom = this.isChatNearBottom();
        this.runActions.update((actions) => this.upsert(actions, event.action));
        if (event.action.runId === this.openRunDetailId())
          this.openRunDetail(event.action.runId, true);
        if (shouldStickToBottom && this.isActivityRunAction(event.action)) {
          this.scheduleChatScrollToBottom();
        }
      }
      if (event.type === 'artifactsUpdated' && event.roomId === roomId) {
        this.loadArtifacts(roomId);
      }
      if (event.type === 'collaborationItemCreated' && event.item.roomId === roomId) {
        if (event.item.taskId === this.activeTask()?.id) {
          this.collaboration.update((items) => this.upsert(items, event.item));
        }
      }
      if (event.type === 'yoloStatusUpdated' && event.status.roomId === roomId) {
        this.yoloStatus.set(event.status);
      }
      if (event.type === 'roomUpdated') {
        this.loadStateSnapshot();
        this.rooms.update((rooms) => this.upsert(rooms, event.room));
        this.syncMissionActionTargets();
        if (event.room.id === roomId && this.editingAgents()) {
          this.editRoomAgentRows.set(this.draftRowsFromRoom(event.room));
        }
      }
      if (event.type === 'roomDeleted') {
        this.loadStateSnapshot();
        this.handleRoomDeleted(event.roomId);
      }
    });
  }

  ngOnDestroy(): void {
    window.clearInterval(this.clockTimer);
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    if (this.deleteConfirmTimer !== null) window.clearTimeout(this.deleteConfirmTimer);
    if (this.mentionCloseTimer !== null) window.clearTimeout(this.mentionCloseTimer);
    if (this.overviewRaysTeardown) {
      this.overviewRaysTeardown();
      this.overviewRaysTeardown = null;
    }
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
    if (this.selectedTab() === 'briefings') this.selectedTab.set('chat');
  }

  selectTab(tabId: TabId): void {
    this.selectedTab.set(tabId);
    if (tabId === 'chat') this.scheduleChatScrollToBottom();
    if (tabId === 'briefings') this.loadBriefings();
  }

  openBriefings(): void {
    this.selectTab('briefings');
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

  toggleCreateRoom(projectId?: string): void {
    const targetProjectId = projectId ?? this.selectedProjectId();
    if (!targetProjectId) return;
    this.creatingProject.set(false);
    this.creatingMissionProjectId.update((current) =>
      current === targetProjectId ? null : targetProjectId,
    );
  }

  cancelCreateRoom(input?: HTMLInputElement): void {
    if (input) input.value = '';
    this.newRoomAgentRows.set(this.defaultDraftRoomAgents());
    this.creatingMissionProjectId.set(null);
  }

  projectName(projectId: string | null): string {
    return this.projects().find((project) => project.id === projectId)?.name ?? 'this project';
  }

  addNewRoomAgent(): void {
    this.newRoomAgentRows.update((rows) => [
      ...rows,
      this.createDraftAgent('claude', 'generalist', false, this.suggestDraftAgentName('claude', rows)),
    ]);
  }

  removeNewRoomAgent(clientId: string): void {
    this.newRoomAgentRows.update((rows) => rows.filter((row) => row.clientId !== clientId));
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
            }
          : row,
      ),
    );
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
  }

  setNewRoomAgentName(clientId: string, event: Event): void {
    const displayName = event.target instanceof HTMLInputElement ? event.target.value : '';
    this.newRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, displayName } : row)),
    );
  }

  toggleNewRoomAgentYolo(clientId: string, event: Event): void {
    const yolo = event.target instanceof HTMLInputElement ? event.target.checked : false;
    this.newRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, yolo } : row)),
    );
  }

  addEditRoomAgent(): void {
    this.editRoomAgentRows.update((rows) => [
      ...rows,
      this.createDraftAgent('claude', 'generalist', false, this.suggestDraftAgentName('claude', rows)),
    ]);
  }

  removeEditRoomAgent(clientId: string): void {
    this.editRoomAgentRows.update((rows) => rows.filter((row) => row.clientId !== clientId));
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
            }
          : row,
      ),
    );
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
  }

  setEditRoomAgentName(clientId: string, event: Event): void {
    const displayName = event.target instanceof HTMLInputElement ? event.target.value : '';
    this.editRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, displayName } : row)),
    );
  }

  toggleEditRoomAgentYolo(clientId: string, event: Event): void {
    const yolo = event.target instanceof HTMLInputElement ? event.target.checked : false;
    this.editRoomAgentRows.update((rows) =>
      rows.map((row) => (row.clientId === clientId ? { ...row, yolo } : row)),
    );
  }

  draftProviderLabel(providerId: ProviderId): string {
    return (
      this.agentProviders().find((provider) => provider.id === providerId)?.displayName ??
      providerId
    );
  }

  draftPersonaLabel(personaId: string): string {
    return this.personaForId(personaId).name;
  }

  draftAgentPreview(row: DraftRoomAgent): string {
    const name = this.cleanDisplayName(row.displayName);
    return name || this.draftDefaultDisplayName(row.providerId, row.personaId);
  }

  draftProviderAvatarClass(row: DraftRoomAgent): string {
    return `avatar avatar--sm avatar--${row.providerId}`;
  }

  createRoom(input: HTMLInputElement): void {
    const name = input.value.trim();
    const projectId = this.creatingMissionProjectId() ?? this.selectedProjectId();
    if (!name || !projectId) return;
    const agentProfiles = this.buildRoomAgentProfiles(this.newRoomAgentRows());
    const agents = agentProfiles.map((profile) => profile.id);
    if (agents.length === 0) return;
    this.api.rooms
      .create({
        projectId,
        name,
        agents,
        yoloAgents: this.yoloAgentsFromDraftRows(this.newRoomAgentRows(), agentProfiles),
        agentProfiles,
      })
      .subscribe((room) => {
        this.rooms.update((rooms) => this.upsert(rooms, room));
        this.selectedProjectId.set(room.projectId);
        this.selectedRoomId.set(room.id);
        input.value = '';
        this.newRoomAgentRows.set(this.defaultDraftRoomAgents());
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
  ): DraftRoomAgent {
    this.draftAgentCounter += 1;
    return {
      clientId: `draft-${Date.now()}-${this.draftAgentCounter}`,
      ...(agentId ? { agentId } : {}),
      providerId,
      displayName: displayName || this.draftDefaultDisplayName(providerId, personaId),
      personaId,
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
    return rows.map((row) => {
      const provider = this.providerForId(row.providerId);
      const persona = this.personaForId(row.personaId);
      const displayName = this.uniqueDisplayName(
        this.cleanDisplayName(row.displayName) ||
          (persona.id === 'generalist' ? provider.displayName : `${provider.displayName} ${persona.name}`),
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
      };
    });
  }

  private draftDefaultDisplayName(providerId: ProviderId, personaId: string): string {
    const provider = this.providerForId(providerId);
    const persona = this.personaForId(personaId);
    return persona.id === 'generalist' ? provider.displayName : `${provider.displayName} ${persona.name}`;
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
    const providerName = this.draftDefaultDisplayName(providerId, personaId);
    if (!existing.has(providerName.toLowerCase())) return providerName;
    for (const name of FRIENDLY_AGENT_NAMES) {
      if (!existing.has(name.toLowerCase())) return name;
    }
    const providerLabel = this.providerForId(providerId).displayName;
    let counter = 2;
    while (existing.has(`${providerLabel} ${counter}`.toLowerCase())) counter += 1;
    return `${providerLabel} ${counter}`;
  }

  private cleanDisplayName(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  private uniqueDisplayName(base: string, seen: Set<string>): string {
    const cleanBase = this.cleanDisplayName(base) || 'Agent';
    let candidate = cleanBase;
    let counter = 2;
    while (seen.has(candidate.toLowerCase())) {
      candidate = `${cleanBase} ${counter}`;
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

  private yoloAgentsFromDraftRows(
    rows: DraftRoomAgent[],
    profiles: RoomAgentProfile[],
  ): AgentId[] {
    return rows
      .map((row, index) => (row.yolo ? profiles[index]?.id : ''))
      .filter((agentId): agentId is AgentId => Boolean(agentId));
  }

  private draftRowsFromRoom(room: Room): DraftRoomAgent[] {
    return room.agents.map((agentId) => {
      const profile = this.roomAgentProfile(room, agentId);
      return this.createDraftAgent(
        profile.providerId,
        profile.personaId || 'generalist',
        room.yoloAgents.includes(agentId),
        profile.displayName,
        agentId,
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
    this.authorName.set(name);
    input.value = name;
    localStorage.setItem('fireside.author', name);
  }

  openEditAgents(): void {
    const room = this.selectedRoom();
    if (!room) return;
    this.editRoomAgentRows.set(this.draftRowsFromRoom(room));
    this.editingAgents.set(true);
  }

  cancelEditAgents(): void {
    this.editingAgents.set(false);
    this.editRoomAgentRows.set([]);
  }

  saveEditAgents(): void {
    const room = this.selectedRoom();
    if (!room) return;
    const agentProfiles = this.buildRoomAgentProfiles(this.editRoomAgentRows());
    const agents = agentProfiles.map((profile) => profile.id);
    this.api.rooms
      .update(room.id, {
        agents,
        yoloAgents: this.yoloAgentsFromDraftRows(this.editRoomAgentRows(), agentProfiles),
        agentProfiles,
      })
      .subscribe((updated) => {
        this.rooms.update((rooms) => this.upsert(rooms, updated));
        this.loadStateSnapshot();
        this.editingAgents.set(false);
      });
  }

  roomAgentProfile(room: Room | null | undefined, agentId: AgentId): RoomAgentProfile {
    const providerId = this.agentProviderIdFromId(agentId);
    const provider = this.providerForId(providerId);
    const generalist = this.personaForId('generalist');
    return (
      room?.agentProfiles?.find((profile) => profile.id === agentId) ?? {
        id: agentId,
        providerId,
        displayName: agentId === providerId ? provider.displayName : agentId,
        personaId: generalist.id,
        personaName: generalist.name,
        personaSummary: generalist.summary,
      }
    );
  }

  agentProfile(agentId: AgentId): RoomAgentProfile {
    return this.roomAgentProfile(this.selectedRoom(), agentId);
  }

  agentProviderId(agentId: AgentId): ProviderId {
    return this.agentProfile(agentId).providerId;
  }

  agentDisplayName(agentId: AgentId): string {
    return this.agentProfile(agentId).displayName;
  }

  agentDisplayNameForRoom(room: Room | null | undefined, agentId: AgentId): string {
    return this.roomAgentProfile(room, agentId).displayName;
  }

  agentPersonaName(agentId: AgentId): string {
    return this.agentProfile(agentId).personaName;
  }

  isTemporaryAgent(agentId: AgentId): boolean {
    return this.agentProfile(agentId).temporary === true;
  }

  temporaryAgentTitle(agentId: AgentId): string {
    const profile = this.agentProfile(agentId);
    if (!profile.temporary) return '';
    const by = profile.spawnedBy ? ` by ${this.agentDisplayName(profile.spawnedBy)}` : '';
    const scope = profile.spawnedScope ? ` for ${profile.spawnedScope}` : '';
    return `Temporary agent${by}${scope}`;
  }

  avatarClass(agentId: AgentId, size: 'sm' | 'tiny' | '' = ''): string {
    const sizeClass = size ? ` avatar--${size}` : '';
    return `avatar${sizeClass} avatar--${this.agentProviderId(agentId)}`;
  }

  private agentProviderIdFromId(agentId: AgentId): ProviderId {
    const lower = agentId.toLowerCase();
    if (lower === 'claude' || lower.startsWith('claude-')) return 'claude';
    if (lower === 'codex' || lower.startsWith('codex-')) return 'codex';
    if (lower === 'gemini' || lower.startsWith('gemini-')) return 'gemini';
    return lower;
  }

  isAgentRunning(agentId: string): boolean {
    return this.runningRuns().some((run) => run.agentId === agentId);
  }

  isRoomYoloAgent(agentId: AgentId): boolean {
    return this.roomYoloAgents().includes(agentId);
  }

  messageSeenAgents(message: Message): AgentId[] {
    const seen = new Set<AgentId>(message.seenBy ?? []);
    for (const run of this.runs()) {
      if (run.triggerMessageId !== message.id) continue;
      if (run.agentId === message.authorId) continue;
      seen.add(run.agentId);
    }
    seen.delete(message.authorId);
    const roomOrder = this.roomAgents();
    return [
      ...roomOrder.filter((agentId) => seen.has(agentId)),
      ...[...seen].filter((agentId) => !roomOrder.includes(agentId)).sort(),
    ];
  }

  seenAgentsLabel(agents: AgentId[]): string {
    if (agents.length === 0) return 'Seen by nobody';
    return `Seen by ${agents.map((agentId) => this.agentDisplayName(agentId)).join(', ')}`;
  }

  canCompactAgent(agentId: AgentId): boolean {
    const providerId = this.agentProviderId(agentId);
    return providerId === 'claude' || providerId === 'codex';
  }

  agentWorkflowState(agentId: AgentId): StatusSnapshotAgentState | null {
    return (
      this.selectedRoomSnapshot()?.agentStates.find((state) => state.agentId === agentId) ?? null
    );
  }

  agentRailStatus(agentId: AgentId): string {
    if (this.compactingAgent() === agentId) return 'compacting';
    const state = this.agentWorkflowState(agentId);
    if (state) return state.label;
    if (this.isAgentRunning(agentId)) return 'working';
    if (this.isRoomYoloAgent(agentId)) return 'yolo';
    return 'idle';
  }

  agentRailDetail(agentId: AgentId): string {
    const state = this.agentWorkflowState(agentId);
    return state?.detail ?? this.agentRailStatus(agentId);
  }

  agentRailKind(agentId: AgentId): AgentRailKind {
    const state = this.agentWorkflowState(agentId);
    if (state?.state === 'working') return 'running';
    if (state?.state === 'stale') return 'stale';
    if (state?.state === 'blocked') return state.severity === 'danger' ? 'blocked' : 'waiting';
    if (state?.state === 'waiting_on_human' || state?.state === 'waiting_on_agent')
      return 'waiting';
    if (state?.state === 'idle_ready') return 'ready';
    if (this.isAgentRunning(agentId)) return 'running';
    if (this.isRoomYoloAgent(agentId)) return 'yolo';
    return 'idle';
  }

  agentContextPercentRounded(usage: AgentContextUsage): number {
    return Math.round(this.agentContextPercent(usage));
  }

  openCompactAgent(agentId: AgentId, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!this.canCompactAgent(agentId)) return;
    this.compactError.set('');
    this.compactAgent.set(agentId);
  }

  closeCompactAgent(): void {
    if (this.compactingAgent()) return;
    this.compactAgent.set(null);
    this.compactError.set('');
  }

  compactAgentDescription(agentId: AgentId): string {
    const providerId = this.agentProviderId(agentId);
    if (providerId === 'claude') {
      return 'Manual compaction asks Claude Code to compact its stored CLI session context.';
    }
    if (providerId === 'codex') {
      return 'Manual compaction asks Codex CLI to compact its stored CLI session context.';
    }
    return 'Manual compaction is not configured for this provider yet.';
  }

  startCompactAgent(agentId: AgentId): void {
    const roomId = this.selectedRoomId();
    if (!roomId || !this.canCompactAgent(agentId) || this.isAgentRunning(agentId)) return;
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

  loadBriefings(): void {
    this.api.briefings.list().subscribe({
      next: (briefings) => {
        this.briefings.set(briefings);
        const selected = this.selectedBriefingId();
        if (selected && briefings.some((briefing) => briefing.id === selected)) return;
        if (briefings[0]) {
          this.openBriefing(briefings[0].id, true);
        } else {
          this.selectedBriefingId.set(null);
          this.selectedBriefing.set(null);
        }
      },
      error: (err: unknown) => {
        this.briefingError.set(err instanceof Error ? err.message : 'failed to load briefings');
      },
    });
  }

  private loadRoomDetail(roomId: string): void {
    this.syncMissionActionTargets();
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
    this.loadArtifacts(roomId);
  }

  sendMessage(input: HTMLInputElement): void {
    const roomId = this.selectedRoomId();
    const text = input.value.trim();
    if (!roomId || !text) return;
    this.ws.postMessage(roomId, this.authorName(), text);
    input.value = '';
    this.closeMentionAutocomplete();
  }

  refreshMentionAutocomplete(input: HTMLInputElement): void {
    if (this.mentionCloseTimer !== null) {
      window.clearTimeout(this.mentionCloseTimer);
      this.mentionCloseTimer = null;
    }
    const token = this.detectComposerMentionToken(input);
    this.composerMentionToken.set(token);
    const suggestions = token ? this.mentionSuggestions() : [];
    if (this.mentionSelectedIndex() >= suggestions.length) this.mentionSelectedIndex.set(0);
  }

  handleComposerKeydown(event: KeyboardEvent, input: HTMLInputElement): void {
    const suggestions = this.mentionSuggestions();
    if (suggestions.length === 0) {
      if (event.key === 'Escape') this.closeMentionAutocomplete();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.mentionSelectedIndex.update((index) => (index + 1) % suggestions.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.mentionSelectedIndex.update((index) =>
        (index - 1 + suggestions.length) % suggestions.length,
      );
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      this.applyMentionSuggestion(input, suggestions[this.mentionSelectedIndex()] ?? suggestions[0]!);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeMentionAutocomplete();
    }
  }

  handleComposerKeyup(event: KeyboardEvent, input: HTMLInputElement): void {
    if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
    this.refreshMentionAutocomplete(input);
  }

  applyMentionSuggestion(input: HTMLInputElement, suggestion: MentionSuggestion): void {
    const token = this.composerMentionToken();
    if (!token) return;
    const before = input.value.slice(0, token.start);
    const after = input.value.slice(token.end);
    const suffix = after && /^\s/.test(after) ? '' : ' ';
    const insert = `@${suggestion.handle}${suffix}`;
    input.value = `${before}${insert}${after}`;
    const cursor = before.length + insert.length;
    this.closeMentionAutocomplete();
    input.focus();
    input.setSelectionRange(cursor, cursor);
  }

  closeMentionAutocomplete(): void {
    if (this.mentionCloseTimer !== null) {
      window.clearTimeout(this.mentionCloseTimer);
      this.mentionCloseTimer = null;
    }
    this.composerMentionToken.set(null);
    this.mentionSelectedIndex.set(0);
  }

  closeMentionAutocompleteSoon(): void {
    if (this.mentionCloseTimer !== null) window.clearTimeout(this.mentionCloseTimer);
    this.mentionCloseTimer = window.setTimeout(() => {
      this.closeMentionAutocomplete();
    }, 120);
  }

  canManageQueuedMessage(message: Message): boolean {
    return (
      message.authorKind === 'human' &&
      message.deliveryStatus === 'queued' &&
      message.authorId === this.authorName()
    );
  }

  isEditingQueuedMessage(message: Message): boolean {
    return this.editingQueuedMessageId() === message.id;
  }

  beginQueuedMessageEdit(message: Message): void {
    if (!this.canManageQueuedMessage(message)) return;
    this.editingQueuedMessageId.set(message.id);
    this.queuedMessageError.set('');
  }

  cancelQueuedMessageEdit(): void {
    this.editingQueuedMessageId.set(null);
    this.queuedMessageError.set('');
  }

  saveQueuedMessageEdit(message: Message, input: HTMLInputElement): void {
    if (!this.canManageQueuedMessage(message)) return;
    const text = input.value.trim();
    if (!text) {
      this.queuedMessageError.set('message text required');
      return;
    }
    this.api.messages
      .update(message.roomId, message.id, { authorId: this.authorName(), text })
      .subscribe({
        next: (updated) => {
          this.messages.update((messages) => this.upsert(messages, updated));
          this.cancelQueuedMessageEdit();
        },
        error: (err: unknown) => {
          this.queuedMessageError.set(this.apiErrorText(err, 'failed to edit queued message'));
        },
      });
  }

  retractQueuedMessage(message: Message): void {
    if (!this.canManageQueuedMessage(message)) return;
    this.api.messages.retract(message.roomId, message.id, this.authorName()).subscribe({
      next: (update) => {
        this.messages.update((messages) =>
          messages.filter((candidate) => candidate.id !== update.messageId),
        );
        if (this.editingQueuedMessageId() === update.messageId) this.cancelQueuedMessageEdit();
      },
      error: (err: unknown) => {
        this.queuedMessageError.set(this.apiErrorText(err, 'failed to retract queued message'));
      },
    });
  }

  composerPlaceholder(): string {
    return this.isRoomWorking() ? 'queue context for the active agent run' : 'message the room';
  }

  stopActiveRuns(): void {
    const roomId = this.selectedRoomId();
    if (!roomId) return;
    this.ws.stopRuns(roomId, this.authorName());
  }

  attachFileToMessage(input: HTMLInputElement): void {
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

  canRemoveArtifact(artifact: Artifact): boolean {
    return artifact.kind === 'fixture' || artifact.kind === 'draft-artifact';
  }

  removeArtifact(artifact: Artifact): void {
    const roomId = this.selectedRoomId();
    if (!roomId || !this.canRemoveArtifact(artifact)) return;
    this.api.artifacts.remove(roomId, artifact).subscribe(() => this.loadArtifacts(roomId));
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

  private buildOperationMetrics(): OpsMetric[] {
    this.now();
    const totalAgents = this.roomAgents().length;
    const activeAgents = new Set(this.runningRuns().map((run) => run.agentId)).size;
    const attention = this.attentionItems().length;
    const control = this.taskControl();
    const checklistTotal = control?.checklistItems.length ?? 0;
    const checklistDone =
      control?.checklistItems.filter((item) => item.status === 'done').length ?? 0;
    const checklistBlocked =
      control?.checklistItems.filter((item) => item.status === 'blocked').length ?? 0;
    const phaseTotal = control?.phases.length ?? 0;
    const phaseDone = control?.phases.filter((phase) => phase.status === 'done').length ?? 0;

    return [
      {
        id: 'agents',
        label: 'active agents',
        value: `${activeAgents}/${totalAgents || 0}`,
        detail: this.runningRuns().length
          ? `${this.runningRuns().length} active run(s)`
          : 'no active runs',
        tone: activeAgents > 0 ? 'good' : 'muted',
      },
      {
        id: 'attention',
        label: 'attention queue',
        value: String(attention),
        detail: attention ? 'human-visible blockers or waits' : 'nothing requires attention',
        tone: attention ? 'warn' : 'good',
      },
      {
        id: 'progress',
        label: 'mission progress',
        value: checklistTotal
          ? `${checklistDone}/${checklistTotal}`
          : `${phaseDone}/${phaseTotal || 0}`,
        detail: checklistTotal
          ? `${checklistBlocked} blocked checklist item(s)`
          : `${phaseDone}/${phaseTotal || 0} phase gate(s) closed`,
        tone: checklistBlocked ? 'warn' : checklistTotal || phaseTotal ? 'good' : 'muted',
      },
      {
        id: 'spend',
        label: 'runtime / tokens',
        value: this.formatDurationMs(this.totalRuntimeMs()),
        detail: `${this.formatTokenCount(this.totalEstimatedPromptTokens())} prompt-estimated tokens`,
        tone: this.runs().length ? 'info' : 'muted',
      },
    ];
  }

  private buildAttentionItems(): AttentionItem[] {
    const items: AttentionItem[] = [];
    const now = this.now();

    for (const request of this.permissionRequests().filter(
      (request) => request.status === 'pending',
    )) {
      items.push({
        id: `permission:${request.id}`,
        tone: 'warn',
        label: 'permission',
        title: `${this.activityActor(request.agentId)} needs ${this.permissionRequestLabel(request)}`,
        detail: `${request.target}: ${this.oneLine(request.reason, 180)}`,
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
        detail: this.oneLine(message.text, 180),
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
        detail: `${run.attempt && run.attempt > 1 ? `attempt ${run.attempt}; ` : ''}${retryMs ? `due in ${this.formatDurationMs(retryMs)}; ` : ''}${this.oneLine(run.lifecycleReason || run.error || 'waiting for retry window', 180)}`,
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
        detail: this.oneLine(
          run.lifecycleReason ||
            `no provider signal for ${this.formatDurationMs(this.runIdleMs(run))}`,
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
        detail: this.oneLine(
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
        detail: this.oneLine(
          item.blockedReason || item.statusNote || 'blocked without recorded reason',
          180,
        ),
        createdAt: item.updatedAt || item.createdAt,
        agentId: item.ownerAgentId || undefined,
      });
    }

    const priority: Record<OpsTone, number> = { danger: 0, warn: 1, info: 2, good: 3, muted: 4 };
    return items
      .sort(
        (a, b) => (priority[a.tone] ?? 4) - (priority[b.tone] ?? 4) || b.createdAt - a.createdAt,
      )
      .slice(0, 12);
  }

  private buildActiveSessionRows(): ActiveSessionRow[] {
    this.now();
    return this.runningRuns()
      .map((run) => ({
        run,
        runtime: this.elapsedLabel(run.startedAt, null),
        turns: this.runTurnLabel(run),
        tokens: run.estimatedPromptTokens
          ? this.formatTokenCount(run.estimatedPromptTokens)
          : 'unknown',
        signal: this.runActionSignal(run),
        contextUsage: this.agentContextUsage(run.agentId),
      }))
      .sort((a, b) => (b.run.startedAt ?? 0) - (a.run.startedAt ?? 0));
  }

  private buildProviderCapacityRows(): ProviderCapacityRow[] {
    return this.roomAgents().map((agentId) => {
      const usage = this.agentContextUsage(agentId);
      const running = this.runningRuns().some((run) => run.agentId === agentId);
      if (!usage) {
        return {
          agentId,
          running,
          usage: null,
          percent: 0,
          label: 'no telemetry',
          detail: running ? 'waiting for provider usage signal' : 'no recent context report',
          tone: running ? 'info' : 'muted',
        };
      }
      const percent = this.agentContextPercent(usage);
      const used = this.agentContextUsedTokens(usage);
      const remaining =
        usage.contextWindow !== undefined ? Math.max(0, usage.contextWindow - used) : undefined;
      const tone: OpsTone = !usage.contextWindow
        ? 'info'
        : percent >= 88
          ? 'danger'
          : percent >= 72
            ? 'warn'
            : 'good';
      return {
        agentId,
        running,
        usage,
        percent,
        label: usage.contextWindow
          ? `${Math.round(percent)}% used`
          : `${this.formatTokenCount(used)} used`,
        detail:
          remaining !== undefined
            ? `${this.formatTokenCount(remaining)} remaining / ${this.agentContextLabel(usage)}`
            : this.agentContextLabel(usage),
        tone,
      };
    });
  }

  private totalRuntimeMs(): number {
    this.now();
    return this.runs().reduce((total, run) => total + this.runDurationMs(run), 0);
  }

  private totalEstimatedPromptTokens(): number {
    return this.runs().reduce((total, run) => total + (run.estimatedPromptTokens || 0), 0);
  }

  private runDurationMs(run: AgentRun): number {
    if (!run.startedAt) return 0;
    const end = run.completedAt ?? (run.status === 'running' ? this.now() : run.startedAt);
    return Math.max(0, end - run.startedAt);
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
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes < 60) return `${minutes}m ${rest}s`;
    const hours = Math.floor(minutes / 60);
    const minRest = minutes % 60;
    return `${hours}h ${minRest}m`;
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

  private buildMissionGraphSummary(): MissionGraphSummary {
    const control = this.taskControl();
    const lanes = this.missionGraphLanes();
    const cards = lanes.flatMap((lane) => lane.cards);
    return {
      phasesDone: control?.phases.filter((phase) => phase.status === 'done').length ?? 0,
      phasesTotal: control?.phases.length ?? 0,
      itemsDone: cards.filter((card) => card.item.status === 'done').length,
      itemsTotal: cards.length,
      ready: cards.filter((card) => card.ready).length,
      blocked: cards.filter((card) => card.item.status === 'blocked').length,
      activeRuns: cards.filter((card) => card.activeRun).length,
      evidence: cards.reduce((total, card) => total + card.evidenceCount, 0),
      artifacts: this.artifacts()?.files.length ?? 0,
      collaboration: this.collaboration().length,
    };
  }

  private buildMissionBoardSwimlanes(): MissionBoardSwimlane[] {
    return this.missionGraphLanes().map((lane) => {
      const cardsByColumn = this.emptyMissionBoardColumns();
      for (const card of lane.cards) {
        cardsByColumn[this.missionBoardColumnForCard(card)].push(card);
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

  private emptyMissionBoardColumns(): Record<MissionBoardColumnId, MissionGraphCard[]> {
    return {
      ready: [],
      active: [],
      blocked: [],
      review: [],
      done: [],
    };
  }

  private missionBoardColumnForCard(card: MissionGraphCard): MissionBoardColumnId {
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

  private findMissionGraphCard(itemId: string | null): MissionGraphCard | null {
    if (!itemId) return null;
    for (const lane of this.missionGraphLanes()) {
      const card = lane.cards.find((candidate) => candidate.item.id === itemId);
      if (card) return card;
    }
    return null;
  }

  private buildMissionGraphLanes(): MissionGraphLane[] {
    const control = this.taskControl();
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

    const runsByItemId = this.buildChecklistRunMap(items);
    const phaseIds = new Set(control.phases.map((phase) => phase.id));
    const cardFor = (item: TaskChecklistItem) =>
      this.buildMissionGraphCard(item, {
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
      return this.buildMissionGraphLane({
        id: phase.id,
        phase,
        title: phase.title,
        status: phase.status,
        gate: phase.gate || phase.description,
        planLabel: this.planLabel(phase.planId),
        cards,
      });
    });

    const backlogCards = items
      .filter((item) => !item.phaseId || !phaseIds.has(item.phaseId))
      .map(cardFor)
      .sort((a, b) => a.item.sortOrder - b.item.sortOrder || a.item.createdAt - b.item.createdAt);
    if (backlogCards.length > 0 || lanes.length === 0) {
      lanes.push(
        this.buildMissionGraphLane({
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

  private buildMissionGraphLane(input: {
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

  private buildMissionGraphCard(
    item: TaskChecklistItem,
    context: {
      itemsById: Map<string, TaskChecklistItem>;
      notesByItemId: Map<string, TaskChecklistNote[]>;
      dependentsByItemId: Map<string, TaskChecklistItem[]>;
      runsByItemId: Map<string, AgentRun[]>;
    },
  ): MissionGraphCard {
    const dependencies = item.dependencyIds
      .map((id) => context.itemsById.get(id))
      .filter((dependency): dependency is TaskChecklistItem => Boolean(dependency))
      .map((dependency) => this.missionGraphDependency(dependency));
    const dependents = (context.dependentsByItemId.get(item.id) ?? []).map((dependent) =>
      this.missionGraphDependency(dependent),
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

  private missionGraphDependency(item: TaskChecklistItem): MissionGraphDependency {
    return {
      id: item.id,
      title: item.title,
      status: item.status,
      done: item.status === 'done' || item.status === 'skipped',
    };
  }

  private buildChecklistRunMap(items: TaskChecklistItem[]): Map<string, AgentRun[]> {
    const runsByItemId = new Map<string, AgentRun[]>();
    const addedRunIds = new Map<string, Set<string>>();
    const runsById = new Map(this.runs().map((run) => [run.id, run]));

    for (const action of this.runActions()) {
      if (
        action.label !== 'YOLO lane assigned' &&
        !/^mission task (create|update)$/i.test(action.label)
      ) {
        continue;
      }
      const item = this.checklistItemForRunAction(items, action);
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

  private checklistItemForRunAction(
    items: TaskChecklistItem[],
    action: AgentRunAction,
  ): TaskChecklistItem | null {
    const detail = action.detail || '';
    const idMatch = /\[id=([^\]]+)\]/i.exec(detail);
    if (idMatch?.[1]) {
      const byId = items.find((item) => item.id === idMatch[1]);
      if (byId) return byId;
    }

    const parsed = this.parseActivityDetail(detail);
    const candidateTitle =
      parsed?.title || this.activityTaskTitle(detail) || detail.replace(/\s+\([^()]+\)$/i, '');
    const normalized = this.normalizeMissionGraphTitle(candidateTitle);
    if (!normalized) return null;
    return (
      items.find((item) => this.normalizeMissionGraphTitle(item.title) === normalized) ??
      items.find((item) => {
        const title = this.normalizeMissionGraphTitle(item.title);
        return title.length > 0 && (normalized.startsWith(title) || title.startsWith(normalized));
      }) ??
      null
    );
  }

  private normalizeMissionGraphTitle(value: string): string {
    return value
      .replace(/\s*\[id=[^\]]+\]\s*$/i, '')
      .replace(/\s+\([^()]+\)$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  missionGraphLaneClass(lane: MissionGraphLane): string {
    return `is-${lane.tone}`;
  }

  missionGraphCardClass(card: MissionGraphCard): string {
    return `is-${card.tone}`;
  }

  toggleBoardPhaseCollapsed(phaseId: string): void {
    const set = new Set(this.collapsedBoardPhases());
    if (set.has(phaseId)) set.delete(phaseId);
    else set.add(phaseId);
    this.collapsedBoardPhases.set(set);
  }

  isBoardPhaseCollapsed(phaseId: string): boolean {
    return this.collapsedBoardPhases().has(phaseId);
  }

  boardPhaseGroup(lane: MissionBoardSwimlane): 'active' | 'queued' | 'done' {
    if (lane.status === 'active') return 'active';
    if (lane.status === 'done') return 'done';
    return 'queued';
  }

  boardLaneSortOrder(lane: MissionBoardSwimlane): number {
    const graphLane = this.missionGraphLanes().find((l) => l.id === lane.id);
    return graphLane?.phase?.sortOrder ?? 0;
  }

  boardLaneCounts(lane: MissionBoardSwimlane): {
    ready: number;
    active: number;
    blocked: number;
    review: number;
    done: number;
    total: number;
  } {
    const r = lane.cardsByColumn.ready.length;
    const a = lane.cardsByColumn.active.length;
    const b = lane.cardsByColumn.blocked.length;
    const v = lane.cardsByColumn.review.length;
    const d = lane.cardsByColumn.done.length;
    return { ready: r, active: a, blocked: b, review: v, done: d, total: r + a + b + v + d };
  }

  missionGraphRunLabel(card: MissionGraphCard): string {
    const run = card.activeRun ?? card.latestRun;
    if (!run) return '';
    const prefix = run.status === 'running' ? 'running' : run.status;
    const duration = this.elapsedLabel(run.startedAt, run.completedAt);
    return `${prefix} / ${this.activityActor(run.agentId)} / ${duration}`;
  }

  toggleChecklistPhaseCollapsed(phaseId: string): void {
    const set = new Set(this.collapsedChecklistPhases());
    if (set.has(phaseId)) set.delete(phaseId);
    else set.add(phaseId);
    this.collapsedChecklistPhases.set(set);
  }

  isChecklistPhaseCollapsed(phaseId: string): boolean {
    return this.collapsedChecklistPhases().has(phaseId);
  }

  checklistPhaseItems(phaseId: string): TaskChecklistItem[] {
    return this.taskControl()?.checklistItems.filter((item) => item.phaseId === phaseId) ?? [];
  }

  unphasedChecklistItems(): TaskChecklistItem[] {
    const control = this.taskControl();
    if (!control) return [];
    const phaseIds = new Set(control.phases.map((p) => p.id));
    return control.checklistItems.filter((item) => !item.phaseId || !phaseIds.has(item.phaseId));
  }

  checklistPhaseProgressPercent(phaseId: string): number {
    const items = this.checklistPhaseItems(phaseId);
    if (items.length === 0) return 0;
    const done = items.filter(
      (item) => item.status === 'done' || item.status === 'skipped',
    ).length;
    return Math.round((done / items.length) * 100);
  }

  checklistPhaseProgressLabel(phaseId: string): string {
    const items = this.checklistPhaseItems(phaseId);
    const done = items.filter(
      (item) => item.status === 'done' || item.status === 'skipped',
    ).length;
    return `${done} of ${items.length}`;
  }

  checklistPhaseStatusLabel(status: string): string {
    if (status === 'active') return 'active';
    if (status === 'done') return 'complete';
    if (status === 'blocked') return 'blocked';
    return 'queued';
  }

  checklistItemStatusLabel(item: TaskChecklistItem): string {
    if (item.status === 'blocked') return 'blocked';
    if (item.status === 'done') return 'done';
    if (item.status === 'skipped') return 'skipped';
    if (this.isWaitingOnDependencies(item)) return 'waiting';
    return 'open';
  }

  missionGraphNotePreview(card: MissionGraphCard): string {
    const note = card.latestNote;
    if (!note) return '';
    return `${this.activityActor(note.authorId)} / ${note.kind}: ${this.oneLine(note.body, 160)}`;
  }

  focusMissionGraphItem(item: TaskChecklistItem): void {
    this.selectedMissionAction.set('execute');
    this.missionActionChecklistItemId.set(item.id);
    this.taskInspectorItemId.set(item.id);
  }

  closeTaskInspector(): void {
    this.taskInspectorItemId.set(null);
  }

  shortTaskId(id: string): string {
    return id.length > 10 ? id.slice(0, 10) : id;
  }

  selectRoadmapPhase(laneId: string): void {
    this.roadmapSelectedPhaseId.set(laneId);
    this.roadmapStatusFilter.set(null);
  }

  toggleRoadmapStatusFilter(filter: RoadmapStatusFilter): void {
    this.roadmapStatusFilter.update((current) => (current === filter ? null : filter));
  }

  clearRoadmapStatusFilter(): void {
    this.roadmapStatusFilter.set(null);
  }

  roadmapPhaseProgressPercent(lane: MissionGraphLane): number {
    if (!lane.counts.total) return 0;
    return Math.round((lane.counts.done / lane.counts.total) * 100);
  }

  roadmapPhaseSubline(lane: MissionGraphLane): string {
    const parts: string[] = [];
    parts.push(lane.status);
    if (lane.counts.ready) parts.push(`${lane.counts.ready} ready`);
    if (lane.counts.blocked) parts.push(`${lane.counts.blocked} blocked`);
    return parts.join(' · ');
  }

  roadmapStatusBucketCount(lane: MissionGraphLane | null, bucket: RoadmapStatusFilter): number {
    if (!lane) return 0;
    if (bucket === 'ready') return lane.cards.filter((c) => c.ready).length;
    if (bucket === 'in-progress') return lane.cards.filter((c) => !!c.activeRun).length;
    if (bucket === 'blocked')
      return lane.cards.filter((c) => c.item.status === 'blocked' || c.waiting).length;
    return lane.cards.filter((c) => c.item.status === 'done').length;
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

  taskInspectorReference(card: MissionGraphCard): string {
    const item = card.item;
    const detail = item.detail ? ` - ${item.detail}` : '';
    return `Checklist item ${item.id}: ${item.title}${detail}`;
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

  taskInspectorMissionBlock(card: MissionGraphCard): string {
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
  }

  copyChecklistItemId(item: TaskChecklistItem): void {
    void navigator.clipboard?.writeText(item.id);
  }

  copyTaskInspectorReference(card: MissionGraphCard): void {
    void navigator.clipboard?.writeText(this.taskInspectorReference(card));
  }

  copyTaskInspectorMissionBlock(card: MissionGraphCard): void {
    void navigator.clipboard?.writeText(this.taskInspectorMissionBlock(card));
  }

  taskInspectorBlockedSummary(card: MissionGraphCard): string {
    if (card.item.blockedReason) return card.item.blockedReason;
    if (card.waiting && card.dependencies.length) {
      return `Waiting on ${card.dependencies
        .filter((dependency) => !dependency.done)
        .map((dependency) => dependency.title)
        .join(', ')}.`;
    }
    if (card.item.status === 'blocked') return 'Blocked without a recorded reason.';
    return '';
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
    if (!startedAt) return 'unknown';
    const end = completedAt ?? this.now();
    const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}m ${rest}s`;
  }

  targetStatusText(item: PermissionRequest | AgentRun): string {
    const kind = 'targetKind' in item ? item.targetKind : item.permissionTargetKind || 'unknown';
    const exists = 'targetExists' in item ? item.targetExists : item.permissionTargetExists;
    if (exists === true) return `exists (${kind})`;
    if (exists === false) return `missing (${kind})`;
    return kind || 'unknown';
  }

  formatBytes(bytes: number | undefined): string {
    if (!Number.isFinite(bytes)) return '0 B';
    const value = bytes ?? 0;
    if (value < 1024) return `${value} B`;
    const kb = value / 1024;
    if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  }

  formatShortTime(timestamp: number | undefined): string {
    if (!timestamp) return 'unknown';
    return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  formatRelativeAgo(timestamp: number | undefined): string {
    if (!timestamp) return 'unknown';
    const delta = this.now() - timestamp;
    if (delta < 0) return 'just now';
    if (delta < 5_000) return 'just now';
    return `${this.formatDurationMs(delta)} ago`;
  }

  pad2(value: number): string {
    return String(Math.max(0, Math.floor(value))).padStart(2, '0');
  }

  selectMissionTab(tab: MissionTab): void {
    this.missionTab.set(tab);
  }

  formatDateTime(timestamp: number | undefined | null): string {
    if (!timestamp) return 'unknown';
    return new Date(timestamp).toLocaleString();
  }

  oneLine(text: string | undefined | null, maxChars = 220): string {
    const normalized = (text || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, Math.max(0, maxChars - 1))}...`;
  }

  capabilityText(capabilities: string[] | undefined): string {
    return capabilities && capabilities.length > 0 ? capabilities.join(', ') : 'none';
  }

  permissionModeLabel(mode: string | undefined): string {
    if (mode === 'full-auto') return 'full auto';
    if (mode === 'edit') return 'edit/write';
    return 'read-only';
  }

  permissionRequestLabel(request: PermissionRequest): string {
    if (request.requestedMode && request.requestedMode !== request.mode) {
      if (
        ['bash', 'shell', 'command', 'run-command', 'git', 'commit', 'git-commit'].includes(
          request.requestedMode,
        )
      ) {
        return `${request.requestedMode} command`;
      }
      return `${request.requestedMode} (${this.permissionModeLabel(request.mode)})`;
    }
    return this.permissionModeLabel(request.mode);
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

  agentContextUsage(agentId: AgentId): AgentContextUsage | null {
    const usage = this.latestContextUsageByAgent().get(agentId) ?? null;
    return usage?.quotaOnly ? null : usage;
  }

  agentContextPercent(usage: AgentContextUsage): number {
    const usedTokens = this.agentContextUsedTokens(usage);
    if (usage.usedTokens === usedTokens && Number.isFinite(usage.percentUsed)) {
      return Math.max(0, Math.min(100, usage.percentUsed ?? 0));
    }
    if (!usage.contextWindow) return 0;
    return Math.max(0, Math.min(100, (usedTokens / usage.contextWindow) * 100));
  }

  agentContextTone(usage: AgentContextUsage): string {
    const percent = this.agentContextPercent(usage);
    if (!usage.contextWindow) return 'agent-context--unknown';
    if (percent >= 88) return 'agent-context--red';
    if (percent >= 72) return 'agent-context--yellow';
    return 'agent-context--green';
  }

  agentContextLabel(usage: AgentContextUsage): string {
    const model = usage.reasoningEffort ? `${usage.model}/${usage.reasoningEffort}` : usage.model;
    const window = usage.contextWindow ? this.formatTokenCount(usage.contextWindow) : 'unknown';
    const prefix = this.agentContextIsEstimated(usage) ? '~' : '';
    return `${model} · ${prefix}${this.formatTokenCount(this.agentContextUsedTokens(usage))}/${window}`;
  }

  agentContextModelLabel(usage: AgentContextUsage): string {
    if (!usage.model) return '';
    return usage.reasoningEffort ? `${usage.model}/${usage.reasoningEffort}` : usage.model;
  }

  agentContextTitle(usage: AgentContextUsage): string {
    const usedTokens = this.agentContextUsedTokens(usage);
    const parts = [
      `model: ${usage.reasoningEffort ? `${usage.model}/${usage.reasoningEffort}` : usage.model}`,
      `used: ${this.formatTokenCount(usedTokens)} tokens${this.agentContextIsEstimated(usage) ? ' estimated' : ''}`,
      usage.contextWindow
        ? `window: ${this.formatTokenCount(usage.contextWindow)} tokens`
        : 'window unknown',
      usage.contextWindow
        ? `remaining: ${this.formatTokenCount(Math.max(0, usage.contextWindow - usedTokens))} tokens`
        : '',
      usage.reportedUsedTokens !== undefined && usage.reportedUsedTokens !== usedTokens
        ? `provider reported: ${this.formatTokenCount(usage.reportedUsedTokens)} tokens`
        : '',
      usage.inputTokens !== undefined ? `input: ${this.formatTokenCount(usage.inputTokens)}` : '',
      usage.outputTokens !== undefined
        ? `output: ${this.formatTokenCount(usage.outputTokens)}`
        : '',
      usage.reasoningOutputTokens !== undefined
        ? `reasoning: ${this.formatTokenCount(usage.reasoningOutputTokens)}`
        : '',
    ].filter(Boolean);
    return parts.join(' / ');
  }

  agentContextUsedTokens(usage: AgentContextUsage): number {
    if (
      usage.provider === 'codex' &&
      usage.contextWindow &&
      usage.inputTokens !== undefined &&
      usage.inputTokens > usage.contextWindow &&
      usage.cachedInputTokens !== undefined
    ) {
      return Math.max(0, usage.inputTokens - usage.cachedInputTokens + (usage.outputTokens ?? 0));
    }
    if (
      usage.provider === 'claude' &&
      usage.contextWindow &&
      usage.usedTokens > usage.contextWindow &&
      usage.cacheReadInputTokens !== undefined
    ) {
      return Math.max(0, usage.usedTokens - usage.cacheReadInputTokens);
    }
    return usage.usedTokens;
  }

  agentContextIsEstimated(usage: AgentContextUsage): boolean {
    return usage.estimated === true || this.agentContextUsedTokens(usage) !== usage.usedTokens;
  }

  agentFiveHourUsage(agentId: AgentId): AgentQuotaWindowUsage | null {
    return this.agentQuotaUsage(agentId)?.fiveHour ?? null;
  }

  agentSevenDayUsage(agentId: AgentId): AgentQuotaWindowUsage | null {
    return this.agentQuotaUsage(agentId)?.sevenDay ?? null;
  }

  agentQuotaUsage(agentId: AgentId): AgentQuotaUsage | null {
    const direct = this.latestContextUsageByAgent().get(agentId)?.quota;
    if (direct) return direct;
    const providerId = this.roomAgentProfile(this.selectedRoom(), agentId).providerId;
    const actions = [...this.runActions()].sort((a, b) => b.createdAt - a.createdAt);
    for (const action of actions) {
      if (!action.agentId || !action.contextUsage?.quota) continue;
      const profile = this.roomAgentProfile(this.selectedRoom(), action.agentId);
      if (profile.providerId === providerId) return action.contextUsage.quota;
    }
    return null;
  }

  // Ring geometry: r=26, C=2π·26=163.36; wedge spans 116° = 52.64 of arc, 4° gaps.
  private static readonly RING_CIRCUMFERENCE = 163.36;
  private static readonly RING_WEDGE_ARC = 52.64;

  agentRingTrackDash(): string {
    const arc = App.RING_WEDGE_ARC;
    const gap = App.RING_CIRCUMFERENCE - arc;
    return `${arc.toFixed(2)} ${gap.toFixed(2)}`;
  }

  agentRingDash(percent: number | null | undefined): string {
    const safe = Math.max(0, Math.min(100, percent ?? 0));
    const fill = (safe / 100) * App.RING_WEDGE_ARC;
    const remainder = App.RING_CIRCUMFERENCE - fill;
    return `${fill.toFixed(2)} ${remainder.toFixed(2)}`;
  }

  agentRingCtxPercent(agentId: AgentId): number {
    const usage = this.agentContextUsage(agentId);
    return usage ? this.agentContextPercent(usage) : 0;
  }

  agentRingCtxPercentRounded(agentId: AgentId): number {
    const usage = this.agentContextUsage(agentId);
    return usage ? this.agentContextPercentRounded(usage) : 0;
  }

  agentRingCtxDash(agentId: AgentId): string {
    return this.agentRingDash(this.agentRingCtxPercent(agentId));
  }

  agentRingFiveHourPercent(agentId: AgentId): number | null {
    return this.agentFiveHourUsage(agentId)?.percent ?? null;
  }

  agentRingFiveHourPercentRounded(agentId: AgentId): string {
    const percent = this.agentRingFiveHourPercent(agentId);
    return percent === null ? '—' : `${Math.round(percent)}%`;
  }

  agentRingFiveHourDash(agentId: AgentId): string {
    return this.agentRingDash(this.agentRingFiveHourPercent(agentId));
  }

  agentRingSevenDayPercent(agentId: AgentId): number | null {
    return this.agentSevenDayUsage(agentId)?.percent ?? null;
  }

  agentRingSevenDayPercentRounded(agentId: AgentId): string {
    const percent = this.agentRingSevenDayPercent(agentId);
    return percent === null ? '—' : `${Math.round(percent)}%`;
  }

  agentRingSevenDayDash(agentId: AgentId): string {
    return this.agentRingDash(this.agentRingSevenDayPercent(agentId));
  }

  agentRingCtxTooltip(agentId: AgentId): string {
    const usage = this.agentContextUsage(agentId);
    if (!usage) return 'Compact context (no usage data yet)';
    const pct = this.agentContextPercentRounded(usage);
    const used = this.formatTokenCount(this.agentContextUsedTokens(usage));
    const window = usage.contextWindow ? this.formatTokenCount(usage.contextWindow) : '?';
    const action = this.canCompactAgent(agentId)
      ? this.isAgentRunning(agentId)
        ? ' — compact when this agent is idle'
        : this.compactingAgent() === agentId
          ? ' — compacting…'
          : ' — click to compact'
      : '';
    return `Context: ${pct}% used · ${used} / ${window} tokens${action}`;
  }

  agentRingFiveHourTooltip(agentId: AgentId): string {
    const data = this.agentFiveHourUsage(agentId);
    if (!data) return '5h quota usage: not yet tracked';
    const reset = data.resetsAt ? ` (resets in ${this.formatResetWindow(data.resetsAt - Date.now())})` : '';
    const status = data.status ? ` / ${data.status}` : '';
    return data.percent === undefined
      ? `5h quota${reset}: usage percent unavailable${status}`
      : `5h quota usage${reset}: ${Math.round(data.percent)}%${status}`;
  }

  agentRingSevenDayTooltip(agentId: AgentId): string {
    const data = this.agentSevenDayUsage(agentId);
    if (!data) return '7d quota usage: not yet tracked';
    const reset = data.resetsAt ? ` (resets in ${this.formatResetWindow(data.resetsAt - Date.now())})` : '';
    const status = data.status ? ` / ${data.status}` : '';
    return data.percent === undefined
      ? `7d quota${reset}: usage percent unavailable${status}`
      : `7d quota usage${reset}: ${Math.round(data.percent)}%${status}`;
  }

  agentModelLabel(agentId: AgentId): string {
    const usage = this.agentContextUsage(agentId);
    if (!usage?.model) return '';
    return usage.reasoningEffort ? `${usage.model} · ${usage.reasoningEffort}` : usage.model;
  }

  ringCtxClick(agentId: AgentId, event: Event): void {
    if (!this.canCompactAgent(agentId)) return;
    if (this.isAgentRunning(agentId) || this.compactingAgent() === agentId) return;
    this.openCompactAgent(agentId, event);
  }

  private formatResetWindow(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return 'now';
    const totalMin = Math.round(ms / 60000);
    const days = Math.floor(totalMin / (60 * 24));
    const remain = totalMin - days * 60 * 24;
    const hours = Math.floor(remain / 60);
    const mins = remain - hours * 60;
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return mins > 0 ? `${hours}h${this.pad2(mins)}m` : `${hours}h`;
    return `${mins}m`;
  }

  formatTokenCount(tokens: number | undefined): string {
    if (!Number.isFinite(tokens)) return 'unknown';
    const value = Math.max(0, tokens ?? 0);
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
    return String(Math.round(value));
  }

  private buildMissionActivityEvents(): MissionActivityEvent[] {
    const runsById = new Map(this.runs().map((run) => [run.id, run]));
    const laneByRun = new Map<string, { title: string; createdAt: number; actionId: string }>();
    const events: MissionActivityEvent[] = [];

    for (const action of this.runActions()) {
      if (action.label === 'YOLO lane assigned') {
        const title = this.activityTaskTitle(action.detail);
        if (!title) continue;
        const actor = this.activityActor(action.agentId);
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

    for (const run of this.runs()) {
      const lane = laneByRun.get(run.id);
      if (lane && run.completedAt && run.status !== 'running') {
        const elapsed = this.elapsedLabel(run.startedAt, run.completedAt);
        const actor = this.activityActor(run.agentId);
        events.push({
          id: `lane-finish:${run.id}:${run.status}`,
          createdAt: run.completedAt,
          agentId: run.agentId,
          tone: run.status === 'completed' || run.status === 'empty' ? 'done' : 'blocked',
          title:
            run.status === 'completed' || run.status === 'empty'
              ? `${actor} finished "${lane.title}" in ${elapsed}`
              : `${actor} hit a failure on "${lane.title}" after ${elapsed}`,
          detail: run.error ? this.oneLine(run.error, 180) : '',
          runId: run.id,
        });
      }
      if (run.lifecycleState === 'stalled' && run.lifecycleUpdatedAt) {
        events.push({
          id: `run-stalled:${run.id}:${run.lifecycleUpdatedAt}`,
          createdAt: run.lifecycleUpdatedAt,
          agentId: run.agentId,
          tone: 'blocked',
          title: `${this.activityActor(run.agentId)} may be stalled`,
          detail: run.lifecycleReason || 'no provider signal recently',
          runId: run.id,
        });
      }
    }

    const laneRunIds = new Set(laneByRun.keys());
    for (const action of this.runActions()) {
      if (action.label === 'retry scheduled') {
        const run = runsById.get(action.runId);
        const laneTitle = laneByRun.get(action.runId)?.title;
        const actor = this.activityActor(action.agentId);
        events.push({
          id: `retry:${action.id}`,
          createdAt: action.createdAt,
          agentId: action.agentId,
          tone: 'retry',
          title: `${actor} scheduled a retry${laneTitle ? ` for "${laneTitle}"` : ''}`,
          detail: this.actionDetailText(action, 180),
          runId: run?.id ?? action.runId,
        });
        continue;
      }

      const missionEvent = this.activityFromMissionAction(action, laneRunIds);
      if (missionEvent) events.push(missionEvent);
    }

    return this.dedupeActivityEvents(events)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(-160);
  }

  private dedupeActivityEvents(events: MissionActivityEvent[]): MissionActivityEvent[] {
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
    const actor = this.activityActor(action.agentId);
    if (action.label === 'mission created') {
      return {
        id: `mission-created:${action.id}`,
        createdAt: action.createdAt,
        agentId: action.agentId,
        tone: 'mission',
        title: `${actor} created mission "${this.activityTaskTitle(action.detail)}"`,
        detail: '',
        runId: action.runId,
      };
    }

    if (/^mission plan (create|update)$/i.test(action.label)) {
      const parsed = this.parseActivityDetail(action.detail);
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
      const parsed = this.parseActivityDetail(action.detail);
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
      const parsed = this.parseActivityDetail(action.detail);
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

  private parseActivityDetail(
    detail: string | undefined,
  ): { title: string; status: string } | null {
    const text = this.readableDetailText(detail, 260);
    if (!text) return null;
    const match = text.match(/^(.*?)\s+\(([^()]+)\)$/);
    if (!match) return { title: text, status: '' };
    return {
      title: match[1]?.trim() || text,
      status: match[2]?.trim().toLowerCase() || '',
    };
  }

  private activityTaskTitle(detail: string | undefined): string {
    const text = this.readableDetailText(detail, 220);
    return text
      .replace(/\s*\[id=[^\]]+\]\s*$/i, '')
      .replace(/\s+\([^()]+\)$/i, '')
      .trim();
  }

  private activityActor(agentId: AgentId | undefined): string {
    return agentId ? this.agentDisplayName(agentId) : 'agent';
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

  browseFolderInto(input: HTMLInputElement): void {
    const initialPath = input.value.trim() || this.activeTask()?.repoPath || '';
    this.api.system.pickFolder(initialPath).subscribe(({ path }) => {
      if (path) input.value = path;
    });
  }

  createMission(
    titleInput: HTMLInputElement,
    goalInput: HTMLTextAreaElement,
    pathInput: HTMLInputElement,
    acceptanceInput: HTMLTextAreaElement,
    profileInput: HTMLSelectElement,
  ): void {
    const room = this.selectedRoom();
    const title = titleInput.value.trim();
    if (!room || !title) return;
    this.api.tasks
      .create(room.id, {
        title,
        goal: goalInput.value.trim(),
        repoPath: pathInput.value.trim(),
        acceptanceCriteria: acceptanceInput.value.trim(),
        agents: room.agents,
        capabilityProfile: profileInput.value as CapabilityProfile,
        status: 'active',
      })
      .subscribe((task) => {
        this.creatingMissionDraft.set(false);
        this.refreshTasks(room.id, task.id);
        titleInput.value = '';
        goalInput.value = '';
        pathInput.value = '';
        acceptanceInput.value = '';
        profileInput.value = 'plan';
      });
  }

  toggleMissionDraft(): void {
    this.creatingMissionDraft.update((value) => !value);
  }

  cancelMissionDraft(
    titleInput: HTMLInputElement,
    goalInput: HTMLTextAreaElement,
    pathInput: HTMLInputElement,
    acceptanceInput: HTMLTextAreaElement,
    profileInput: HTMLSelectElement,
  ): void {
    titleInput.value = '';
    goalInput.value = '';
    pathInput.value = '';
    acceptanceInput.value = '';
    profileInput.value = 'plan';
    this.creatingMissionDraft.set(false);
  }

  activateMission(task: Task): void {
    const roomId = this.selectedRoomId();
    if (!roomId || task.status === 'active') return;
    this.api.tasks.update(roomId, task.id, { status: 'active' }).subscribe(() => {
      this.refreshTasks(roomId, task.id);
    });
  }

  pauseMission(task: Task): void {
    const roomId = this.selectedRoomId();
    if (!roomId || task.status === 'paused') return;
    this.api.tasks.update(roomId, task.id, { status: 'paused' }).subscribe(() => {
      this.refreshTasks(roomId);
    });
  }

  completeMission(task: Task): void {
    const roomId = this.selectedRoomId();
    if (!roomId || task.status === 'done') return;
    this.api.tasks.update(roomId, task.id, { status: 'done' }).subscribe(() => {
      this.refreshTasks(roomId);
    });
  }

  missionActionLabel(task: Task): string {
    if (ACTIVE_TASK_STATUSES.includes(task.status)) return 'current';
    if (task.status === 'done') return 'reopen';
    return 'resume';
  }

  isCurrentMission(task: Task): boolean {
    return this.activeTask()?.id === task.id;
  }

  updateMission(
    titleInput: HTMLInputElement,
    goalInput: HTMLTextAreaElement,
    pathInput: HTMLInputElement,
    acceptanceInput: HTMLTextAreaElement,
    profileInput: HTMLSelectElement,
    statusInput: HTMLSelectElement,
    summaryInput: HTMLTextAreaElement,
  ): void {
    const roomId = this.selectedRoomId();
    const task = this.activeTask();
    const title = titleInput.value.trim();
    if (!roomId || !task || !title) return;
    this.api.tasks
      .update(roomId, task.id, {
        title,
        goal: goalInput.value.trim(),
        repoPath: pathInput.value.trim(),
        acceptanceCriteria: acceptanceInput.value.trim(),
        capabilityProfile: profileInput.value as CapabilityProfile,
        status: statusInput.value as TaskStatus,
        summary: summaryInput.value.trim(),
      })
      .subscribe((updated) => {
        this.refreshTasks(roomId, updated.id);
      });
  }

  addPhase(
    titleInput: HTMLInputElement,
    gateInput: HTMLTextAreaElement,
    statusInput: HTMLSelectElement,
  ): void {
    const roomId = this.selectedRoomId();
    const task = this.activeTask();
    const title = titleInput.value.trim();
    if (!roomId || !task || !title) return;
    this.api.tasks
      .createPhase(roomId, task.id, {
        planId: this.taskControl()?.activePlan?.id ?? null,
        title,
        gate: gateInput.value.trim(),
        status: statusInput.value as TaskPhaseStatus,
        sortOrder: (this.taskControl()?.phases.length ?? 0) + 1,
      })
      .subscribe(() => {
        titleInput.value = '';
        gateInput.value = '';
        statusInput.value = 'planned';
        this.loadTaskControl(roomId, task.id);
      });
  }

  addChecklistItem(
    titleInput: HTMLInputElement,
    detailInput: HTMLTextAreaElement,
    phaseInput: HTMLSelectElement,
    dependenciesInput: HTMLInputElement,
    ownerInput: HTMLSelectElement,
  ): void {
    const roomId = this.selectedRoomId();
    const task = this.activeTask();
    const title = titleInput.value.trim();
    if (!roomId || !task || !title) return;
    this.api.tasks
      .createChecklistItem(roomId, task.id, {
        title,
        detail: detailInput.value.trim(),
        planId:
          this.taskControl()?.phases.find((phase) => phase.id === phaseInput.value)?.planId ??
          this.taskControl()?.activePlan?.id ??
          null,
        phaseId: phaseInput.value || null,
        dependencyIds: this.parseChecklistDependencies(dependenciesInput.value),
        ownerAgentId: ownerInput.value,
        status: 'open',
        sortOrder: (this.taskControl()?.checklistItems.length ?? 0) + 1,
      })
      .subscribe(() => {
        titleInput.value = '';
        detailInput.value = '';
        phaseInput.value = '';
        dependenciesInput.value = '';
        ownerInput.value = '';
        this.loadTaskControl(roomId, task.id);
      });
  }

  addPlan(titleInput: HTMLInputElement, bodyInput: HTMLTextAreaElement): void {
    const roomId = this.selectedRoomId();
    const task = this.activeTask();
    const title = titleInput.value.trim();
    const body = bodyInput.value.trim();
    if (!roomId || !task || !title || !body) return;
    this.api.tasks
      .createPlan(roomId, task.id, {
        title,
        body,
        status: 'active',
      })
      .subscribe(() => {
        titleInput.value = '';
        bodyInput.value = '';
        this.loadTaskControl(roomId, task.id);
      });
  }

  createMissionBriefing(): void {
    const roomId = this.selectedRoomId();
    if (!roomId) return;
    const task = this.activeTask();
    this.briefingLoading.set(true);
    this.briefingError.set('');
    this.api.briefings
      .create(roomId, {
        taskId: task?.id ?? null,
        createdBy: this.authorName(),
      })
      .subscribe({
        next: (briefing) => {
          const summary: MissionBriefingSummary = {
            id: briefing.id,
            roomId: briefing.roomId,
            taskId: briefing.taskId,
            title: briefing.title,
            summary: briefing.summary,
            createdBy: briefing.createdBy,
            createdAt: briefing.createdAt,
            messageCount: briefing.messageCount,
            runCount: briefing.runCount,
          };
          this.briefings.update((briefings) => this.upsert(briefings, summary));
          this.selectedBriefingId.set(briefing.id);
          this.selectedBriefing.set(briefing);
          this.briefingLoading.set(false);
          this.selectedTab.set('briefings');
        },
        error: (err: unknown) => {
          this.briefingError.set(err instanceof Error ? err.message : 'failed to save briefing');
          this.briefingLoading.set(false);
        },
      });
  }

  openBriefing(briefingId: string, keepExisting = false): void {
    this.selectedBriefingId.set(briefingId);
    this.briefingError.set('');
    this.briefingLoading.set(true);
    if (!keepExisting) this.selectedBriefing.set(null);
    this.api.briefings.detail(briefingId).subscribe({
      next: (briefing) => {
        if (this.selectedBriefingId() !== briefingId) return;
        this.selectedBriefing.set(briefing);
        this.briefingLoading.set(false);
      },
      error: (err: unknown) => {
        if (this.selectedBriefingId() !== briefingId) return;
        this.briefingError.set(err instanceof Error ? err.message : 'failed to load briefing');
        this.briefingLoading.set(false);
      },
    });
  }

  briefingStatusCounts(briefing: MissionBriefing): string {
    const items = briefing.payload.checklistItems;
    const done = items.filter((item) => item.status === 'done').length;
    const blocked = items.filter((item) => item.status === 'blocked').length;
    return `${done}/${items.length} done${blocked ? ` / ${blocked} blocked` : ''}`;
  }

  briefingPhaseCounts(briefing: MissionBriefing): string {
    const phases = briefing.payload.phases;
    const done = phases.filter((phase) => phase.status === 'done').length;
    return `${done}/${phases.length} gates complete`;
  }

  briefingMessages(briefing: MissionBriefing): Message[] {
    return briefing.payload.messages.slice(-80);
  }

  briefingPlanHtml(body: string): string {
    return this.markdownToHtml(body);
  }

  briefingPlanLabel(briefing: MissionBriefing, planId: string | null | undefined): string {
    if (!planId) return '';
    const plan = briefing.payload.plans.find((candidate) => candidate.id === planId);
    return plan?.title ?? planId;
  }

  briefingChecklistNotes(briefing: MissionBriefing, itemId: string) {
    return briefing.payload.checklistNotes.filter((note) => note.itemId === itemId);
  }

  selectMissionAction(kind: MissionActionKind): void {
    this.selectedMissionAction.set(kind);
  }

  setMissionActionScope(scope: MissionActionScope): void {
    this.missionActionScope.set(scope);
    const agents = this.roomAgents();
    if (scope === 'single' && !agents.includes(this.missionActionAgent())) {
      this.missionActionAgent.set(agents[0] ?? '');
    }
    if (scope === 'selected') {
      const selected = this.selectedMissionActionAgents().filter((agent) => agents.includes(agent));
      this.selectedMissionActionAgents.set(selected.length > 0 ? selected : [...agents]);
    }
  }

  setMissionActionAgent(event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    this.missionActionAgent.set(value);
  }

  toggleMissionActionAgent(agentId: AgentId, event: Event): void {
    const checked = event.target instanceof HTMLInputElement ? event.target.checked : false;
    this.selectedMissionActionAgents.update((agents) => {
      if (checked) return agents.includes(agentId) ? agents : [...agents, agentId];
      return agents.filter((agent) => agent !== agentId);
    });
  }

  isMissionActionAgentSelected(agentId: AgentId): boolean {
    return this.selectedMissionActionAgents().includes(agentId);
  }

  setMissionActionChecklistItem(event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    this.missionActionChecklistItemId.set(value);
  }

  setCollapseCompletedChecklist(event: Event): void {
    const checked = event.target instanceof HTMLInputElement ? event.target.checked : false;
    this.collapseCompletedChecklist.set(checked);
    localStorage.setItem('fireside.collapseCompletedChecklist', String(checked));
  }

  missionActionDefinition(kind: MissionActionKind): MissionActionDefinition {
    return this.missionActions.find((action) => action.id === kind) ?? this.missionActions[0]!;
  }

  missionActionTargetLabel(): string {
    const agents = this.missionActionTargetAgents();
    if (this.missionActionScope() === 'team') {
      return agents.length === 1 ? 'team: 1 agent' : `team: ${agents.length} agents`;
    }
    if (agents.length === 0) return 'no agents selected';
    return agents.map((agent) => this.agentDisplayName(agent)).join(', ');
  }

  canPostMissionAction(): boolean {
    return Boolean(this.selectedRoomId() && this.missionActionTargetAgents().length > 0);
  }

  dispatchMissionAction(): void {
    const roomId = this.selectedRoomId();
    if (!roomId || !this.canPostMissionAction()) return;
    const task = this.activeTask();
    const kind = this.selectedMissionAction();
    const prompt = this.buildMissionActionPrompt(kind);
    if (kind === 'verify' && task) {
      this.api.tasks.update(roomId, task.id, { status: 'verifying' }).subscribe((updated) => {
        this.tasks.update((tasks) => this.upsert(tasks, updated));
        this.ws.postMessage(roomId, this.authorName(), prompt);
      });
      this.closeMissionActionPopover();
      return;
    }
    this.ws.postMessage(roomId, this.authorName(), prompt);
    this.closeMissionActionPopover();
  }

  toggleMissionActionPopover(): void {
    this.missionActionPopoverOpen.update((open) => !open);
  }

  closeMissionActionPopover(): void {
    this.missionActionPopoverOpen.set(false);
  }

  missionActionItemLabel(): string {
    const id = this.missionActionChecklistItemId();
    if (!id) return 'next unblocked item';
    const item = this.missionActionWorkItems().find((i) => i.id === id);
    return item ? item.title : 'next unblocked item';
  }

  @HostListener('document:keydown.escape')
  onMissionActionEscape(): void {
    if (this.missionActionPopoverOpen()) this.closeMissionActionPopover();
  }

  yoloTurnCounterText(): string {
    const status = this.yoloStatus();
    if (!status?.active) return `${status?.maxTotalReplies ?? 100} turns ready`;
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

  toggleChecklistItem(item: TaskChecklistItem, event: Event): void {
    const roomId = this.selectedRoomId();
    const task = this.activeTask();
    const checked = event.target instanceof HTMLInputElement ? event.target.checked : false;
    if (!roomId || !task) return;
    this.api.tasks
      .updateChecklistItem(roomId, task.id, item.id, {
        status: checked ? 'done' : 'open',
        statusNote: checked ? `${this.authorName()} marked this complete.` : '',
      })
      .subscribe(() => this.loadTaskControl(roomId, task.id));
  }

  assignChecklistOwner(item: TaskChecklistItem, event: Event): void {
    const roomId = this.selectedRoomId();
    const task = this.activeTask();
    const ownerAgentId = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (!roomId || !task) return;
    this.api.tasks
      .updateChecklistItem(roomId, task.id, item.id, {
        ownerAgentId,
        statusNote: ownerAgentId
          ? `${this.agentDisplayName(ownerAgentId)} took ownership of this work item.`
          : `${this.authorName()} cleared the owner.`,
      })
      .subscribe(() => this.loadTaskControl(roomId, task.id));
  }

  isAgentOwner(ownerAgentId: string): boolean {
    return this.roomAgents().includes(ownerAgentId);
  }

  isChecklistItemCollapsed(item: TaskChecklistItem): boolean {
    return this.collapseCompletedChecklist() && item.status === 'done';
  }

  checklistNotes(itemId: string) {
    return (this.taskControl()?.checklistNotes ?? []).filter((note) => note.itemId === itemId);
  }

  dependencyLabels(item: TaskChecklistItem): string {
    const items = this.taskControl()?.checklistItems ?? [];
    return item.dependencyIds
      .map((id) => items.find((candidate) => candidate.id === id)?.title ?? id)
      .join(', ');
  }

  planLabel(planId: string | null | undefined): string {
    if (!planId) return '';
    const plan = this.taskControl()?.plans.find((candidate) => candidate.id === planId);
    return plan?.title ?? planId;
  }

  isWaitingOnDependencies(item: TaskChecklistItem): boolean {
    const items = this.taskControl()?.checklistItems ?? [];
    return item.dependencyIds.some((id) => {
      const dependency = items.find((candidate) => candidate.id === id);
      return (
        dependency !== undefined && dependency.status !== 'done' && dependency.status !== 'skipped'
      );
    });
  }

  private parseChecklistDependencies(value: string): string[] {
    const items = this.taskControl()?.checklistItems ?? [];
    return [
      ...new Set(
        value
          .split(/,|;/)
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const lower = part.toLowerCase();
            return (
              items.find((item) => item.id === part)?.id ??
              items.find((item) => item.title.toLowerCase() === lower)?.id ??
              part
            );
          }),
      ),
    ];
  }

  private missionActionAddress(): string {
    if (this.missionActionScope() === 'team') return 'Team';
    return this.missionActionTargetAgents()
      .map((agent) => `@${agent}`)
      .join(' ');
  }

  private selectedMissionActionItem(): TaskChecklistItem | null {
    const itemId = this.missionActionChecklistItemId();
    const items = this.taskControl()?.checklistItems ?? [];
    return items.find((item) => item.id === itemId) ?? null;
  }

  private buildMissionActionPrompt(kind: MissionActionKind): string {
    const task = this.activeTask();
    const control = this.taskControl();
    const missionText = task ? ` "${task.title}"` : '';
    const address = this.missionActionAddress() || 'Team';
    const phase = control?.currentPhase ?? null;
    const phaseText = phase
      ? ` Current phase: "${phase.title}"${phase.gate ? `, gate: ${phase.gate}` : ''}.`
      : '';
    const item = this.selectedMissionActionItem();
    const itemText = item
      ? ` Checklist item: "${item.title}"${item.detail ? ` — ${item.detail}` : ''}.`
      : ' If no single item is clearly next, choose the next unblocked checklist item before acting.';

    switch (kind) {
      case 'plan':
        return `${address}, create or revise the active mission plan${missionText}. Record the agreed strategy and rationale in Mission Control with a /mission-plan block first, then record phase gates with /mission-phase blocks, then break the mission into independent and dependent checklist work items with /mission-task blocks. Challenge weak assumptions, identify evidence needed, call out open disagreements, and end with the current recommended first action. Stay in planning mode; do not edit files unless a human explicitly approves execution.`;
      case 'assign':
        return `${address}, assign the next work for the active mission${missionText}.${phaseText} Choose the next unblocked checklist items, owners, dependencies, and blocker/council notes. Update Mission Control with /mission-task blocks. Do not agree for the sake of agreement; surface disputed direction and evidence gaps before assigning execution.`;
      case 'execute':
        return `${address}, execute one focused work item for the active mission${missionText}.${itemText} Use the mission brief, active plan, current phase gate, dependencies, and recent context. Request permissions before broader tool use. When done or blocked, update Mission Control with a /mission-task status note and report the concrete result back to chat.`;
      case 'review':
        return `${address}, review the active mission state${missionText}. Challenge the current plan, phase gates, checklist, assumptions, and evidence. Identify concrete risks, unresolved disagreements, missing citations or verification, and any checklist items that should be blocked, revised, or reassigned.`;
      case 'sync':
        return `${address}, sync on the active mission${missionText}.${phaseText} Each responding agent should state current status, blockers, disagreement, evidence needed, and the next recommended action. End with one proposed owner and one concrete next step.`;
      case 'verify':
        return `${address}, verify the current mission gate${missionText}.${phaseText} Separate implementation claims from evidence, identify missing tests or review gaps, resolve or explicitly carry open disagreements, update Mission Control if phase/checklist status should change, and end with a pass/fail recommendation.`;
    }
  }

  private loadTaskControl(roomId: string, taskId: string): void {
    this.api.tasks.control(roomId, taskId).subscribe((control) => {
      this.taskControl.set(control);
      if (
        this.missionActionChecklistItemId() &&
        !control.checklistItems.some((item) => item.id === this.missionActionChecklistItemId())
      ) {
        this.missionActionChecklistItemId.set('');
      }
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

  private syncMissionActionTargets(): void {
    const agents = this.roomAgents();
    if (agents.length === 0) {
      if (this.missionActionAgent()) this.missionActionAgent.set('');
      if (this.selectedMissionActionAgents().length > 0) this.selectedMissionActionAgents.set([]);
      return;
    }
    if (!agents.includes(this.missionActionAgent())) {
      this.missionActionAgent.set(agents[0]!);
    }
    const selected = this.selectedMissionActionAgents().filter((agent) => agents.includes(agent));
    let nextSelected: AgentId[];
    if (this.missionActionScope() === 'selected') {
      nextSelected = selected.length > 0 ? selected : [...agents];
    } else {
      nextSelected = selected;
    }
    if (!this.sameAgentList(this.selectedMissionActionAgents(), nextSelected)) {
      this.selectedMissionActionAgents.set(nextSelected);
    }
  }

  private sameAgentList(left: AgentId[], right: AgentId[]): boolean {
    return left.length === right.length && left.every((agent, index) => agent === right[index]);
  }

  private loadArtifacts(roomId: string): void {
    this.api.artifacts.list(roomId).subscribe((listing) => this.artifacts.set(listing));
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
    this.artifacts.set(null);
    this.collaboration.set([]);
    this.taskControl.set(null);
    this.yoloStatus.set(null);
    this.closeRunDetail();
    this.closeTaskInspector();
  }

  private isChatNearBottom(): boolean {
    const list = this.messagesList?.nativeElement;
    if (!list || this.selectedTab() !== 'chat') return true;
    return list.scrollHeight - list.clientHeight - list.scrollTop < 120;
  }

  private scheduleChatScrollToBottom(): void {
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        const list = this.messagesList?.nativeElement;
        if (!list || this.selectedTab() !== 'chat') return;
        list.scrollTop = list.scrollHeight;
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
    return this.showLowSignalRunEvents()
      ? actions
      : actions.filter((action) => this.isVisibleRunAction(action));
  }

  hiddenRunActionCount(actions: AgentRunAction[]): number {
    if (this.showLowSignalRunEvents()) return 0;
    return this.lowSignalRunActionCount(actions);
  }

  lowSignalRunActionCount(actions: AgentRunAction[]): number {
    return actions.length - actions.filter((action) => this.isVisibleRunAction(action)).length;
  }

  visibleDiagnosticSignals(signals: AgentRunDetail['diagnostics']['signals'] | undefined) {
    const items = signals ?? [];
    return this.showLowSignalRunEvents()
      ? items
      : items.filter((signal) => this.isVisibleProviderSignal(signal.label, signal.detail));
  }

  hiddenDiagnosticSignalCount(
    signals: AgentRunDetail['diagnostics']['signals'] | undefined,
  ): number {
    if (this.showLowSignalRunEvents()) return 0;
    return this.lowSignalDiagnosticSignalCount(signals);
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
    return this.readableDetailText(action.detail, maxChars);
  }

  private readableDetailText(detail: string | undefined, maxChars: number): string {
    const rawDetail = detail?.trim() ?? '';
    if (!rawDetail) return '';
    try {
      const parsed = JSON.parse(rawDetail) as unknown;
      const readable = this.readableJsonText(parsed);
      return readable ? this.oneLine(readable, maxChars) : '';
    } catch {
      // Plain text details are expected for most provider stream events.
    }
    return this.oneLine(rawDetail, maxChars);
  }

  private readableJsonText(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const record = value as Record<string, unknown>;
    for (const key of ['message', 'text', 'content', 'summary', 'body']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && /[A-Za-z0-9]/.test(candidate)) {
        return candidate.trim();
      }
    }
    return '';
  }

  private insertIntoInput(input: HTMLInputElement, text: string): void {
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
  }

  private detectComposerMentionToken(input: HTMLInputElement): ComposerMentionToken | null {
    const cursor = input.selectionStart ?? input.value.length;
    const selectionEnd = input.selectionEnd ?? cursor;
    if (selectionEnd !== cursor) return null;
    const beforeCursor = input.value.slice(0, cursor);
    const prefixMatch = beforeCursor.match(/(?:^|\s)@([A-Za-z0-9-]*)$/);
    if (!prefixMatch) return null;
    const prefix = prefixMatch[1] ?? '';
    const suffix = input.value.slice(cursor).match(/^[A-Za-z0-9-]*/)?.[0] ?? '';
    const start = cursor - prefix.length - 1;
    const end = cursor + suffix.length;
    return { query: `${prefix}${suffix}`.toLowerCase(), start, end };
  }

  private mentionHandleForProfile(
    profile: RoomAgentProfile,
    providerCounts: Map<ProviderId, number>,
  ): string {
    const displaySlug = this.mentionSlug(profile.displayName);
    const providerIsAmbiguous = (providerCounts.get(profile.providerId) ?? 0) > 1;
    if (displaySlug && (!providerIsAmbiguous || displaySlug !== profile.providerId)) {
      return displaySlug;
    }
    return this.mentionSlug(profile.id) || profile.id.toLowerCase();
  }

  private mentionSlug(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private apiErrorText(err: unknown, fallback: string): string {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === 'object' && err !== null && 'error' in err) {
      const wrapped = (err as { error?: unknown }).error;
      if (typeof wrapped === 'string') return wrapped;
      if (typeof wrapped === 'object' && wrapped !== null && 'error' in wrapped) {
        const message = (wrapped as { error?: unknown }).error;
        if (typeof message === 'string') return message;
      }
    }
    return fallback;
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
          return `<pre>${this.escapeHtml(part.slice(3, -3).replace(/^\n/, ''))}</pre>`;
        }
        return this.renderInlineMessageHtml(this.collapseBlankLines(part));
      })
      .join('');
  }

  private collapseBlankLines(text: string): string {
    return text.replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, '\n\n');
  }

  private renderInlineMessageHtml(text: string): string {
    return text
      .split(/(`[^`]+`|@file\("[^"]+"\)|@[a-z][a-z0-9-]*(?![.\w-]))/gi)
      .map((part) => {
        if (!part) return '';
        if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
          return `<code>${this.escapeHtml(part.slice(1, -1))}</code>`;
        }
        if (part.startsWith('@file("')) {
          const filePath = part.slice(7, -2);
          return `<span class="file-mention" title="${this.escapeHtml(filePath)}">@file ${this.escapeHtml(this.basename(filePath))}</span>`;
        }
        const mention = part.match(/^@([a-z][a-z0-9-]*)$/i);
        if (mention) {
          const providerId = this.mentionProviderForHandle(mention[1]!);
          if (providerId) {
            return `<span class="mention mention--${providerId}">${this.escapeHtml(part)}</span>`;
          }
        }
        return this.renderInlineMarkdown(part);
      })
      .join('');
  }

  private mentionProviderForHandle(handle: string): ProviderId | null {
    const normalized = this.mentionSlug(handle);
    if (!normalized) return null;
    const room = this.selectedRoom();
    if (room) {
      const providerCounts = new Map<ProviderId, number>();
      for (const agentId of room.agents) {
        const providerId = this.roomAgentProfile(room, agentId).providerId;
        providerCounts.set(providerId, (providerCounts.get(providerId) ?? 0) + 1);
      }
      for (const agentId of room.agents) {
        const profile = this.roomAgentProfile(room, agentId);
        const aliases = new Set([
          this.mentionSlug(profile.id),
          this.mentionSlug(profile.displayName),
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

  private renderInlineMarkdown(text: string): string {
    return this.escapeHtml(text)
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
    if (!markdown.trim()) return '<p class="empty-copy">no active plan recorded</p>';
    const html: string[] = [];
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    let inList = false;
    let inCode = false;
    const closeList = (): void => {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
    };

    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        if (inCode) {
          html.push('</code></pre>');
          inCode = false;
        } else {
          closeList();
          html.push('<pre><code>');
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        html.push(`${this.escapeHtml(line)}\n`);
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        closeList();
        continue;
      }
      const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
      if (heading) {
        closeList();
        html.push(
          `<h${heading[1]!.length}>${this.inlineMarkdown(heading[2]!)}</h${heading[1]!.length}>`,
        );
        continue;
      }
      const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
      if (bullet) {
        if (!inList) {
          html.push('<ul>');
          inList = true;
        }
        html.push(`<li>${this.inlineMarkdown(bullet[1]!)}</li>`);
        continue;
      }
      closeList();
      html.push(`<p>${this.inlineMarkdown(trimmed)}</p>`);
    }
    closeList();
    if (inCode) html.push('</code></pre>');
    return html.join('');
  }

  private inlineMarkdown(text: string): string {
    return this.escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
