// client/app/plan-view/plan-view.ts
// First extracted child component. Renders the active plan as editorial
// markdown and lets the user publish a new plan. Reads the active plan from
// MissionStore directly; takes the room/task context as inputs from App.

import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { FiresideApi } from '../api.service';
import { MissionStore } from '../mission-store';
import { markdownToHtml } from '../markdown';
import type { Task } from '../api.types';

@Component({
  selector: 'fs-plan-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plan-view.html',
  styleUrl: './plan-view.css',
})
export class PlanView {
  private readonly api = inject(FiresideApi);
  private readonly store = inject(MissionStore);

  readonly roomId = input<string | null>(null);
  readonly task = input<Task | null>(null);

  readonly planAdded = output<void>();

  readonly activePlan = computed(() => this.store.taskControl()?.activePlan ?? null);
  readonly activePlanHtml = computed(() =>
    markdownToHtml(this.store.taskControl()?.activePlan?.body ?? ''),
  );

  submitPlan(titleInput: HTMLInputElement, bodyInput: HTMLTextAreaElement): void {
    const roomId = this.roomId();
    const task = this.task();
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
        this.planAdded.emit();
      });
  }
}
