import { DatePipe } from '@angular/common';
import { Component, ElementRef, ViewChild, computed, effect, inject, signal, untracked } from '@angular/core';

import { FiresideApi } from './api.service';
import {
  AgentId,
  AgentContextUsage,
  AgentRun,
  AgentRunAction,
  AgentRunDetail,
  Artifact,
  ArtifactListing,
  CapabilityProfile,
  CollaborationItem,
  Message,
  MissionBriefing,
  MissionBriefingSummary,
  PermissionRequest,
  Room,
  Task,
  TaskChecklistItem,
  TaskControl,
  TaskPhaseStatus,
  TaskStatus,
  YoloStatus,
} from './api.types';
import { FiresideWs } from './ws.service';
import { VfxSmokeAndEmbersComponent } from './vfx-smoke-and-embers/vfx-smoke-and-embers';

type TabId = 'chat' | 'mission' | 'briefings';
type ChatTimelineItem = {
  id: string;
  kind: 'message' | 'permission';
  createdAt: number;
  message?: Message;
  request?: PermissionRequest;
  grouped: boolean;
  html?: string;
  isError?: boolean;
};
type MissionActionKind = 'plan' | 'assign' | 'execute' | 'review' | 'sync' | 'verify';
type MissionActionScope = 'team' | 'selected' | 'single';
type MissionActionDefinition = {
  id: MissionActionKind;
  label: string;
  summary: string;
};

const ACTIVE_TASK_STATUSES: TaskStatus[] = ['active', 'blocked', 'verifying'];

