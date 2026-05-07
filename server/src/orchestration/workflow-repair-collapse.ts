// server/src/orchestration/workflow-repair-collapse.ts
//
// Collapse workflow-repair system messages in transcript context.
//
// A workflow-repair trigger is a verbose system payload (~500-1200 chars)
// that the broker injects when the agent's prior turn lacked a Mission Control
// receipt. Once the agent's repair reply has filed the missing receipt, the
// trigger has done its job and re-rendering the full text on every subsequent
// prompt is pure waste — the agent already acted on it. This helper classifies
// repair triggers via the agent_runs → agent_turn_outcomes join (no text
// matching in the formatter) and produces one-line replacement text for any
// repair message that should be collapsed.
//
// Retention rule:
//   - The most recent unsatisfied repair, if one exists, is preserved verbatim.
//   - All older satisfied repairs collapse.
//   - Older unsatisfied repairs collapse too (only the most recent unresolved
//     repair stays full — the agent only needs to react to the latest one).

import type { Database } from 'better-sqlite3';
import type { Message } from '../repos/messages.js';

export interface WorkflowRepairCollapseOptions {
  /** Skip classification for this message id even if it matches. Used to keep
   *  the current turn's trigger verbatim when it happens to be a repair. */
  excludeMessageId?: string | null | undefined;
}

export interface WorkflowRepairCollapseResult {
  /** messageId → one-line replacement text, for every message that should collapse. */
  collapsedText: Map<string, string>;
  /** All message ids classified as workflow-repair triggers, in chronological order. */
  classifiedIds: string[];
}

interface RepairOutcomeRow {
  trigger_message_id: string;
  mission_receipts: number;
  status: string;
  progressed: number;
  reply_message_id: string | null;
  started_at: number;
}

export function classifyWorkflowRepairCollapse(
  db: Database,
  messages: Message[],
  options: WorkflowRepairCollapseOptions = {},
): WorkflowRepairCollapseResult {
  const collapsedText = new Map<string, string>();
  const classifiedIds: string[] = [];
  const excludeId = options.excludeMessageId ?? null;

  const candidateIds: string[] = [];
  for (const m of messages) {
    if (m.authorKind === 'system') candidateIds.push(m.id);
  }
  if (candidateIds.length === 0) {
    return { collapsedText, classifiedIds };
  }

  const placeholders = candidateIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT r.trigger_message_id, o.mission_receipts, o.status, o.progressed,
              r.reply_message_id, r.started_at
         FROM agent_runs r
         JOIN agent_turn_outcomes o ON o.run_id = r.id
        WHERE r.trigger_message_id IN (${placeholders})
          AND o.run_kind = 'workflow.repair'`,
    )
    .all(...candidateIds) as RepairOutcomeRow[];

  // Multiple agent_runs can share a trigger_message_id if a turn was retried.
  // Treat the trigger as satisfied if any associated repair run satisfied it,
  // and remember the latest run for the reply pointer.
  const byTrigger = new Map<
    string,
    { satisfied: boolean; replyMessageId: string | null; latestStartedAt: number }
  >();
  for (const row of rows) {
    const existing = byTrigger.get(row.trigger_message_id);
    const rowSatisfied =
      row.mission_receipts > 0 || row.status === 'completed' || row.progressed === 1;
    if (!existing) {
      byTrigger.set(row.trigger_message_id, {
        satisfied: rowSatisfied,
        replyMessageId: row.reply_message_id,
        latestStartedAt: row.started_at,
      });
      continue;
    }
    existing.satisfied = existing.satisfied || rowSatisfied;
    if (row.started_at >= existing.latestStartedAt) {
      existing.latestStartedAt = row.started_at;
      existing.replyMessageId = row.reply_message_id;
    }
  }

  interface RepairRecord {
    message: Message;
    satisfied: boolean;
    replyMessageId: string | null;
  }
  const repairs: RepairRecord[] = [];
  for (const m of messages) {
    if (excludeId && m.id === excludeId) continue;
    const outcome = byTrigger.get(m.id);
    if (!outcome) continue;
    classifiedIds.push(m.id);
    repairs.push({
      message: m,
      satisfied: outcome.satisfied,
      replyMessageId: outcome.replyMessageId,
    });
  }
  if (repairs.length === 0) {
    return { collapsedText, classifiedIds };
  }

  let preserveIndex = -1;
  for (let i = repairs.length - 1; i >= 0; i--) {
    if (!repairs[i]!.satisfied) {
      preserveIndex = i;
      break;
    }
  }

  for (let i = 0; i < repairs.length; i++) {
    if (i === preserveIndex) continue;
    const r = repairs[i]!;
    collapsedText.set(r.message.id, formatCollapsedRepair(r.message, r.satisfied, r.replyMessageId));
  }

  return { collapsedText, classifiedIds };
}

function formatCollapsedRepair(
  message: Message,
  satisfied: boolean,
  replyMessageId: string | null,
): string {
  const ts = new Date(message.createdAt).toISOString();
  const status = satisfied ? 'satisfied' : 'unresolved';
  const replyRef = replyMessageId ? `, reply=${replyMessageId}` : '';
  return `(workflow-repair @ ${ts} [trigger=${message.id}, status=${status}${replyRef}] body collapsed; full text in DB.)`;
}
