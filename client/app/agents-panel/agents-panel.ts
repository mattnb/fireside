// client/app/agents-panel/agents-panel.ts
// Left presence rail. Shows the project agents (when no room is selected)
// or the active room's roster as ring-bearing rail-agent rows. Includes
// the YOLO turn bank when YOLO mode is engaged. Running-run telemetry
// previously rendered here as the "Working" section now lives in the
// mission-outline rail on the right of the chat tab — App stops piping
// run data into this component.

import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { RailAgent } from '../rail-agent/rail-agent';
import type { AgentId } from '../api.types';

@Component({
  selector: 'fs-agents-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  readonly yoloBankVisible = input<boolean>(false);
  readonly yoloActive = input<boolean>(false);
  readonly yoloTone = input<'ready' | 'green' | 'yellow' | 'red'>('ready');
  readonly yoloCounterText = input<string>('');
  readonly yoloPercentRemaining = input<number>(100);

  readonly addYoloTurnsRequested = output<void>();
  readonly compactRequested = output<{ agentId: AgentId; event: Event }>();
  readonly recheckQuotaRequested = output<AgentId>();
  readonly manageAgentsRequested = output<void>();
}
