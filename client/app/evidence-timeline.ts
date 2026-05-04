// client/app/evidence-timeline.ts
// Types for the unified evidence timeline. The merge logic that produces
// EvidenceEvent[] currently lives in App (it consumes mission receipts,
// collaboration items, artifacts, and completed runs along with App-side
// agent name/run-formatting helpers). The shape is shared with EvidenceView,
// which owns filtering and rendering.

import type { Artifact } from './api.types';

export type EvidenceFilter =
  | 'all'
  | 'receipts'
  | 'notes'
  | 'decisions'
  | 'blockers'
  | 'artifacts'
  | 'runs';

export type EvidenceEventKind =
  | 'receipt'
  | 'note'
  | 'decision'
  | 'blocker'
  | 'artifact'
  | 'run-completed'
  | 'run-failed';

export interface EvidenceEvent {
  id: string;
  kind: EvidenceEventKind;
  bucket: Exclude<EvidenceFilter, 'all'>;
  title: string;
  body: string;
  meta: string;
  time: number;
  actor?: string | undefined;
  artifact?: Artifact | undefined;
  runId?: string | undefined;
}
