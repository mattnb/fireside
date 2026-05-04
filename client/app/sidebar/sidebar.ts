// client/app/sidebar/sidebar.ts
// Left rail: primary nav (briefings) + project tree (with rooms grouped
// under each project) + author footer. Pure presentational shell — App
// owns project/room state, this component renders + emits selection and
// CRUD actions.

import { Component, inject, input, output, signal } from '@angular/core';

import { DraftService } from '../draft.service';
import { VfxSmokeAndEmbersComponent } from '../vfx-smoke-and-embers/vfx-smoke-and-embers';
import type { Project, Room } from '../api.types';

const PROTECTED_PROJECT_ID = 'general';
const VFX_PAUSED_STORAGE_KEY = 'fireside.roomsVfxPaused';

export type ProjectGroup = {
  project: Project;
  missions: Room[];
};

@Component({
  selector: 'fs-sidebar',
  standalone: true,
  imports: [VfxSmokeAndEmbersComponent],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.css',
})
export class Sidebar {
  protected readonly drafts = inject(DraftService);
  protected readonly vfxPaused = signal(readVfxPausedPreference());
  protected readonly settingsOpen = signal(false);

  protected canManageProject(project: Project): boolean {
    return project.id !== PROTECTED_PROJECT_ID;
  }

  protected toggleSettingsMenu(event: Event): void {
    event.stopPropagation();
    this.settingsOpen.update((open) => !open);
  }

  protected setCampfireGraphicEnabled(enabled: boolean): void {
    const paused = !enabled;
    this.vfxPaused.set(paused);
    try {
      localStorage.setItem(VFX_PAUSED_STORAGE_KEY, paused ? '1' : '0');
    } catch {
      // Local storage can be unavailable in privacy-restricted browser contexts.
    }
  }

  readonly projectGroups = input<ProjectGroup[]>([]);
  readonly selectedProjectId = input<string | null>(null);
  readonly selectedRoomId = input<string | null>(null);
  readonly creatingProject = input<boolean>(false);
  readonly creatingMissionProjectId = input<string | null>(null);
  readonly deletingRoomId = input<string | null>(null);
  readonly briefingsCount = input<number>(0);
  readonly isBriefingsActive = input<boolean>(false);
  readonly archivesCount = input<number>(0);
  readonly isArchivesActive = input<boolean>(false);
  readonly authorName = input<string>('');

  readonly briefingsOpened = output<void>();
  readonly archivesOpened = output<void>();
  readonly createProjectToggled = output<void>();
  readonly projectSubmitted = output<HTMLInputElement>();
  readonly projectCreationCanceled = output<HTMLInputElement>();
  readonly projectSelected = output<string>();
  readonly projectArchived = output<Project>();
  readonly projectDeleted = output<Project>();
  readonly roomCreationToggled = output<string>();
  readonly roomSelected = output<string>();
  readonly roomDeleted = output<{ room: Room; event: Event }>();
  readonly authorChanged = output<HTMLInputElement>();
}

function readVfxPausedPreference(): boolean {
  try {
    return localStorage.getItem(VFX_PAUSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
