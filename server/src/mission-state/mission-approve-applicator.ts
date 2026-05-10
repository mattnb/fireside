// server/src/mission-state/mission-approve-applicator.ts
//
// Applies a parsed approve / reject / request-changes action to a task.
// Authorization: byAgentId must be the literal 'human' or appear in
// room.approverAgentIds. State transitions go through setProposalStatus
// which throws on illegal edges; we translate the throw into a rejected
// outcome with the underlying reason.

import type { Database } from 'better-sqlite3';

import { getRoom } from '../repos/rooms.js';
import { getTask, setProposalStatus, type ProposalStatus } from '../repos/tasks.js';

export type ApproveAction = 'approve' | 'reject' | 'request-changes';

export interface ApplyMissionApproveInput {
  db: Database;
  taskId: string;
  action: ApproveAction;
  reason?: string;
  byAgentId: string;
}

export interface ApplyMissionApproveResult {
  applied: boolean;
  rejected: boolean;
  reason?: string;
  proposalStatus?: ProposalStatus;
}

const NEXT_BY_ACTION: Record<ApproveAction, ProposalStatus> = {
  approve: 'approved',
  reject: 'rejected',
  'request-changes': 'elaborating',
};

export function applyMissionApprove(input: ApplyMissionApproveInput): ApplyMissionApproveResult {
  const task = getTask(input.db, input.taskId);
  if (!task) {
    return { applied: false, rejected: true, reason: `unknown task: ${input.taskId}` };
  }

  if (
    (input.action === 'reject' || input.action === 'request-changes') &&
    !input.reason?.trim()
  ) {
    return {
      applied: false,
      rejected: true,
      reason: `reason is required for action: ${input.action}`,
    };
  }

  const room = getRoom(input.db, task.roomId);
  if (!room) {
    return { applied: false, rejected: true, reason: `unknown room: ${task.roomId}` };
  }

  const isHuman = input.byAgentId === 'human';
  const isPreAuthorised = room.approverAgentIds.includes(input.byAgentId);
  if (!isHuman && !isPreAuthorised) {
    return {
      applied: false,
      rejected: true,
      reason: `agent ${input.byAgentId} is not authorised to ${input.action} (must be human or in room.approverAgentIds)`,
    };
  }

  const next = NEXT_BY_ACTION[input.action];
  try {
    const updated = setProposalStatus(input.db, input.taskId, next, input.byAgentId);
    if (!updated) {
      return { applied: false, rejected: true, reason: 'task vanished mid-update' };
    }
    return { applied: true, rejected: false, proposalStatus: updated.proposalStatus };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'approve rejected';
    return { applied: false, rejected: true, reason };
  }
}
