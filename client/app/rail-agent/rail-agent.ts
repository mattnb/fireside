// client/app/rail-agent/rail-agent.ts
// Single agent in the right-hand presence panel: tri-wedge SVG ring (ctx
// context, 5-hour quota, 7-day quota), avatar, persona, and status. All
// resolution flows through `AgentDisplayService` and `AgentRingService`
// — children inject the services directly so this component only carries
// its agent id + the optional compact-request output.

import { Component, inject, input, output } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { AgentRingService } from '../agent-ring.service';
import { MissionStore } from '../mission-store';
import type { AgentId } from '../api.types';

export type { AgentRailKind } from '../agent-display.service';
export type { RingTone } from '../agent-ring.service';

@Component({
  selector: 'fs-rail-agent',
  standalone: true,
  templateUrl: './rail-agent.html',
  styleUrl: './rail-agent.css',
})
export class RailAgent {
  protected readonly display = inject(AgentDisplayService);
  protected readonly ring = inject(AgentRingService);
  protected readonly store = inject(MissionStore);

  readonly agentId = input.required<AgentId>();
  readonly compactRequested = output<{ agentId: AgentId; event: Event }>();

  protected isLead(): boolean {
    return this.store.selectedRoom()?.leadAgentId === this.agentId();
  }
}
