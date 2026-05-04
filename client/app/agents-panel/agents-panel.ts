// client/app/agents-panel/agents-panel.ts
// Right-hand presence rail. Two sections:
//   1. Agents — bare project-agent rows (when no room is selected) or
//      `<fs-rail-agent>` rings keyed off the active room's agents. Includes
//      the YOLO turn bank when YOLO mode is engaged.
//   2. Working — running run cards with optional dismiss for stale cues.
// Agent identity / ring resolution comes from `AgentDisplayService`. Run
// formatters still flow in as input fns until a future RunFormatterService
// extraction.

import { Component, inject, input, output } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { RailAgent } from '../rail-agent/rail-agent';
import type { AgentId, AgentRun } from '../api.types';

@Component({
  selector: 'fs-agents-panel',
  standalone: true,
  imports: [RailAgent],
  templateUrl: './agents-panel.html',
  styleUrl: './agents-panel.css',
})
export class AgentsPanel {
  protected readonly display = inject(AgentDisplayService);

  readonly hasRoom = input<boolean>(false);
  readonly projectAgents = input<AgentId[]>([]);
  readonly projectYoloAgents = input<AgentId[]>([]);
  readonly roomAgents = input<AgentId[]>([]);
  readonly roomYoloAgents = input<AgentId[]>([]);
  readonly runningRuns = input<AgentRun[]>([]);

  readonly yoloBankVisible = input<boolean>(false);
  readonly yoloActive = input<boolean>(false);
  readonly yoloTone = input<'ready' | 'green' | 'yellow' | 'red'>('ready');
  readonly yoloCounterText = input<string>('');
  readonly yoloPercentRemaining = input<number>(100);

  readonly elapsedLabel = input<(startedAt?: number, completedAt?: number | null) => string>(
    () => '',
  );
  readonly runMeta = input<(run: AgentRun) => string>(() => '');
  readonly runActionSignal = input<(run: AgentRun) => string>(() => '');
  readonly runDraftSignal = input<(run: AgentRun) => string>(() => '');
  readonly isRunStale = input<(run: AgentRun) => boolean>(() => false);
  readonly canDismissRun = input<(run: AgentRun) => boolean>(() => false);

  readonly addYoloTurnsRequested = output<void>();
  readonly compactRequested = output<{ agentId: AgentId; event: Event }>();
  readonly runOpened = output<string>();
  readonly runDismissed = output<{ run: AgentRun; event: Event }>();
  readonly manageAgentsRequested = output<void>();
}
