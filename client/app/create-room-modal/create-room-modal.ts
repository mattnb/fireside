// client/app/create-room-modal/create-room-modal.ts
// "New mission" dialog: name field + agent draft rows (provider, persona,
// yolo flag). Pure shell — App owns the draft state (`newRoomAgentRows`),
// this component just renders + emits per-row edit events. Modal pattern:
// scrim click + cancel button both fire `(closed)`.

import { Component, inject, input, output } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import type {
  AgentPersona,
  AgentProviderCatalogItem,
  ProviderId,
  ProviderScoreCandidate,
  ProviderScoreSlotResult,
} from '../api.types';
import type { DraftRoomAgent } from '../room-agent-types';

@Component({
  selector: 'fs-create-room-modal',
  standalone: true,
  templateUrl: './create-room-modal.html',
  styleUrl: './create-room-modal.css',
})
export class CreateRoomModal {
  protected readonly display = inject(AgentDisplayService);

  readonly projectNameDisplay = input<string>('');
  readonly agentRows = input<DraftRoomAgent[]>([]);
  readonly providers = input<AgentProviderCatalogItem[]>([]);
  readonly personas = input<AgentPersona[]>([]);
  readonly providerRecommendations = input<Record<string, ProviderScoreSlotResult | undefined>>({});
  readonly agentValidationError = input<string>('');
  readonly leadClientId = input<string>('');

  readonly closed = output<void>();
  readonly missionSubmitted = output<HTMLInputElement>();
  readonly agentNameSet = output<{ clientId: string; event: Event }>();
  readonly agentProviderSet = output<{ clientId: string; event: Event }>();
  readonly agentPersonaSet = output<{ clientId: string; event: Event }>();
  readonly agentYoloToggled = output<{ clientId: string; event: Event }>();
  readonly agentLeadSet = output<string>();
  readonly agentProviderRecommended = output<{ clientId: string; providerId: ProviderId }>();
  readonly agentRemoved = output<string>();
  readonly agentAdded = output<void>();

  recommendationFor(clientId: string): ProviderScoreSlotResult | null {
    return this.providerRecommendations()[clientId] ?? null;
  }

  selectedCandidate(recommendation: ProviderScoreSlotResult) {
    return recommendation.candidates.find((candidate) => candidate.selected) ?? null;
  }

  currentCandidate(row: DraftRoomAgent, recommendation: ProviderScoreSlotResult) {
    return recommendation.candidates.find((candidate) => candidate.providerId === row.providerId) ?? null;
  }

  recommendationLabel(recommendation: ProviderScoreSlotResult): string {
    const providerId = recommendation.selectedProviderId;
    if (!providerId) return 'No provider recommendation available';
    const provider = this.display.providerForId(providerId).displayName;
    return recommendation.recommendationMatchesCurrent ? `${provider} is recommended` : `Recommended: ${provider}`;
  }

  recommendationDetail(recommendation: ProviderScoreSlotResult): string {
    const candidate = this.selectedCandidate(recommendation);
    if (!candidate) return '';
    const reasons = candidate.reasons.slice(0, 2);
    const warnings = candidate.warnings.slice(0, 1);
    return [...reasons, ...warnings].join(' / ');
  }

  whyNotCurrent(row: DraftRoomAgent, recommendation: ProviderScoreSlotResult): string {
    if (recommendation.recommendationMatchesCurrent) {
      const runnerUp = recommendation.candidates.find((candidate) => !candidate.selected);
      return runnerUp ? `runner-up ${this.candidateSummary(runnerUp)}` : '';
    }
    const current = this.currentCandidate(row, recommendation);
    return current ? `current ${this.candidateSummary(current)}` : '';
  }

  private candidateSummary(candidate: ProviderScoreCandidate): string {
    const provider = this.display.providerForId(candidate.providerId).displayName;
    const warnings = candidate.warnings.slice(0, 2);
    if (warnings.length > 0) return `${provider}: ${warnings.join(' / ')}`;
    const reasons = candidate.reasons.slice(0, 2);
    return `${provider}: ${reasons.join(' / ') || `score ${Math.round(candidate.score)}`}`;
  }
}
