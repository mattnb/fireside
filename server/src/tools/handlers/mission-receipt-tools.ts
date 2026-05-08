import { createAgentRunAction } from '../../repos/run-actions.js';
import { getActiveTask, getTask } from '../../repos/tasks.js';
import {
  applySingleReceipt,
  recordMissionReceipts,
} from '../../mission-state/mission-receipt-applicator.js';
import type { ParsedMissionReceipt } from '../../mission-receipts.js';
import { defineTool } from '../registry.js';
import {
  missionReceiptSubmitSchema,
  type MissionReceiptSubmitArgs,
} from '../schemas/mission-receipt.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

function toParsedMissionReceipt(args: MissionReceiptSubmitArgs): ParsedMissionReceipt {
  return {
    status: args.status,
    itemRef: args.itemRef ?? '',
    phaseRef: args.phaseRef ?? '',
    planRef: args.planRef ?? '',
    summary: args.summary ?? '',
    evidence: args.evidence ?? '',
    next: args.next ?? '',
  };
}

export function handleMissionReceiptSubmit(
  input: AgentToolHandlerInput<MissionReceiptSubmitArgs>,
): AgentToolResult {
  const mission = input.call.missionId
    ? getTask(input.db, input.call.missionId)
    : getActiveTask(input.db, input.call.roomId);

  const receipt = toParsedMissionReceipt(input.args);
  const runId = input.call.runId;
  const recordRunAction = runId
    ? (action: Parameters<typeof createAgentRunAction>[1]) => {
        createAgentRunAction(input.db, action);
      }
    : () => {};

  if (!mission) {
    // Mirror the legacy applicator's diagnostic so the run-detail surface
    // shows the same "ignored" record. The audit row from executeToolCall
    // already captures the call envelope.
    recordRunAction({
      roomId: input.call.roomId,
      taskId: null,
      runId: runId ?? input.call.id,
      agentId: input.call.agentId,
      kind: 'diagnostic',
      status: 'failed',
      label: 'mission receipt ignored',
      detail: 'no active mission',
    });
    return {
      status: 'rejected',
      summary: 'mission.receipt.submit rejected: no active mission',
      effects: [],
    };
  }

  recordMissionReceipts({
    roomId: input.call.roomId,
    task: mission,
    runId: runId ?? input.call.id,
    agentId: input.call.agentId,
    receipts: [receipt],
    recordRunAction,
  });

  const apply = applySingleReceipt({
    db: input.db,
    roomId: input.call.roomId,
    task: mission,
    runId: runId ?? input.call.id,
    agentId: input.call.agentId,
    receipt,
    recordRunAction,
  });

  const summaryParts = [
    `mission.receipt.submit (${receipt.status})`,
    apply.applied > 0 ? `applied ${apply.applied}` : 'ledger only',
  ];

  return {
    status: 'applied',
    summary: summaryParts.join(': '),
    data: {
      applied: apply.applied,
      progressed: apply.progressed,
      itemTouched: apply.itemTouched,
      phaseTouched: apply.phaseTouched,
      ...(apply.resolvedItemId ? { resolvedItemId: apply.resolvedItemId } : {}),
      receipt,
    },
    effects:
      apply.applied > 0
        ? [
            {
              kind: 'task-updated' as const,
              targetType: 'task',
              targetId: mission.id,
              summary: `Mission receipt (${receipt.status}) reconciled ${apply.applied} change(s)`,
              payload: apply,
            },
          ]
        : [],
  };
}

export const missionReceiptSubmitTool = defineTool<MissionReceiptSubmitArgs>({
  name: 'mission.receipt.submit',
  summary:
    'Submit a mission receipt (completed/blocked/needs_review/continuing/no_update) and apply per-receipt checklist and phase reconciliation.',
  requiredPermissions: ['mission:write'],
  schema: missionReceiptSubmitSchema,
  handler: handleMissionReceiptSubmit,
});

export const missionReceiptTools = [missionReceiptSubmitTool] as const;
