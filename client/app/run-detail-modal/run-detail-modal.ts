// client/app/run-detail-modal/run-detail-modal.ts
// First modal extraction. Establishes the dialog pattern that
// permission-requests-modal and edit-agents-modal will follow next: scrim
// click + close button both fire `(closed)`, the panel sets `role="dialog"`
// and `aria-modal`, and the parent owns visibility via an @if gate.
//
// Pure presentational shell — all helpers (run formatters, signal/action
// filters) come in as input fns; lifecycle events bubble out.

import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import type {
  AgentRun,
  AgentRunAction,
  AgentRunDetail,
  AgentToolCallView,
  PermissionRequest,
} from '../api.types';

@Component({
  selector: 'fs-run-detail-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './run-detail-modal.html',
  styleUrl: './run-detail-modal.css',
})
export class RunDetailModal {
  protected readonly display = inject(AgentDisplayService);

  readonly runDetail = input<AgentRunDetail | null>(null);
  readonly loading = input<boolean>(false);
  readonly error = input<string>('');
  readonly showLowSignalEvents = input<boolean>(false);

  readonly elapsedLabel = input<(startedAt?: number, completedAt?: number | null) => string>(
    () => '',
  );
  readonly permissionModeLabel = input<(mode: string | undefined) => string>(() => '');
  readonly formatDateTime = input<(timestamp: number | undefined | null) => string>(() => '');
  readonly formatShortTime = input<(timestamp: number | undefined) => string>(() => '');
  readonly oneLine = input<(text: string | undefined | null, maxChars?: number) => string>(
    () => '',
  );
  readonly targetStatusText = input<(item: PermissionRequest | AgentRun) => string>(
    () => 'unknown',
  );
  readonly capabilityText = input<(caps: string[] | undefined) => string>(() => 'none');

  readonly visibleDiagnosticSignals = input<
    (
      signals: AgentRunDetail['diagnostics']['signals'] | undefined,
    ) => AgentRunDetail['diagnostics']['signals']
  >(() => []);
  readonly hiddenDiagnosticSignalCount = input<
    (signals: AgentRunDetail['diagnostics']['signals'] | undefined) => number
  >(() => 0);
  readonly lowSignalDiagnosticSignalCount = input<
    (signals: AgentRunDetail['diagnostics']['signals'] | undefined) => number
  >(() => 0);
  readonly providerSignalDetail = input<
    (signal: { kind: string; label: string; detail?: string }) => string
  >(() => '');

  readonly visibleRunActions = input<(actions: AgentRunAction[]) => AgentRunAction[]>(
    () => [],
  );
  readonly hiddenRunActionCount = input<(actions: AgentRunAction[]) => number>(() => 0);
  readonly lowSignalRunActionCount = input<(actions: AgentRunAction[]) => number>(() => 0);
  readonly runActionDetail = input<(action: AgentRunAction) => string>(() => '');

  readonly closed = output<void>();
  readonly lowSignalToggled = output<Event>();
  readonly stopRequested = output<string>();

  protected toolCallTitle(call: AgentToolCallView): string {
    const target = call.target ? ` ${call.target}` : '';
    return `${call.toolName}${target}`;
  }

  protected formatJson(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  protected hasFields(record: Record<string, unknown> | null | undefined): boolean {
    return !!record && Object.keys(record).length > 0;
  }
}
