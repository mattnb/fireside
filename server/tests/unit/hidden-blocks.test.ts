import { describe, expect, it } from 'vitest';
import { normalizeFiresideEnvelopes } from '../../src/hidden-blocks.js';
import { extractMissionTaskUpdates } from '../../src/mission-task-updates.js';
import { extractCollaborationNotes } from '../../src/collaboration-notes.js';
import { extractMissionReceipts } from '../../src/mission-receipts.js';

describe('normalizeFiresideEnvelopes', () => {
  it('rewrites a multiline envelope into the canonical slash-block form', () => {
    const input = [
      'Heads up:',
      '',
      '<!--FIRESIDE:mission-task v=1',
      'action: update',
      'id: abc',
      'status: done',
      'note: Verified.',
      '/end-mission-task-->',
    ].join('\n');

    const { normalizedText, count } = normalizeFiresideEnvelopes(input);
    expect(count).toBe(1);
    expect(normalizedText).toContain('/mission-task\n');
    expect(normalizedText).toContain('action: update');
    expect(normalizedText).toContain('/end-mission-task');
    expect(normalizedText).not.toContain('<!--FIRESIDE:');
    expect(normalizedText).not.toContain('-->');
  });

  it('rewrites an inline (one-line) envelope', () => {
    const input =
      '<!--FIRESIDE:mission-task v=1 action: update, id: abc, status: done /end-mission-task-->';
    const { normalizedText, count } = normalizeFiresideEnvelopes(input);
    expect(count).toBe(1);
    expect(normalizedText).toContain('/mission-task');
    expect(normalizedText).toContain('action: update');
    expect(normalizedText).toContain('/end-mission-task');
  });

  it('uses the start-tag name when the close-marker name is wrong', () => {
    const input = [
      '<!--FIRESIDE:collab-note v=1',
      'kind: decision',
      'summary: ok',
      '/end-mission-receipt-->',
    ].join('\n');

    const { normalizedText, count } = normalizeFiresideEnvelopes(input);
    expect(count).toBe(1);
    expect(normalizedText).toContain('/collab-note');
    expect(normalizedText).toContain('/end-collab-note');
    expect(normalizedText).not.toContain('/end-mission-receipt');
  });

  it('rewrites the envelope without a v=N marker', () => {
    const input = '<!--FIRESIDE:mission-receipt\nstatus: continuing\n/end-mission-receipt-->';
    const { normalizedText, count } = normalizeFiresideEnvelopes(input);
    expect(count).toBe(1);
    expect(normalizedText).toContain('/mission-receipt');
    expect(normalizedText).toContain('status: continuing');
  });

  it('handles multiple envelopes in one message', () => {
    const input = [
      'before',
      '<!--FIRESIDE:mission-task v=1',
      'action: update',
      'id: a',
      'status: done',
      '/end-mission-task-->',
      'middle',
      '<!--FIRESIDE:collab-note v=1',
      'kind: evidence',
      'summary: hello',
      '/end-collab-note-->',
      'after',
    ].join('\n');

    const { normalizedText, count } = normalizeFiresideEnvelopes(input);
    expect(count).toBe(2);
    expect(normalizedText).toContain('/mission-task');
    expect(normalizedText).toContain('/end-mission-task');
    expect(normalizedText).toContain('/collab-note');
    expect(normalizedText).toContain('/end-collab-note');
    expect(normalizedText).not.toContain('<!--FIRESIDE:');
  });

  it('leaves text without envelopes unchanged', () => {
    const input = 'Just prose with /mission-task references in it.';
    const { normalizedText, count } = normalizeFiresideEnvelopes(input);
    expect(count).toBe(0);
    expect(normalizedText).toBe(input);
  });

  it('leaves canonical slash blocks untouched', () => {
    const input = [
      '/mission-task',
      'action: update',
      'id: abc',
      'status: done',
      '/end-mission-task',
    ].join('\n');
    const { normalizedText, count } = normalizeFiresideEnvelopes(input);
    expect(count).toBe(0);
    expect(normalizedText).toBe(input);
  });

  it('leaves an unrelated HTML comment untouched', () => {
    const input = '<!-- just a comment about something else -->';
    const { normalizedText, count } = normalizeFiresideEnvelopes(input);
    expect(count).toBe(0);
    expect(normalizedText).toBe(input);
  });

  it('does not match an envelope without a closing /end-X--> marker', () => {
    const input = '<!--FIRESIDE:mission-task v=1\naction: update\nid: abc\nstatus: open';
    const { normalizedText, count } = normalizeFiresideEnvelopes(input);
    expect(count).toBe(0);
    expect(normalizedText).toBe(input);
  });
});

describe('normalizeFiresideEnvelopes → existing extractors', () => {
  it('feeds a normalized mission-task envelope through extractMissionTaskUpdates with no leak', () => {
    const raw = [
      'before prose',
      '<!--FIRESIDE:mission-task v=1',
      'action: update',
      'id: lane-1',
      'status: done',
      'note: completed lane',
      '/end-mission-task-->',
      'after prose',
    ].join('\n');

    const { normalizedText } = normalizeFiresideEnvelopes(raw);
    const { visibleText, updates } = extractMissionTaskUpdates(normalizedText);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.id).toBe('lane-1');
    expect(updates[0]?.status).toBe('done');
    expect(updates[0]?.note).toContain('completed lane');
    expect(visibleText).toContain('before prose');
    expect(visibleText).toContain('after prose');
    expect(visibleText).not.toContain('<!--FIRESIDE:');
    expect(visibleText).not.toContain('/end-mission-task');
    expect(visibleText).not.toContain('/mission-task');
    expect(visibleText).not.toContain('-->');
  });

  it('feeds a normalized collab-note envelope through extractCollaborationNotes with no leak', () => {
    const raw = [
      'context line',
      '<!--FIRESIDE:collab-note v=1',
      'kind: decision',
      'summary: locked the plan',
      'body: details here',
      '/end-collab-note-->',
    ].join('\n');

    const { normalizedText } = normalizeFiresideEnvelopes(raw);
    const { visibleText, notes } = extractCollaborationNotes(normalizedText);

    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe('decision');
    expect(notes[0]?.title).toBe('locked the plan');
    expect(notes[0]?.body).toContain('details here');
    expect(visibleText).toBe('context line');
  });

  it('feeds a normalized mission-receipt envelope through extractMissionReceipts with no leak', () => {
    const raw = [
      'closing out.',
      '<!--FIRESIDE:mission-receipt v=1',
      'status: completed',
      'summary: lane closed',
      '/end-mission-receipt-->',
    ].join('\n');

    const { normalizedText } = normalizeFiresideEnvelopes(raw);
    const { visibleText, receipts } = extractMissionReceipts(normalizedText);

    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.status).toBe('completed');
    expect(receipts[0]?.summary).toBe('lane closed');
    expect(visibleText).toBe('closing out.');
  });
});
