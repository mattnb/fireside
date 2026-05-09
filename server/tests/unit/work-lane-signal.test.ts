// Regression coverage for the close-out loop bug. `workLaneSignal` previously
// returned 'done' on stand-down acknowledgments containing tokens like
// "accepted" / "complete" / "verified" / "merged" — words that show up
// naturally when an agent acknowledges *someone else's* landed work. That
// misclassification fed a second violation into `validateWorkflowContract`,
// blocked the safe auto-receipt-synthesis path, and dispatched a real
// workflow-repair turn that the loop kept feeding from. Real samples below
// are taken verbatim from `data/fireside.sqlite` runs at 00:39-00:50 on
// 2026-05-09 (room `0T8m7OlK9FzC`, agent `claude-principal-software`).

import { describe, expect, it } from 'vitest';
import { workLaneSignal } from '../../src/mission-state/mission-receipt-applicator.js';

describe('workLaneSignal — stand-down acknowledgments', () => {
  it('classifies "Standing down + mission closed at HEAD" as conversational (none)', () => {
    const text =
      'The mission is accepted and closed. Standing down on Prosaic; ready for the next assignment whenever you queue one up, @michael.';
    expect(workLaneSignal(text)).toBe('none');
  });

  it('classifies "Mission already closed at <hash>" acknowledgment as none', () => {
    const text =
      'Mission already closed at `48543a7` with Brown\'s QA green and acceptance verdict recorded. No lane 1 changes pending from me. Standing by for the next mission brief.';
    expect(workLaneSignal(text)).toBe('none');
  });

  it('classifies "Mission is closed and verdicts are aligned" as none', () => {
    const text =
      'Mission is closed and verdicts are aligned across @michael, @brown, and me. No outstanding lane work, no blockers, and no pending QA from this thread. Standing by for the next mission brief from Matt.';
    expect(workLaneSignal(text)).toBe('none');
  });

  it('classifies "Acknowledged. Mission closed at <hash> with all lanes accepted" as none', () => {
    const text =
      'Acknowledged. Mission closed at `aa6c817` with all three lanes accepted and Brown\'s final clean-HEAD QA green. Standing down on Prosaic until the next mission is queued.';
    expect(workLaneSignal(text)).toBe('none');
  });

  it('classifies "Acknowledged + nothing further from me" as none', () => {
    const text =
      'Acknowledged, Brown — thanks for the explicit lane-1 all-clear. Nothing further from me on Prosaic; standing down until the next mission lands.';
    expect(workLaneSignal(text)).toBe('none');
  });

  it('classifies "Standing down. Mission is closed... nothing further" as none', () => {
    const text =
      'Standing down. Mission is closed at `aa6c817` with Brown\'s final QA green and Michael\'s accepted verdict on record — nothing further from lane 1.';
    expect(workLaneSignal(text)).toBe('none');
  });

  it('classifies "Acknowledged on holding lane 1 implementation. No further metric or fixture changes" as none', () => {
    const text =
      "Acknowledged on holding lane 1 implementation. No further metric or fixture changes from me unless Brown's `aa6c817` rerun surfaces a regression I own.";
    expect(workLaneSignal(text)).toBe('none');
  });

  it('classifies "Standing down as instructed; lane fully closed" as none', () => {
    const text =
      "Standing down as instructed; lane 1 is fully closed and Brown's final clean-HEAD QA at `aa6c817` already posted green evidence. @michael you should see the same.";
    expect(workLaneSignal(text)).toBe('none');
  });

  it('classifies "Mission is QA-closed at <hash>... standing down per lead direction" as none', () => {
    const text =
      "Mission is QA-closed at `2b8ec40` with Brown's final clean-HEAD verification posted and Michael's integration acceptance recorded. No outstanding lane for me; standing down on Prosaic per lead direction";
    expect(workLaneSignal(text)).toBe('none');
  });
});

describe('workLaneSignal — real work claims still trigger done', () => {
  it("classifies a fresh commit handoff as 'done'", () => {
    const text =
      "@brown @michael Resolved. The dirty `prosaic-core/src/discourse.rs` was Lane 3 burst-pivot same-side cadence work — now committed as `3c3eb9e` with a follow-on fixture pin in `aa6c817`. HEAD has advanced past `c482b61` to `aa6c817`; working tree is clean.";
    expect(workLaneSignal(text)).toBe('done');
  });

  it("classifies 'Implementation landed in commit X' as 'done'", () => {
    const text =
      'Implementation landed in commit `2b8ec40`. Posting handoff to Brown with files, regression names, and the rendered service-sample excerpt for direct counting.';
    expect(workLaneSignal(text)).toBe('done');
  });

  it("classifies 'tests pass' as 'done'", () => {
    const text =
      'Suite finished, tests passed: 700/700 across the workspace including focused regressions on the discourse path.';
    expect(workLaneSignal(text)).toBe('done');
  });
});

describe('workLaneSignal — blocked patterns still detected', () => {
  it("classifies 'blocked on permission' as 'blocked'", () => {
    expect(workLaneSignal('Blocked on permission to write to /etc/hosts.')).toBe('blocked');
  });

  it("classifies 'waiting for human approval' as 'blocked'", () => {
    expect(workLaneSignal('I am waiting for human approval before I proceed.')).toBe('blocked');
  });
});

describe('workLaneSignal — incomplete patterns still detected', () => {
  it("classifies 'still pending' as 'none'", () => {
    expect(workLaneSignal('That regression is still pending; I will continue tomorrow.')).toBe(
      'none',
    );
  });

  it("classifies 'will continue' as 'none'", () => {
    expect(workLaneSignal('Lane 2 is partially in place; I will continue once Brown signs off.')).toBe(
      'none',
    );
  });
});

describe('workLaneSignal — empty and conversational text', () => {
  it("classifies empty text as 'none'", () => {
    expect(workLaneSignal('')).toBe('none');
    expect(workLaneSignal('   \n  \t')).toBe('none');
  });

  it("classifies a code-fence-only reply as 'none'", () => {
    expect(workLaneSignal('``` ```')).toBe('none');
  });

  it("classifies pure planning chatter as 'none'", () => {
    expect(
      workLaneSignal('Looking at the code path and considering whether to factor out a helper.'),
    ).toBe('none');
  });
});
