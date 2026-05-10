// server/src/mission-state/mission-verify-applicator.ts
//
// Applies a parsed verify record (doer or verifier side) to an acceptance
// criterion. Wraps recordDoerCheck/recordVerifierCheck (which handle the
// doer ≠ verifier invariant for the verifier side) and tail-calls
// maybeAdvanceProposalStatus so verifying → done flips automatically when
// every AC has both sides pass.

import type { Database } from 'better-sqlite3';

import {
  getAcceptanceCriterion,
  recordDoerCheck,
  recordVerifierCheck,
  type AcceptanceCheckStatus,
} from '../repos/acceptance-criteria.js';
import { maybeAdvanceProposalStatus } from '../repos/tasks.js';

export type VerifySide = 'doer' | 'verifier';

export interface ApplyMissionVerifyInput {
  db: Database;
  acId: string;
  side: VerifySide;
  status: AcceptanceCheckStatus;
  evidence: string;
  byAgentId: string;
}

export interface ApplyMissionVerifyResult {
  applied: boolean;
  rejected: boolean;
  reason?: string;
  taskId?: string;
}

export function applyMissionVerify(input: ApplyMissionVerifyInput): ApplyMissionVerifyResult {
  const ac = getAcceptanceCriterion(input.db, input.acId);
  if (!ac) {
    return { applied: false, rejected: true, reason: `unknown ac: ${input.acId}` };
  }

  const checkInput = {
    status: input.status,
    evidence: input.evidence,
    byAgentId: input.byAgentId,
  };

  try {
    if (input.side === 'doer') {
      recordDoerCheck(input.db, input.acId, checkInput);
    } else {
      recordVerifierCheck(input.db, input.acId, checkInput);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'verify rejected';
    return { applied: false, rejected: true, reason, taskId: ac.taskId };
  }

  maybeAdvanceProposalStatus(input.db, ac.taskId);
  return { applied: true, rejected: false, taskId: ac.taskId };
}
