import type { PipelineStep } from '../../core/pipeline.js';
import type { AgentReplySignalPipelineContext } from '../types.js';

// Pre-Phase-2 this step normalized hallucinated `<!--FIRESIDE:<name> v=N
// ...-->` envelopes into canonical slash-block form so downstream
// extractors could parse them. Phase 2 (2026-05-09) removed every
// extractor — MCP is the canonical and only mission/collab/permission
// tool entry point — so the step's job becomes purely defensive: scrub
// any leaked slash-block-shaped payload from the visible chat surface,
// regardless of source. Three patterns get stripped:
//
//   1. `<!--FIRESIDE:<name> v=N ... /end-<name>-->`     (malformed envelope)
//   2. `/<name> ... /end-<name>`                        (plain slash block)
//   3. `<!--FIRESIDE:<name> v=N ... -->` without close  (degenerate envelope)
//
// Names are restricted to the historical fireside slash-block surface so
// we don't accidentally strip user-typed `/foo`-style prose. When an
// agent doesn't emit any of these patterns the step is a no-op and
// returns the context object unchanged.
const LEAKED_SLASH_BLOCK_NAMES = [
  'mission-task',
  'mission-tasks',
  'mission-receipt',
  'mission-receipts',
  'mission-plan',
  'mission-plans',
  'mission-phase',
  'mission-phases',
  'mission-create',
  'collab-note',
  'collab-notes',
  'permission-request',
  'agent-roster',
] as const;

const NAME_PATTERN = LEAKED_SLASH_BLOCK_NAMES.join('|');
// Matches `<!--FIRESIDE:<name> v=N ... /end-<other-name>-->` (envelope form,
// agents sometimes mismatch start/end names). Tolerant of the close tag
// being absent up to a closing `-->`.
const FIRESIDE_ENVELOPE_RE = new RegExp(
  String.raw`<!--\s*FIRESIDE:(?:${NAME_PATTERN})(?:\s+v=\d+)?\s*[\s\S]*?(?:\/end-(?:${NAME_PATTERN}))?\s*-->`,
  'gi',
);
// Matches `/<name>` (optionally inside `<!-- ... -->`) ... `/end-<name>`,
// the canonical slash-block fallback shape.
const SLASH_BLOCK_RE = new RegExp(
  String.raw`(^|\n)[^\S\n]*(?:<!--\s*)?\/?(?:${NAME_PATTERN})\b[\s\S]*?\/end-(?:${NAME_PATTERN})\s*(?:-->)?[^\S\n]*(?=\n|$)`,
  'gi',
);

export function stripLeakedSlashBlocks(text: string): { visibleText: string; count: number } {
  let count = 0;
  const stripped = text
    .replace(FIRESIDE_ENVELOPE_RE, () => {
      count += 1;
      return '';
    })
    .replace(SLASH_BLOCK_RE, (_match, prefix: string) => {
      count += 1;
      return prefix === '\n' ? '\n' : '';
    });
  if (count === 0) return { visibleText: text, count };
  return { visibleText: stripped.replace(/\n{3,}/g, '\n\n').trim(), count };
}

export const normalizeFiresideEnvelopesStep: PipelineStep<AgentReplySignalPipelineContext> = {
  name: 'reply.strip-leaked-slash-blocks',
  run(context) {
    const { visibleText, count } = stripLeakedSlashBlocks(context.visibleText);
    if (count === 0) return context;
    return {
      ...context,
      visibleText,
      textAfterMissionReceipts: visibleText,
    };
  },
};
