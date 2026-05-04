// client/app/delete-project-modal/delete-project-modal.ts
// Confirmation dialog before permanently deleting a project. Shows the
// project name and the cascade summary (number of rooms that will go with
// it) so the user understands the blast radius before confirming.

import { Component, inject, input, output } from '@angular/core';

import { MissionStore } from '../mission-store';
import type { Project } from '../api.types';

@Component({
  selector: 'fs-delete-project-modal',
  standalone: true,
  templateUrl: './delete-project-modal.html',
  styleUrl: './delete-project-modal.css',
})
export class DeleteProjectModal {
  private readonly store = inject(MissionStore);

  readonly project = input.required<Project>();
  readonly closed = output<void>();
  readonly confirmed = output<Project>();

  protected roomCount(): number {
    return this.store.rooms().filter((room) => room.projectId === this.project().id).length;
  }
}
