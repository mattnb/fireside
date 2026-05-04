// client/app/archives-view/archives-view.ts
// Lists archived projects and exposes restore + permanent-delete actions.
// Reads archived state straight from MissionStore. Each project shows the
// rooms that lived under it (still attached, just hidden from the main rail
// while their parent is archived) so the user can decide whether they want
// to restore or nuke.

import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';

import { MissionStore } from '../mission-store';
import { formatDateTime } from '../formatters';
import type { Project, Room } from '../api.types';

@Component({
  selector: 'fs-archives-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './archives-view.html',
  styleUrl: './archives-view.css',
})
export class ArchivesView {
  private readonly store = inject(MissionStore);

  readonly archivedProjects = computed(() =>
    this.store
      .projects()
      .filter((project): project is Project & { archivedAt: number } => project.archivedAt !== null)
      .sort((a, b) => b.archivedAt - a.archivedAt),
  );

  readonly restoreRequested = output<Project>();
  readonly deleteRequested = output<Project>();

  protected roomsForProject(projectId: string): Room[] {
    return this.store.rooms().filter((room) => room.projectId === projectId);
  }

  protected formatArchivedAt(ts: number): string {
    return formatDateTime(ts);
  }
}
