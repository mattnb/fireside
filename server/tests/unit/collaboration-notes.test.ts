import { describe, expect, it } from 'vitest';
import { extractCollaborationNotes } from '../../src/collaboration-notes.js';

describe('extractCollaborationNotes', () => {
  it('strips hidden ledger blocks from visible chat and parses durable fields', () => {
    const result = extractCollaborationNotes(`I disagree with the proposed route.

/collab-note
kind: challenge
title: The runner is not the only likely failure point
target: current remediation plan
status: open
confidence: medium
evidence: file:server/src/broker.ts:421; test:npm test
body: The broker follow-up path also controls whether approved work actually resumes.
/end-collab-note`);

    expect(result.visibleText).toBe('I disagree with the proposed route.');
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({
      kind: 'challenge',
      status: 'open',
      confidence: 'medium',
      title: 'The runner is not the only likely failure point',
      target: 'current remediation plan',
      body: 'The broker follow-up path also controls whether approved work actually resumes.',
      evidence: ['file:server/src/broker.ts:421', 'test:npm test'],
    });
  });

  it('uses sensible default statuses by kind', () => {
    const result = extractCollaborationNotes(`/collab-note
kind: decision
title: Use a broker-owned action timeline
/end-collab-note`);

    expect(result.visibleText).toBe('');
    expect(result.notes[0]).toMatchObject({
      kind: 'decision',
      status: 'accepted',
      title: 'Use a broker-owned action timeline',
    });
  });

  it('accepts the accidental @end-collab-note terminator and still strips the block', () => {
    const result = extractCollaborationNotes(`Visible handoff.

/collab-note
kind: proposal
title: Keep the hidden ledger hidden
body: The compact prompt must not teach a malformed terminator.
@end-collab-note`);

    expect(result.visibleText).toBe('Visible handoff.');
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({
      kind: 'proposal',
      status: 'open',
      title: 'Keep the hidden ledger hidden',
      body: 'The compact prompt must not teach a malformed terminator.',
    });
  });

  it('parses YAML-style block scalars and list evidence inside hidden comments', () => {
    const result = extractCollaborationNotes(`Visible summary.

<!--
/collab-note
kind: evidence
title: Slate dispatch evidence
target: mission control
status: informational
confidence: high
evidence:
  - run:abc123
  - test:npm test
body: |
  First line of evidence.
  Second line of evidence.
/end-collab-note
-->
`);

    expect(result.visibleText).toBe('Visible summary.');
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({
      kind: 'evidence',
      status: 'informational',
      confidence: 'high',
      title: 'Slate dispatch evidence',
      target: 'mission control',
      body: 'First line of evidence.\nSecond line of evidence.',
      evidence: ['run:abc123', 'test:npm test'],
    });
  });

  it('strips comment-wrapped notes when the opening slash is omitted', () => {
    const result = extractCollaborationNotes(`Visible summary.

<!-- collab-note
kind: proposal
summary: Rename the text-input adapter
rationale: Slash blocks are permanent and should not leak into chat.
next: Land the rename.
/end-collab-note -->`);

    expect(result.visibleText).toBe('Visible summary.');
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({
      kind: 'proposal',
      status: 'open',
      title: 'Rename the text-input adapter',
      body: 'Rename the text-input adapter\nSlash blocks are permanent and should not leak into chat.',
    });
  });
});
