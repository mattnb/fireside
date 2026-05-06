// client/app/edit-agents-modal/edit-agents-modal.ts
// Edit-agents-in-room dialog. Roster master/detail layout: left rail lists
// every agent currently in the room, right pane edits the selected one. The
// modal enforces the single-lead-per-room invariant by surfacing an inline
// banner when lead is reassigned ("lead unassigned from <previous>").

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import type {
  AgentPersona,
  AgentProviderCatalogItem,
  ProviderId,
  ProviderScoreCandidate,
  ProviderScoreSlotResult,
} from '../api.types';
import type { DraftRoomAgent } from '../room-agent-types';

const LEAD_BANNER_MS = 5000;

@Component({
  selector: 'fs-edit-agents-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './edit-agents-modal.html',
  styleUrl: './edit-agents-modal.css',
})
export class EditAgentsModal {
  protected readonly display = inject(AgentDisplayService);
  private readonly destroyRef = inject(DestroyRef);

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
  readonly agentModelSet = output<{ clientId: string; event: Event }>();
  readonly agentReasoningSet = output<{ clientId: string; event: Event }>();
  readonly agentAutoCompactToggled = output<{ clientId: string; event: Event }>();
  readonly agentAutoCompactPercentSet = output<{ clientId: string; event: Event }>();
  readonly agentYoloToggled = output<{ clientId: string; event: Event }>();
  readonly agentLeadSet = output<string>();
  readonly agentProviderRecommended = output<{ clientId: string; providerId: ProviderId }>();
  readonly agentRemoved = output<string>();
  readonly agentAdded = output<void>();

  // The currently-selected agent in the rail. Bare signal for explicit
  // selection; selectedClientId() falls back when the chosen row no longer
  // exists (e.g. after removal) so the right pane never points at nothing.
  private readonly _selectedClientId = signal<string>('');

  readonly selectedClientId = computed<string>(() => {
    const rows = this.agentRows();
    if (rows.length === 0) return '';
    const candidate = this._selectedClientId();
    if (candidate && rows.some((row) => row.clientId === candidate)) return candidate;
    return rows[0]?.clientId ?? '';
  });

  readonly selectedRow = computed<DraftRoomAgent | null>(() => {
    const id = this.selectedClientId();
    if (!id) return null;
    return this.agentRows().find((row) => row.clientId === id) ?? null;
  });

  // "lead unassigned from <name>" banner — set when leadClientId() changes
  // from one agent to another. Auto-clears after LEAD_BANNER_MS.
  readonly leadReassignedFrom = signal<string | null>(null);
  private previousLeadClientId: string | null = null;
  private bannerTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private prevRowCount = -1;

  constructor() {
    // Auto-select the newly-added agent so the user can edit it immediately.
    effect(() => {
      const rows = this.agentRows();
      const prev = this.prevRowCount;
      if (prev !== -1 && rows.length > prev) {
        const last = rows[rows.length - 1];
        if (last) untracked(() => this._selectedClientId.set(last.clientId));
      }
      this.prevRowCount = rows.length;
    });

    // Detect lead reassignment (X -> Y, both non-empty) and surface a banner
    // pointing at the previous lead. A toggle-off (Y -> '') or a fresh
    // assignment ('' -> Y) is silent — only true reassignments need the cue.
    effect(() => {
      const current = this.leadClientId();
      const previous = this.previousLeadClientId;
      if (
        previous !== null &&
        previous !== '' &&
        current !== '' &&
        previous !== current
      ) {
        const rows = untracked(() => this.agentRows());
        const previousRow = rows.find((row) => row.clientId === previous);
        const name = previousRow?.displayName?.trim() || 'unnamed agent';
        untracked(() => this.leadReassignedFrom.set(name));
        this.scheduleBannerClear();
      }
      this.previousLeadClientId = current;
    });

    this.destroyRef.onDestroy(() => {
      if (this.bannerTimeoutId !== null) {
        clearTimeout(this.bannerTimeoutId);
        this.bannerTimeoutId = null;
      }
    });
  }

  selectAgent(clientId: string): void {
    this._selectedClientId.set(clientId);
  }

  isSelected(clientId: string): boolean {
    return this.selectedClientId() === clientId;
  }

  isLead(clientId: string): boolean {
    return this.leadClientId() === clientId;
  }

  hasOpenRecommendation(clientId: string): boolean {
    const rec = this.providerRecommendations()[clientId];
    return !!rec && !rec.recommendationMatchesCurrent;
  }

  recommendationFor(clientId: string): ProviderScoreSlotResult | null {
    return this.providerRecommendations()[clientId] ?? null;
  }

  selectedCandidate(recommendation: ProviderScoreSlotResult) {
    return recommendation.candidates.find((candidate) => candidate.selected) ?? null;
  }

  currentCandidate(row: DraftRoomAgent, recommendation: ProviderScoreSlotResult) {
    return (
      recommendation.candidates.find((candidate) => candidate.providerId === row.providerId) ?? null
    );
  }

  recommendationLabel(recommendation: ProviderScoreSlotResult): string {
    const providerId = recommendation.selectedProviderId;
    if (!providerId) return 'No provider recommendation available';
    const provider = this.display.providerForId(providerId).displayName;
    return recommendation.recommendationMatchesCurrent
      ? `${provider} is recommended`
      : `Recommended: ${provider}`;
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

  private scheduleBannerClear(): void {
    if (this.bannerTimeoutId !== null) clearTimeout(this.bannerTimeoutId);
    this.bannerTimeoutId = setTimeout(() => {
      this.leadReassignedFrom.set(null);
      this.bannerTimeoutId = null;
    }, LEAD_BANNER_MS);
  }
}