@Component({
  selector: 'fs-root',
  standalone: true,
  imports: [DatePipe, VfxSmokeAndEmbersComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  @ViewChild('messagesList') private messagesList?: ElementRef<HTMLOListElement>;

  private readonly api = inject(FiresideApi);
  private readonly ws = inject(FiresideWs);
  private scrollFrame: number | null = null;
  private deleteConfirmTimer: number | null = null;

  readonly agentChoices: AgentId[] = ['claude', 'codex', 'gemini'];
  readonly tabs: Array<{ id: TabId; label: string }> = [
    { id: 'chat', label: 'Chat' },
    { id: 'mission', label: 'Mission Control' },
  ];

  readonly selectedTab = signal<TabId>('chat');
  readonly authorName = signal(localStorage.getItem('fireside.author') || 'human');
  readonly creatingRoom = signal(false);
  readonly newRoomAgents = signal<AgentId[]>([...this.agentChoices]);
  readonly newRoomYoloAgents = signal<AgentId[]>([]);
  readonly deletingRoomId = signal<string | null>(null);
  readonly editingAgents = signal(false);
  readonly editRoomAgents = signal<AgentId[]>([]);
  readonly editRoomYoloAgents = signal<AgentId[]>([]);
  readonly compactAgent = signal<AgentId | null>(null);
  readonly compactingAgent = signal<AgentId | null>(null);
  readonly compactError = signal('');
  readonly rooms = signal<Room[]>([]);
  readonly selectedRoomId = signal<string | null>(null);
  readonly messages = signal<Message[]>([]);
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
      summary: 'Agree on direction, phase gates, checklist, evidence needs, and unresolved disagreements.',
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
  readonly activeTask = computed(
    () => this.tasks().find((task) => ACTIVE_TASK_STATUSES.includes(task.status)) ?? null,
  );
  readonly missionHistory = computed(() =>
    [...this.tasks()].sort((a, b) => {
      const activeDelta = Number(!ACTIVE_TASK_STATUSES.includes(a.status)) - Number(!ACTIVE_TASK_STATUSES.includes(b.status));
      if (activeDelta !== 0) return activeDelta;
      return (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt);
    }),
  );
  readonly roomAgents = computed(() => this.selectedRoom()?.agents ?? []);
  readonly roomYoloAgents = computed(() => this.selectedRoom()?.yoloAgents ?? []);
  readonly latestContextUsageByAgent = computed(() => {
    const usageByAgent = new Map<AgentId, AgentContextUsage>();
    const actions = [...this.runActions()].sort((a, b) => a.createdAt - b.createdAt);
    for (const action of actions) {
      if (action.agentId && action.contextUsage) usageByAgent.set(action.agentId, action.contextUsage);
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
    this.runs().filter((run) => run.status !== 'running').slice(0, 8),
  );
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
        })),
      ...this.permissionRequests().map((request) => ({
        id: `permission:${request.id}`,
        kind: 'permission' as const,
        createdAt: request.createdAt,
        request,
        grouped: false,
      })),
    ].sort((a, b) => a.createdAt - b.createdAt);

    let lastAuthor = '';
    return rawItems.map((item) => {
      if (!item.message || item.message.authorKind === 'system') {
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
    this.loadRooms();
    this.loadBriefings();

    effect(() => {
      const roomId = this.selectedRoomId();
      if (!roomId) return;
      untracked(() => {
        this.loadRoomDetail(roomId);
        this.ws.subscribe(roomId);
      });
    });

    this.ws.stream$.subscribe((event) => {
      const roomId = this.selectedRoomId();
      if (event.type === 'messageAppended' && event.message.roomId === roomId) {
        const shouldStickToBottom = this.isChatNearBottom();
        this.messages.update((messages) => [...messages, event.message]);
        if (shouldStickToBottom) this.scheduleChatScrollToBottom();
      }
      if (event.type === 'permissionRequestCreated' && event.request.roomId === roomId) {
        this.permissionRequests.update((requests) => this.upsert(requests, event.request));
        this.scheduleChatScrollToBottom();
      }
      if (event.type === 'permissionRequestUpdated' && event.request.roomId === roomId) {
        this.permissionRequests.update((requests) => this.upsert(requests, event.request));
      }
      if (event.type === 'taskUpdated' && event.task.roomId === roomId) {
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
        this.runs.update((runs) => this.upsert(runs, event.run));
        if (event.run.id === this.openRunDetailId()) this.openRunDetail(event.run.id, true);
      }
      if (event.type === 'agentRunActionCreated' && event.action.roomId === roomId) {
        this.runActions.update((actions) => this.upsert(actions, event.action));
        if (event.action.runId === this.openRunDetailId()) this.openRunDetail(event.action.runId, true);
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
        this.rooms.update((rooms) => this.upsert(rooms, event.room));
        this.syncMissionActionTargets();
        if (event.room.id === roomId && this.editingAgents()) {
          this.editRoomAgents.set(event.room.agents);
          this.editRoomYoloAgents.set(event.room.yoloAgents ?? []);
        }
      }
      if (event.type === 'roomDeleted') {
        this.handleRoomDeleted(event.roomId);
      }
    });
  }

  selectRoom(roomId: string): void {
    this.selectedRoomId.set(roomId);
    if (this.selectedTab() === 'briefings') {
      this.selectedTab.set('chat');
      this.scheduleChatScrollToBottom();
    }
    this.closeRunDetail();
  }

  selectTab(tabId: TabId): void {
    this.selectedTab.set(tabId);
    if (tabId === 'chat') this.scheduleChatScrollToBottom();
    if (tabId === 'briefings') this.loadBriefings();
  }

  openBriefings(): void {
    this.selectTab('briefings');
  }

  toggleCreateRoom(): void {
    this.creatingRoom.update((value) => !value);
  }

  cancelCreateRoom(input: HTMLInputElement): void {
    input.value = '';
    this.newRoomAgents.set([...this.agentChoices]);
    this.newRoomYoloAgents.set([]);
    this.creatingRoom.set(false);
  }

  isNewRoomAgentSelected(agentId: AgentId): boolean {
    return this.newRoomAgents().includes(agentId);
  }

  toggleNewRoomAgent(agentId: AgentId, event: Event): void {
    const checked = event.target instanceof HTMLInputElement ? event.target.checked : false;
    this.newRoomAgents.update((agents) => {
      if (checked) return agents.includes(agentId) ? agents : [...agents, agentId];
      return agents.filter((agent) => agent !== agentId);
    });
    if (!checked) {
      this.newRoomYoloAgents.update((agents) => agents.filter((agent) => agent !== agentId));
    }
  }

  isNewRoomYoloAgentSelected(agentId: AgentId): boolean {
    return this.newRoomYoloAgents().includes(agentId);
  }

  toggleNewRoomYoloAgent(agentId: AgentId, event: Event): void {
    const checked = event.target instanceof HTMLInputElement ? event.target.checked : false;
    this.newRoomYoloAgents.update((agents) => {
      if (checked) return agents.includes(agentId) ? agents : [...agents, agentId];
      return agents.filter((agent) => agent !== agentId);
    });
    if (checked && !this.newRoomAgents().includes(agentId)) {
      this.newRoomAgents.update((agents) => [...agents, agentId]);
    }
  }

  createRoom(input: HTMLInputElement): void {
    const name = input.value.trim();
    if (!name) return;
    this.api.rooms
      .create({
        name,
        agents: this.newRoomAgents(),
        yoloAgents: this.newRoomYoloAgents().filter((agent) => this.newRoomAgents().includes(agent)),
      })
      .subscribe((room) => {
        this.rooms.update((rooms) => this.upsert(rooms, room));
        this.selectedRoomId.set(room.id);
        input.value = '';
        this.newRoomAgents.set([...this.agentChoices]);
        this.newRoomYoloAgents.set([]);
        this.creatingRoom.set(false);
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
    this.editRoomAgents.set([...room.agents]);
    this.editRoomYoloAgents.set([...(room.yoloAgents ?? [])]);
    this.editingAgents.set(true);
  }

  cancelEditAgents(): void {
    this.editingAgents.set(false);
    this.editRoomAgents.set([]);
    this.editRoomYoloAgents.set([]);
  }

  isEditAgentSelected(agentId: AgentId): boolean {
    return this.editRoomAgents().includes(agentId);
  }

  toggleEditAgent(agentId: AgentId, event: Event): void {
    const checked = event.target instanceof HTMLInputElement ? event.target.checked : false;
    this.editRoomAgents.update((agents) => {
      if (checked) return agents.includes(agentId) ? agents : [...agents, agentId];
      return agents.filter((agent) => agent !== agentId);
    });
    if (!checked) {
      this.editRoomYoloAgents.update((agents) => agents.filter((agent) => agent !== agentId));
    }
  }

  isEditYoloAgentSelected(agentId: AgentId): boolean {
    return this.editRoomYoloAgents().includes(agentId);
  }

  toggleEditYoloAgent(agentId: AgentId, event: Event): void {
    const checked = event.target instanceof HTMLInputElement ? event.target.checked : false;
    this.editRoomYoloAgents.update((agents) => {
      if (checked) return agents.includes(agentId) ? agents : [...agents, agentId];
      return agents.filter((agent) => agent !== agentId);
    });
    if (checked && !this.editRoomAgents().includes(agentId)) {
      this.editRoomAgents.update((agents) => [...agents, agentId]);
    }
  }

  saveEditAgents(): void {
    const room = this.selectedRoom();
    if (!room) return;
    const agents = this.editRoomAgents();
    this.api.rooms
      .update(room.id, {
        agents,
        yoloAgents: this.editRoomYoloAgents().filter((agent) => agents.includes(agent)),
      })
      .subscribe((updated) => {
        this.rooms.update((rooms) => this.upsert(rooms, updated));
        this.editingAgents.set(false);
      });
  }

  isAgentRunning(agentId: string): boolean {
    return this.runningRuns().some((run) => run.agentId === agentId);
  }

  isRoomYoloAgent(agentId: AgentId): boolean {
    return this.roomYoloAgents().includes(agentId);
  }

  canCompactAgent(agentId: AgentId): boolean {
    return agentId === 'claude' || agentId === 'codex';
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
    if (agentId === 'claude') {
      return 'Manual compaction asks Claude Code to compact its stored CLI session context.';
    }
    if (agentId === 'codex') {
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
      this.selectedRoomId.set(rooms[0]?.id ?? null);
    });
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
  }

  composerPlaceholder(): string {
    return this.isRoomWorking()
      ? 'queue context for the active agent run'
      : 'message the room';
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

  elapsedLabel(startedAt?: number, completedAt?: number | null): string {
    if (!startedAt) return 'unknown';
    const end = completedAt ?? Date.now();
    const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}m ${rest}s`;
  }

  targetStatusText(item: PermissionRequest | AgentRun): string {
    const kind =
      'targetKind' in item ? item.targetKind : item.permissionTargetKind || 'unknown';
    const exists =
      'targetExists' in item ? item.targetExists : item.permissionTargetExists;
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
      if (['bash', 'shell', 'command', 'run-command', 'git', 'commit', 'git-commit'].includes(request.requestedMode)) {
        return `${request.requestedMode} command`;
      }
      return `${request.requestedMode} (${this.permissionModeLabel(request.mode)})`;
    }
    return this.permissionModeLabel(request.mode);
  }

  latestActionForRun(runId: string): AgentRunAction | null {
    return this.runActions().find((action) => action.runId === runId && this.isVisibleRunAction(action)) ?? null;
  }

  runMeta(run: AgentRun): string {
    const tokens = run.estimatedPromptTokens ? `${run.estimatedPromptTokens}t` : 'unknown tokens';
    const mode = run.permissionMode ? this.permissionModeLabel(run.permissionMode) : 'mode unknown';
    return `${this.elapsedLabel(run.startedAt, run.completedAt)} / ${tokens} / ${mode}`;
  }

  agentContextUsage(agentId: AgentId): AgentContextUsage | null {
    return this.latestContextUsageByAgent().get(agentId) ?? null;
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

  agentContextTitle(usage: AgentContextUsage): string {
    const usedTokens = this.agentContextUsedTokens(usage);
    const parts = [
      `model: ${usage.reasoningEffort ? `${usage.model}/${usage.reasoningEffort}` : usage.model}`,
      `used: ${this.formatTokenCount(usedTokens)} tokens${this.agentContextIsEstimated(usage) ? ' estimated' : ''}`,
      usage.contextWindow ? `window: ${this.formatTokenCount(usage.contextWindow)} tokens` : 'window unknown',
      usage.contextWindow
        ? `remaining: ${this.formatTokenCount(Math.max(0, usage.contextWindow - usedTokens))} tokens`
        : '',
      usage.reportedUsedTokens !== undefined && usage.reportedUsedTokens !== usedTokens
        ? `provider reported: ${this.formatTokenCount(usage.reportedUsedTokens)} tokens`
        : '',
      usage.inputTokens !== undefined ? `input: ${this.formatTokenCount(usage.inputTokens)}` : '',
      usage.outputTokens !== undefined ? `output: ${this.formatTokenCount(usage.outputTokens)}` : '',
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
      return Math.max(
        0,
        usage.inputTokens - usage.cachedInputTokens + (usage.outputTokens ?? 0),
      );
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

  formatTokenCount(tokens: number | undefined): string {
    if (!Number.isFinite(tokens)) return 'unknown';
    const value = Math.max(0, tokens ?? 0);
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
    return String(Math.round(value));
  }

  runActionSignal(run: AgentRun): string {
    const action = this.latestActionForRun(run.id);
    if (!action) return run.lastSignal || run.summary || 'waiting for first broker signal';
    const detail = this.actionDetailText(action, 120);
    return detail ? `${action.label} / ${detail}` : action.label;
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
    const referenceTime = action?.createdAt ?? run.startedAt ?? 0;
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
    return agents.join(', ');
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
      return;
    }
    this.ws.postMessage(roomId, this.authorName(), prompt);
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
          ? `${ownerAgentId} took ownership of this work item.`
          : `${this.authorName()} cleared the owner.`,
      })
      .subscribe(() => this.loadTaskControl(roomId, task.id));
  }

  isAgentOwner(ownerAgentId: string): boolean {
    return this.agentChoices.includes(ownerAgentId);
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
      return dependency !== undefined && dependency.status !== 'done' && dependency.status !== 'skipped';
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
    return this.missionActionTargetAgents().map((agent) => `@${agent}`).join(' ');
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
    this.api.tasks.list(roomId).subscribe((tasks) => this.applyTaskList(roomId, tasks, preferredTaskId));
  }

  private applyTaskList(roomId: string, tasks: Task[], preferredTaskId?: string | null): void {
    this.tasks.set(tasks);
    const preferred = preferredTaskId
      ? tasks.find((task) => task.id === preferredTaskId && ACTIVE_TASK_STATUSES.includes(task.status))
      : null;
    const activeTask = preferred ?? tasks.find((task) => ACTIVE_TASK_STATUSES.includes(task.status));
    if (activeTask) {
      this.loadTaskControl(roomId, activeTask.id);
      this.loadCollaboration(roomId, activeTask.id);
    } else {
      this.taskControl.set(null);
      this.collaboration.set([]);
    }
  }

  private loadCollaboration(roomId: string, taskId: string): void {
    this.api.collaboration
      .list(roomId, taskId)
      .subscribe((items) => {
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
    const remaining = this.rooms().filter((room) => room.id !== roomId);
    this.rooms.set(remaining);
    if (this.selectedRoomId() !== roomId) return;
    const nextRoomId = remaining[0]?.id ?? null;
    this.selectedRoomId.set(nextRoomId);
    if (!nextRoomId) this.clearRoomState();
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

  hiddenDiagnosticSignalCount(signals: AgentRunDetail['diagnostics']['signals'] | undefined): number {
    if (this.showLowSignalRunEvents()) return 0;
    return this.lowSignalDiagnosticSignalCount(signals);
  }

  lowSignalDiagnosticSignalCount(signals: AgentRunDetail['diagnostics']['signals'] | undefined): number {
    const items = signals ?? [];
    return items.length - items.filter((signal) => this.isVisibleProviderSignal(signal.label, signal.detail)).length;
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
    return Boolean(this.readableDetailText(detail, 1));
  }

  private isNoisyProviderLabel(label: string): boolean {
    const normalized = label.trim().toLowerCase();
    return [
      /\bmessage_start\b/,
      /\bmessage_delta\b/,
      /\bmessage_stop\b/,
      /\bcontent_block_start\b/,
      /\bcontent_block_delta\b/,
      /\bcontent_block_stop\b/,
      /\btool_use\b/,
      /\bturn started\b/,
      /\bassistant message ready\b/,
      /^(?:claude|codex|gemini)?\s*status$/,
    ].some((pattern) => pattern.test(normalized));
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

  private isHiddenSystemMessage(message: Message): boolean {
    if (message.authorKind !== 'system') return false;
    return (
      /^Permission (approved|denied) for /i.test(message.text) ||
      /^\([a-z]+ started approved /i.test(message.text) ||
      /^\([a-z]+ finished the .* follow-up without a visible chat message\.\)$/i.test(message.text)
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
      .split(/(`[^`]+`|@file\("[^"]+"\)|@(?:claude|codex|gemini)\b)/gi)
      .map((part) => {
        if (!part) return '';
        if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
          return `<code>${this.escapeHtml(part.slice(1, -1))}</code>`;
        }
        if (part.startsWith('@file("')) {
          const filePath = part.slice(7, -2);
          return `<span class="file-mention" title="${this.escapeHtml(filePath)}">@file ${this.escapeHtml(this.basename(filePath))}</span>`;
        }
        const mention = part.match(/^@(claude|codex|gemini)\b/i);
        if (mention) {
          const agent = mention[1]!.toLowerCase();
          return `<span class="mention mention--${agent}">${this.escapeHtml(part)}</span>`;
        }
        return this.renderInlineMarkdown(part);
      })
      .join('');
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
        html.push(`<h${heading[1]!.length}>${this.inlineMarkdown(heading[2]!)}</h${heading[1]!.length}>`);
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
