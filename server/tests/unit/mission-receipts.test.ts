import { describe, expect, it } from 'vitest';
import { extractMissionReceipts } from '../../src/mission-receipts.js';

describe('mission receipts', () => {
  it('extracts receipt blocks from mixed visible text', () => {
    const extracted = extractMissionReceipts(
      [
        'Status is unchanged.',
        '',
        '/mission-receipt',
        'status: done',
        'item: Audit merge',
        'phase: Phase 1',
        'summary: Evidence accepted and the next phase is ready.',
        'evidence: test:npm test',
        'next: claude picks up implementation',
        '/end-mission-receipt',
      ].join('\n'),
    );

    expect(extracted.visibleText).toBe('Status is unchanged.');
    expect(extracted.receipts).toEqual([
      {
        status: 'completed',
        itemRef: 'Audit merge',
        phaseRef: 'Phase 1',
        planRef: '',
        summary: 'Evidence accepted and the next phase is ready.',
        evidence: 'test:npm test',
        next: 'claude picks up implementation',
      },
    ]);
  });

  it('accepts review and no-update aliases', () => {
    const extracted = extractMissionReceipts(
      [
        '/mission-receipt',
        'status: needs review',
        'summary: Waiting on a council decision.',
        '/end-mission-receipt',
        '',
        '/mission-receipt',
        'status: none',
        'summary: Other agent already covered this turn.',
        '/end-mission-receipt',
      ].join('\n'),
    );

    expect(extracted.visibleText).toBe('');
    expect(extracted.receipts.map((receipt) => receipt.status)).toEqual([
      'needs_review',
      'no_update',
    ]);
  });

  it('accepts accidental @ end markers', () => {
    const extracted = extractMissionReceipts(
      [
        'Receipt only after a visible line.',
        '',
        '/mission-receipt',
        'status: done',
        'summary: Mission state is reconciled.',
        '@end-mission-receipt',
      ].join('\n'),
    );

    expect(extracted.visibleText).toBe('Receipt only after a visible line.');
    expect(extracted.receipts).toMatchObject([
      {
        status: 'completed',
        summary: 'Mission state is reconciled.',
      },
    ]);
  });

  it('extracts receipt blocks wrapped in html comment syntax', () => {
    const extracted = extractMissionReceipts(
      [
        'No visible mission update.',
        '',
        '<!-- /mission-receipt',
        'status: continuing',
        'summary: Other agents are still active.',
        '/end-mission-receipt -->',
      ].join('\n'),
    );

    expect(extracted.visibleText).toBe('No visible mission update.');
    expect(extracted.receipts).toMatchObject([
      {
        status: 'continuing',
        summary: 'Other agents are still active.',
      },
    ]);
  });
});
