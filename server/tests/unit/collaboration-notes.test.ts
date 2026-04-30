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
});
