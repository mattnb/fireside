import { describe, expect, it } from 'vitest';
import { extractMissionPlanUpdates } from '../../src/mission-plan-updates.js';

describe('mission plan update extraction', () => {
  it('extracts hidden markdown plan updates without exposing protocol text', () => {
    const extracted = extractMissionPlanUpdates(`We should align first.

/mission-plan
action: publish
title: Agreement for implementation
status: active
body:
## Direction
Build the structured mission-control graph first.

## Assumptions and Evidence
- Validate with broker tests.
/end-mission-plan

Plan recorded.`);

    expect(extracted.visibleText).toContain('We should align first.');
    expect(extracted.visibleText).toContain('Plan recorded.');
    expect(extracted.visibleText).not.toContain('/mission-plan');
    expect(extracted.updates).toEqual([
      {
        action: 'create',
        id: '',
        title: 'Agreement for implementation',
        status: 'active',
        body: [
          '## Direction',
          'Build the structured mission-control graph first.',
          '',
          '## Assumptions and Evidence',
          '- Validate with broker tests.',
        ].join('\n'),
      },
    ]);
  });

  it('allows current active plan revisions without an explicit plan id', () => {
    const extracted = extractMissionPlanUpdates(`/mission-plan
action: update
body:
## Direction
Revise the current plan after review.
/end-mission-plan`);

    expect(extracted.visibleText).toBe('');
    expect(extracted.updates).toMatchObject([
      {
        action: 'update',
        id: '',
        title: '',
        status: 'active',
        body: '## Direction\nRevise the current plan after review.',
      },
    ]);
  });

  it('accepts accidental @ end markers', () => {
    const extracted = extractMissionPlanUpdates(`Visible reply.

/mission-plan
action: update
title: Current plan
status: active
body:
Keep the team moving.
@end-mission-plan`);

    expect(extracted.visibleText).toBe('Visible reply.');
    expect(extracted.updates).toMatchObject([
      {
        action: 'update',
        title: 'Current plan',
        body: 'Keep the team moving.',
      },
    ]);
  });
});
