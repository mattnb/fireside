// client/app/compact-agent-modal/compact-agent-modal.ts
// "Compact agent context" dialog. Shows an agent's running state, current
// context usage bar, any error from a prior attempt, and a "compact now"
// button. Pulls all agent metadata + ring math from injected services.

import { Component, inject, input, output } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { AgentRingService } from '../agent-ring.service';
import { MissionStore } from '../mission-store';
import type { AgentId } from '../api.types';

@Component({
  selector: 'fs-compact-agent-modal',
  standalone: true,
  templateUrl: './compact-agent-modal.html',
  styleUrl: './compact-agent-modal.css',
})
export class CompactAgentModal {
  protected readonly display = inject(AgentDisplayService);
  protected readonly ring = inject(AgentRingService);
  protected readonly store = inject(MissionStore);

  readonly agentId = input.required<AgentId>();
  readonly error = input<string>('');

  readonly closed = output<void>();
  readonly compactStarted = output<AgentId>();
}
