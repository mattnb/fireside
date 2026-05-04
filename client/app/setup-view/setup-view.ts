// client/app/setup-view/setup-view.ts
// Mission setup panel: brief title + goal + facts, mission history list, and
// the active-mission edit form / new-mission draft form / no-mission create
// form. Owns its own draft toggle. Emits (missionsChanged) when a mutation
// commits so the parent can refresh task data.

import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FiresideApi } from '../api.service';
import { MissionStore } from '../mission-store';
import { ACTIVE_TASK_STATUSES } from '../task-constants';
import { formatShortTime } from '../formatters';
import type {
  CapabilityProfile,
  Room,
  Task,
  TaskPhaseStatus,
  TaskStatus,
} from '../api.types';

export interface MissionsChangedEvent {
  preferredTaskId?: string;
}

@Component({
  selector: 'fs-setup-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './setup-view.html',
  styleUrl: './setup-view.css',
})
export class SetupView {
  private readonly api = inject(FiresideApi);
  private readonly store = inject(MissionStore);

  readonly room = input<Room | null>(null);
  readonly roomId = input<string | null>(null);
  readonly activeTask = input<Task | null>(null);

  readonly missionsChanged = output<MissionsChangedEvent>();

  readonly creatingMissionDraft = signal(false);

  readonly missionHistory = computed(() =>
    [...this.store.tasks()].sort((a, b) => {
      const activeDelta =
        Number(!ACTIVE_TASK_STATUSES.includes(a.status)) -
        Number(!ACTIVE_TASK_STATUSES.includes(b.status));
      if (activeDelta !== 0) return activeDelta;
      return (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt);
    }),
  );

  formatShortTime(timestamp: number | undefined): string {
    return formatShortTime(timestamp);
  }

  toggleMissionDraft(): void {
    this.creatingMissionDraft.update((value) => !value);
  }

  isCurrentMission(task: Task): boolean {
    return this.activeTask()?.id === task.id;
  }

  missionActionLabel(task: Task): string {
    if (ACTIVE_TASK_STATUSES.includes(task.status)) return 'current';
    if (task.status === 'done') return 'reopen';
    return 'resume';
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
    const room = this.room();
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
        titleInput.value = '';
        goalInput.value = '';
        pathInput.value = '';
        acceptanceInput.value = '';
        profileInput.value = 'plan';
        this.missionsChanged.emit({ preferredTaskId: task.id });
      });
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

  updateMission(
    titleInput: HTMLInputElement,
    goalInput: HTMLTextAreaElement,
    pathInput: HTMLInputElement,
    acceptanceInput: HTMLTextAreaElement,
    profileInput: HTMLSelectElement,
    statusInput: HTMLSelectElement,
    summaryInput: HTMLTextAreaElement,
  ): void {
    const roomId = this.roomId();
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
        this.missionsChanged.emit({ preferredTaskId: updated.id });
      });
  }

  activateMission(task: Task): void {
    const roomId = this.roomId();
    if (!roomId || task.status === 'active') return;
    this.api.tasks.update(roomId, task.id, { status: 'active' }).subscribe(() => {
      this.missionsChanged.emit({ preferredTaskId: task.id });
    });
  }

  pauseMission(task: Task): void {
    const roomId = this.roomId();
    if (!roomId || task.status === 'paused') return;
    this.api.tasks.update(roomId, task.id, { status: 'paused' }).subscribe(() => {
      this.missionsChanged.emit({});
    });
  }

  completeMission(task: Task): void {
    const roomId = this.roomId();
    if (!roomId || task.status === 'done') return;
    this.api.tasks.update(roomId, task.id, { status: 'done' }).subscribe(() => {
      this.missionsChanged.emit({});
    });
  }
}
