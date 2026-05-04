// client/app/mission-toolbar/mission-toolbar.ts
// Mission Control top strip: tab selector across mission views, the
// editorial mission-action popover (action picker + scope + agent target +
// checklist item), and a "save briefing" button. Owns the entire
// mission-action concern — popover state lives on MissionStore so any
// component can drive it (App.focusMissionGraphItem snaps the popover to
// "execute this item" when a checklist item is opened from a graph
// surface), but the methods, prompt builder, dispatch path, and target
// resolution all live here.

import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, input, output } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { FiresideApi } from '../api.service';
import { BriefingService } from '../briefing.service';
import { FiresideWs } from '../ws.service';
import { MissionStore } from '../mission-store';
import { ACTIVE_TASK_STATUSES } from '../task-constants';
import type { AgentId, Task, TaskChecklistItem } from '../api.types';

export type MissionActionKind = 'plan' | 'assign' | 'execute' | 'review' | 'sync' | 'verify';
export type MissionActionScope = 'team' | 'selected' | 'single';

export type MissionActionDefinition = {
  id: MissionActionKind;
  label: string;
  summary: string;
};

export type MissionViewDescriptor<TId extends string = string> = {
  id: TId;
  label: string;
  summary: string;
};

export const MISSION_ACTIONS: MissionActionDefinition[] = [
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

@Component({
  selector: 'fs-mission-toolbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mission-toolbar.html',
  styleUrl: './mission-toolbar.css',
})
export class MissionToolbar<ViewId extends string = string> {
  protected readonly display = inject(AgentDisplayService);
  protected readonly store = inject(MissionStore);
  protected readonly briefings = inject(BriefingService);
  private readonly api = inject(FiresideApi);
  private readonly ws = inject(FiresideWs);

  readonly missionViews = input<MissionViewDescriptor<ViewId>[]>([]);
  readonly selectedMissionView = input<ViewId | null>(null);
  readonly authorName = input<string>('human');

  readonly missionViewSelected = output<ViewId>();

  protected readonly missionActions = MISSION_ACTIONS;

  protected saveBriefing(): void {
    const roomId = this.store.selectedRoomId();
    if (!roomId) return;
    this.briefings.createBriefing({
      roomId,
      taskId: this.activeTask()?.id ?? null,
      authorName: this.authorName(),
    });
  }

  protected readonly hasRoom = computed(() => !!this.store.selectedRoomId());
  protected readonly roomName = computed(() => this.store.selectedRoom()?.name ?? 'mission');
  protected readonly roomAgents = computed(() => this.store.selectedRoom()?.agents ?? []);
  protected readonly activeTask = computed<Task | null>(
    () => this.store.tasks().find((task) => ACTIVE_TASK_STATUSES.includes(task.status)) ?? null,
  );

  protected readonly missionActionTargetAgents = computed(() => {
    const roomAgents = this.roomAgents();
    const scope = this.store.missionActionScope();
    if (scope === 'team') return roomAgents;
    if (scope === 'single') {
      const requested = this.store.missionActionAgent();
      return roomAgents.includes(requested) ? [requested] : roomAgents.slice(0, 1);
    }
    const selected = new Set(this.store.selectedMissionActionAgents());
    return roomAgents.filter((agent) => selected.has(agent));
  });

  protected readonly missionActionWorkItems = computed(() => {
    const items = this.store.taskControl()?.checklistItems ?? [];
    const order: Record<string, number> = { open: 0, blocked: 1, done: 2, skipped: 3 };
    return [...items].sort((a, b) => {
      const statusDelta = (order[a.status] ?? 4) - (order[b.status] ?? 4);
      if (statusDelta !== 0) return statusDelta;
      return a.sortOrder - b.sortOrder;
    });
  });

  constructor() {
    // Keep selected agents and single-agent target in sync with the room
    // roster — when an agent leaves a room, drop them from the popover
    // selection. (Previously coordinated by App.syncMissionActionTargets.)
    effect(() => {
      const agents = this.roomAgents();
      if (agents.length === 0) {
        if (this.store.missionActionAgent()) this.store.missionActionAgent.set('');
        if (this.store.selectedMissionActionAgents().length > 0) {
          this.store.selectedMissionActionAgents.set([]);
        }
        return;
      }
      if (!agents.includes(this.store.missionActionAgent())) {
        this.store.missionActionAgent.set(agents[0]!);
      }
      const selected = this.store.selectedMissionActionAgents().filter((agent) =>
        agents.includes(agent),
      );
      const next =
        this.store.missionActionScope() === 'selected'
          ? selected.length > 0
            ? selected
            : [...agents]
          : selected;
      if (!sameAgentList(this.store.selectedMissionActionAgents(), next)) {
        this.store.selectedMissionActionAgents.set(next);
      }
    });

    // If the focused checklist item disappears (task swap, item delete),
    // clear the selection so the popover falls back to "next unblocked
    // item." (Previously baked into App.loadTaskControl.)
    effect(() => {
      const id = this.store.missionActionChecklistItemId();
      if (!id) return;
      const items = this.store.taskControl()?.checklistItems ?? [];
      if (!items.some((item) => item.id === id)) {
        this.store.missionActionChecklistItemId.set('');
      }
    });
  }

  protected selectMissionAction(kind: MissionActionKind): void {
    this.store.selectedMissionAction.set(kind);
  }

  protected setMissionActionScope(scope: MissionActionScope): void {
    this.store.missionActionScope.set(scope);
    const agents = this.roomAgents();
    if (scope === 'single' && !agents.includes(this.store.missionActionAgent())) {
      this.store.missionActionAgent.set(agents[0] ?? '');
    }
    if (scope === 'selected') {
      const selected = this.store
        .selectedMissionActionAgents()
        .filter((agent) => agents.includes(agent));
      this.store.selectedMissionActionAgents.set(
        selected.length > 0 ? selected : [...agents],
      );
    }
  }

  protected setMissionActionAgent(event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    this.store.missionActionAgent.set(value);
  }

  protected toggleMissionActionAgent(agentId: AgentId, event: Event): void {
    const checked = event.target instanceof HTMLInputElement ? event.target.checked : false;
    this.store.selectedMissionActionAgents.update((agents) => {
      if (checked) return agents.includes(agentId) ? agents : [...agents, agentId];
      return agents.filter((agent) => agent !== agentId);
    });
  }

  protected isMissionActionAgentSelected(agentId: AgentId): boolean {
    return this.store.selectedMissionActionAgents().includes(agentId);
  }

  protected setMissionActionChecklistItem(event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    this.store.missionActionChecklistItemId.set(value);
  }

  protected missionActionTargetLabel(): string {
    const agents = this.missionActionTargetAgents();
    if (this.store.missionActionScope() === 'team') {
      return agents.length === 1 ? 'team: 1 agent' : `team: ${agents.length} agents`;
    }
    if (agents.length === 0) return 'no agents selected';
    return agents.map((agent) => this.display.name(agent)).join(', ');
  }

  protected missionActionItemLabel(): string {
    const id = this.store.missionActionChecklistItemId();
    if (!id) return 'next unblocked item';
    const item = this.missionActionWorkItems().find((i) => i.id === id);
    return item ? item.title : 'next unblocked item';
  }

  protected canPostMissionAction(): boolean {
    return Boolean(this.store.selectedRoomId() && this.missionActionTargetAgents().length > 0);
  }

  protected dispatchMissionAction(): void {
    const roomId = this.store.selectedRoomId();
    if (!roomId || !this.canPostMissionAction()) return;
    const task = this.activeTask();
    const kind = this.store.selectedMissionAction();
    const prompt = this.buildMissionActionPrompt(kind);
    if (kind === 'verify' && task) {
      this.api.tasks
        .update(roomId, task.id, { status: 'verifying' })
        .subscribe((updated) => {
          this.store.tasks.update((tasks) => upsertTask(tasks, updated));
          this.ws.postMessage(roomId, this.authorName(), prompt);
        });
      this.closeMissionActionPopover();
      return;
    }
    this.ws.postMessage(roomId, this.authorName(), prompt);
    this.closeMissionActionPopover();
  }

  protected toggleMissionActionPopover(): void {
    this.store.missionActionPopoverOpen.update((open) => !open);
  }

  protected closeMissionActionPopover(): void {
    this.store.missionActionPopoverOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.store.missionActionPopoverOpen()) this.closeMissionActionPopover();
  }

  private missionActionAddress(): string {
    if (this.store.missionActionScope() === 'team') return 'Team';
    return this.missionActionTargetAgents()
      .map((agent) => `@${agent}`)
      .join(' ');
  }

  private selectedMissionActionItem(): TaskChecklistItem | null {
    const itemId = this.store.missionActionChecklistItemId();
    const items = this.store.taskControl()?.checklistItems ?? [];
    return items.find((item) => item.id === itemId) ?? null;
  }

  private buildMissionActionPrompt(kind: MissionActionKind): string {
    const task = this.activeTask();
    const control = this.store.taskControl();
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
}

function sameAgentList(left: AgentId[], right: AgentId[]): boolean {
  return left.length === right.length && left.every((agent, index) => agent === right[index]);
}

function upsertTask(tasks: Task[], task: Task): Task[] {
  return [task, ...tasks.filter((existing) => existing.id !== task.id)];
}
