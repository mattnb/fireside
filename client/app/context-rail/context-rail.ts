// client/app/context-rail/context-rail.ts
// Right-side rail for the workspace: small visible-artifacts list and
// completed-runs list. Pure presentational — App owns the lists, this
// component renders + emits artifact-remove and run-open events.

import { Component, inject, input, output } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import type { AgentRun, Artifact } from '../api.types';

@Component({
  selector: 'fs-context-rail',
  standalone: true,
  templateUrl: './context-rail.html',
  styleUrl: './context-rail.css',
})
export class ContextRail {
  protected readonly display = inject(AgentDisplayService);

  readonly artifacts = input<Artifact[]>([]);
  readonly totalArtifactCount = input<number>(0);
  readonly completedRuns = input<AgentRun[]>([]);

  readonly canRemoveArtifact = input<(artifact: Artifact) => boolean>(() => false);
  readonly formatBytes = input<(bytes: number | undefined) => string>(() => '0 B');
  readonly formatShortTime = input<(timestamp: number | undefined) => string>(() => '');
  readonly runMeta = input<(run: AgentRun) => string>(() => '');
  readonly runActionSignal = input<(run: AgentRun) => string>(() => '');

  readonly artifactRemoved = output<Artifact>();
  readonly runOpened = output<string>();
}
