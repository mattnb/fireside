// client/app/completed-runs-modal/completed-runs-modal.ts
// Modal triggered from the runs-rail "history" icon. Shows the latest
// completed runs (any status other than 'running') as clickable cards that
// open the run-detail modal.

import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { MissionStore } from '../mission-store';
import {
  elapsedLabel as fmtElapsedLabel,
  oneLine as fmtOneLine,
} from '../formatters';
import type { AgentRun, AgentRunAction } from '../api.types';

@Component({
  selector: 'fs-completed-runs-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './completed-runs-modal.html',
  styleUrl: './completed-runs-modal.css',
})
export class CompletedRunsModal {
  protected readonly display = inject(AgentDisplayService);
  private readonly store = inject(MissionStore);

  readonly closed = output<void>();
  readonly runOpened = output<string>();

  readonly completedRuns = computed(() =>
    this.store
      .runs()
      .filter((run) => run.status !== 'running')
      .sort((a, b) => (b.completedAt ?? b.startedAt ?? 0) - (a.completedAt ?? a.startedAt ?? 0))
      .slice(0, 50),
  );

  protected runMeta(run: AgentRun): string {
    const elapsed = fmtElapsedLabel(run.startedAt, run.completedAt, Date.now());
    const tokens = run.estimatedPromptTokens
      ? `${run.estimatedPromptTokens.toLocaleString()} tokens`
      : '';
    return [elapsed, tokens, run.permissionMode || ''].filter(Boolean).join(' / ');
  }

  protected runActionSignal(run: AgentRun): string {
    const action = this.latestActionForRun(run.id);
    if (action) return fmtOneLine(action.label, 100);
    return run.lastSignal || run.summary || run.error || '';
  }

  private latestActionForRun(runId: string): AgentRunAction | null {
    return (
      this.store
        .runActions()
        .filter((action) => action.runId === runId)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    );
  }
}
