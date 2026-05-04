// client/app/runs-rail/runs-rail.ts
// Right-side rail in the chat tab. Header is "Runs" with an icon button
// that opens the completed-runs modal; below is an "Agents running"
// subheader and a list of work-cards (one per active run). Reads runs
// straight from MissionStore so App doesn't have to plumb them through.

import { Component, computed, inject, output } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { MissionStore } from '../mission-store';
import {
  elapsedLabel as fmtElapsedLabel,
  oneLine as fmtOneLine,
} from '../formatters';
import type { AgentRun, AgentRunAction } from '../api.types';

@Component({
  selector: 'fs-runs-rail',
  standalone: true,
  templateUrl: './runs-rail.html',
  styleUrl: './runs-rail.css',
})
export class RunsRail {
  protected readonly display = inject(AgentDisplayService);
  private readonly store = inject(MissionStore);

  readonly runOpened = output<string>();
  readonly completedRunsRequested = output<void>();

  readonly runningRuns = computed(() => this.store.runs().filter((r) => r.status === 'running'));

  protected elapsed(run: AgentRun): string {
    return fmtElapsedLabel(run.startedAt, run.completedAt, Date.now());
  }

  protected runMeta(run: AgentRun): string {
    const turn =
      run.maxTurns && run.maxTurns > 1 && run.continuationTurn
        ? `${run.continuationTurn}/${run.maxTurns}`
        : '';
    const tokens = run.estimatedPromptTokens
      ? `${run.estimatedPromptTokens.toLocaleString()} tokens`
      : '';
    const mode = run.permissionMode || '';
    return [turn, tokens, mode].filter(Boolean).join(' / ');
  }

  protected runActionSignal(run: AgentRun): string {
    const action = this.latestActionForRun(run.id);
    if (action) return fmtOneLine(action.label, 80);
    return run.lastSignal || run.summary || 'waiting for first broker signal';
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
