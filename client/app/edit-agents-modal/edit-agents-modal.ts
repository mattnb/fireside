// client/app/edit-agents-modal/edit-agents-modal.ts
// Edit-agents-in-room dialog. Same DraftRoomAgent[] shape as create-room
// but bound to the App's `editRoomAgentRows` rather than the new-room
// rows. Pure shell; saving funnels through `(saved)`.

import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';

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
  selector: 'fs-edit-agents-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './edit-agents-modal.html',
  styleUrl: './edit-agents-modal.css',
})
export class EditAgentsModal {
  protected readonly display = inject(AgentDisplayService);

  readonly roomName = input<string>('');
  readonly agentRows = input<DraftRoomAgent[]>([]);
  readonly providers = input<AgentProviderCatalogItem[]>([]);
  readonly personas = input<AgentPersona[]>([]);
  readonly providerRecommendations = input<Record<string, ProviderScoreSlotResult | undefined>>({});
  readonly agentValidationError = input<string>('');
  readonly leadClientId = input<string>('');

  readonly closed = output<void>();
  readonly saved = output<void>();
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
