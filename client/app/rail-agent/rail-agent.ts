// client/app/rail-agent/rail-agent.ts
// Single agent in the right-hand presence panel: tri-wedge SVG ring (ctx
// context, 5-hour quota, 7-day quota), avatar, persona, and status. All
// resolution flows through `AgentDisplayService` and `AgentRingService`
// — children inject the services directly so this component only carries
// its agent id + the optional compact-request output.

import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { AgentRingService } from '../agent-ring.service';
import { MissionStore } from '../mission-store';
import type { AgentId } from '../api.types';

export type { AgentRailKind } from '../agent-display.service';
export type { RingTone } from '../agent-ring.service';

@Component({
  selector: 'fs-rail-agent',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rail-agent.html',
  styleUrl: './rail-agent.css',
})
export class RailAgent {
  protected readonly display = inject(AgentDisplayService);
  protected readonly ring = inject(AgentRingService);
  protected readonly store = inject(MissionStore);

  readonly agentId = input.required<AgentId>();
  readonly compactRequested = output<{ agentId: AgentId; event: Event }>();
  readonly recheckRequested = output<AgentId>();

  protected isLead(): boolean {
    return this.store.selectedRoom()?.leadAgentId === this.agentId();
  }

  /** Per-wedge red gate: drives whether each recheck pill renders + reveals on
   *  hover. h5 hint shows when h5 is red OR the agent is currently blocked
   *  (provider-level signal, so it appears on both wedges). Same for d7. */
  protected showH5Recheck(): boolean {
    const id = this.agentId();
    return this.ring.fiveHourTone(id) === 'red' || this.display.isAgentQuotaBlocked(id);
  }

  protected showD7Recheck(): boolean {
    const id = this.agentId();
    return this.ring.sevenDayTone(id) === 'red' || this.display.isAgentQuotaBlocked(id);
  }

  /** Click on either wedge-hit fires recheck only when at least one trigger
   *  is active. Click on a green/yellow non-blocked wedge is a no-op. */
  protected canRecheck(): boolean {
    const id = this.agentId();
    return (
      this.ring.fiveHourTone(id) === 'red' ||
      this.ring.sevenDayTone(id) === 'red' ||
      this.display.isAgentQuotaBlocked(id)
    );
  }

  protected onQuotaWedgeClick(event: Event): void {
    if (!this.canRecheck()) return;
    event.stopPropagation();
    this.recheckRequested.emit(this.agentId());
  }
}
