// server/tests/unit/lane-block-reason.test.ts

import { describe, it, expect } from 'vitest';
import { laneBlockReasonForProposalStatus } from '../../src/orchestration/work-lane-planner.js';
import type { ProposalStatus } from '../../src/repos/tasks.js';

describe('laneBlockReasonForProposalStatus', () => {
  const cases: Array<[ProposalStatus, ReturnType<typeof laneBlockReasonForProposalStatus>]> = [
    ['draft', 'awaiting-clarification'],
    ['elaborating', 'awaiting-clarification'],
    ['proposed', 'awaiting-approval'],
    ['approved', null],
    ['executing', null],
    ['verifying', null],
    ['done', 'done'],
    ['rejected', 'rejected'],
  ];

  for (const [status, expected] of cases) {
    it(`maps ${status} → ${expected ?? 'null'}`, () => {
      expect(laneBlockReasonForProposalStatus(status)).toBe(expected);
    });
  }
});
