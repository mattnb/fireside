// client/app/sidebar/sidebar.ts
// Left rail: primary nav (briefings) + project tree (with rooms grouped
// under each project) + author footer. Pure presentational shell — App
// owns project/room state, this component renders + emits selection and
// CRUD actions.

import { Component, inject, input, output } from '@angular/core';

import { DraftService } from '../draft.service';
import { VfxSmokeAndEmbersComponent } from '../vfx-smoke-and-embers/vfx-smoke-and-embers';
import type { Project, Room } from '../api.types';

const PROTECTED_PROJECT_ID = 'general';

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

  protected canManageProject(project: Project): boolean {
    return project.id !== PROTECTED_PROJECT_ID;
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
