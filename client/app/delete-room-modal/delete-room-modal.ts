import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import { MissionStore } from '../mission-store';
import type { Room } from '../api.types';

@Component({
  selector: 'fs-delete-room-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './delete-room-modal.html',
  styleUrl: './delete-room-modal.css',
})
export class DeleteRoomModal {
  private readonly store = inject(MissionStore);

  readonly room = input.required<Room>();
  readonly closed = output<void>();
  readonly confirmed = output<Room>();

  protected readonly agentCount = computed(() => this.room().agents.length);
  protected readonly projectName = computed(() => {
    const projectId = this.room().projectId;
    const project = this.store.projects().find((p) => p.id === projectId);
    return project?.name ?? null;
  });
}
