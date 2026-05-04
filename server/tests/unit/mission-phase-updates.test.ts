import { describe, expect, it } from 'vitest';
import { extractMissionPhaseUpdates } from '../../src/mission-phase-updates.js';

describe('mission phase update extraction', () => {
  it('extracts inline phase commands without exposing protocol text', () => {
    const extracted = extractMissionPhaseUpdates(`Gate closed.

/mission-phase action: update, name: Memo-first Live Verification, status: done, note: Evidence recorded.
/end-mission-phase`);

    expect(extracted.visibleText).toBe('Gate closed.');
    expect(extracted.visibleText).not.toContain('/mission-phase');
    expect(extracted.updates).toMatchObject([
      {
        action: 'update',
        title: 'Memo-first Live Verification',
        status: 'done',
      },
    ]);
  });

  it('extracts hidden phase updates and leaves visible chat text', () => {
    const extracted = extractMissionPhaseUpdates(`Planning note.

/mission-phase
action: create
title: Planning
status: active
gate: Direction is agreed and dependencies are known
description: Establish the plan before editing
sort_order: 1
/end-mission-phase

Ready to proceed.`);

    expect(extracted.visibleText).toContain('Planning note.');
    expect(extracted.visibleText).toContain('Ready to proceed.');
    expect(extracted.visibleText).not.toContain('/mission-phase');
    expect(extracted.updates).toEqual([
      {
        action: 'create',
        id: '',
        planRef: '',
        title: 'Planning',
        description: 'Establish the plan before editing',
        status: 'active',
        gate: 'Direction is agreed and dependencies are known',
        sortOrder: 1,
      },
    ]);
  });

  it('recognizes phase blocks when they are not at the start of the message', () => {
    const extracted = extractMissionPhaseUpdates(`Visible first.

/mission-phase
action: update
phase: Verification
state: done
criteria: Tests and review evidence are recorded
/end-mission-phase`);

    expect(extracted.visibleText).toBe('Visible first.');
    expect(extracted.updates).toMatchObject([
      {
        action: 'update',
        planRef: '',
        title: 'Verification',
        status: 'done',
        gate: 'Tests and review evidence are recorded',
      },
    ]);
  });

  it('normalizes completion-oriented status aliases to done', () => {
    const extracted = extractMissionPhaseUpdates(`Gate satisfied.

/mission-phase
action: update
title: Audit Merge
status: complete
/end-mission-phase`);

    expect(extracted.visibleText).toBe('Gate satisfied.');
    expect(extracted.updates).toMatchObject([
      {
        action: 'update',
        title: 'Audit Merge',
        status: 'done',
      },
    ]);
  });

  it('accepts accidental @ end markers', () => {
    const extracted = extractMissionPhaseUpdates(`Gate closed.

/mission-phase
action: update
name: Memo-first Live Verification
status: done
note: Evidence recorded.
@end-mission-phase`);

    expect(extracted.visibleText).toBe('Gate closed.');
    expect(extracted.updates).toMatchObject([
      {
        action: 'update',
        title: 'Memo-first Live Verification',
        status: 'done',
      },
    ]);
  });

  it('extracts phase blocks wrapped in html comment syntax', () => {
    const extracted = extractMissionPhaseUpdates(`Gate closed.

<!-- /mission-phase
action: update
name: M0 sequencing
status: done
/end-mission-phase -->`);

    expect(extracted.visibleText).toBe('Gate closed.');
    expect(extracted.updates).toMatchObject([
      {
        action: 'update',
        title: 'M0 sequencing',
        status: 'done',
      },
    ]);
  });
});
