// client/app/mission-store.ts
// Domain-state store for fireside. Holds the loaded-from-server data signals
// that the App component used to own directly. Loading methods and WebSocket
// event handlers continue to live in App for now; they call setters on this
// store. UI selection state (selected room, selected tab, popover open, filter
// state) stays in App and child components.
//
// Migration pattern: App exposes proxy getters for every store signal, so
// existing references like `this.taskControl()` and `taskControl()` in
// templates continue to resolve via the getter. The signal lives in the store;
// reads and writes go through the getter to the underlying WritableSignal.

import { Injectable, computed, signal } from '@angular/core';
import type { MissionActionKind, MissionActionScope } from './mission-toolbar/mission-toolbar';
import {
  AgentCatalog,
  AgentId,
  AgentRun,
  AgentRunAction,
  AgentRunDetail,
  AgentTurnOutcome,
  ArtifactListing,
  CollaborationItem,
  Message,
  MissionBriefing,
  MissionBriefingSummary,
  MissionCommandEvent,
  PermissionRequest,
  Project,
  RoutingDecision,
  Room,
  StatusSnapshot,
  Task,
  TaskControl,
  YoloStatus,
} from './api.types';
import { DEFAULT_AGENT_CATALOG } from './catalog-defaults';

@Injectable({ providedIn: 'root' })
export class MissionStore {
  readonly agentCatalog = signal<AgentCatalog>(DEFAULT_AGENT_CATALOG);
  readonly projects = signal<Project[]>([]);
  readonly rooms = signal<Room[]>([]);
  readonly stateSnapshot = signal<StatusSnapshot | null>(null);
  readonly messages = signal<Message[]>([]);
  readonly permissionRequests = signal<PermissionRequest[]>([]);
  readonly tasks = signal<Task[]>([]);
  readonly runs = signal<AgentRun[]>([]);
  readonly runActions = signal<AgentRunAction[]>([]);
  readonly routingDecisions = signal<RoutingDecision[]>([]);
  readonly missionCommandEvents = signal<MissionCommandEvent[]>([]);
  readonly turnOutcomes = signal<AgentTurnOutcome[]>([]);
  readonly artifacts = signal<ArtifactListing | null>(null);
  readonly collaboration = signal<CollaborationItem[]>([]);
  readonly briefings = signal<MissionBriefingSummary[]>([]);
  readonly selectedBriefing = signal<MissionBriefing | null>(null);
  readonly taskControl = signal<TaskControl | null>(null);
  readonly yoloStatus = signal<YoloStatus | null>(null);
  readonly runDetail = signal<AgentRunDetail | null>(null);

  // UI selection state — kept here so any service can resolve "the room the
  // user is looking at right now" without holding a back-reference to App.
  readonly selectedProjectId = signal<string | null>(null);
  readonly selectedRoomId = signal<string | null>(null);
  readonly compactingAgent = signal<AgentId | null>(null);

  // Mission-action popover selection state. Lives here (not in
  // mission-toolbar) so App.focusMissionGraphItem and
  // App.selectMissionActionItem can drive the popover from outside the
  // toolbar component without holding a viewChild ref.
  readonly missionActionPopoverOpen = signal(false);
  readonly selectedMissionAction = signal<MissionActionKind>('plan');
  readonly missionActionScope = signal<MissionActionScope>('team');
  readonly missionActionAgent = signal<AgentId>('');
  readonly selectedMissionActionAgents = signal<AgentId[]>([]);
  readonly missionActionChecklistItemId = signal('');

  readonly selectedRoom = computed<Room | null>(
    () => this.rooms().find((room) => room.id === this.selectedRoomId()) ?? null,
  );
  readonly selectedRoomSnapshot = computed(() => {
    const roomId = this.selectedRoomId();
    return this.stateSnapshot()?.rooms.find((room) => room.id === roomId) ?? null;
  });
  readonly runningRuns = computed(() =>
    this.runs().filter((run) => run.status === 'running'),
  );
  readonly roomYoloAgents = computed(() => this.selectedRoom()?.yoloAgents ?? []);
}
