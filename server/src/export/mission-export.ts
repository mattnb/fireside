// server/src/export/mission-export.ts
//
// Build a self-contained Markdown document for a single mission/task. The
// output is suitable for handing to a reviewer, archiving, or piping
// through pandoc to produce PDF/HTML/Word — all the content is inline; no
// follow-up file lookups are needed.
//
// Sections:
//   1. Title + metadata (status, gate state, ids, timestamps)
//   2. Goal and acceptance criteria (with verifier evidence per AC)
//   3. Clarifying questions and answers
//   4. Plans
//   5. Phases
//   6. Checklist (grouped by phase, with per-item status / owner / notes)
//   7. Recent activity (top N audit events)

import type { Database } from 'better-sqlite3';
import { getRoom } from '../repos/rooms.js';
import { getTask } from '../repos/tasks.js';
import { listAcceptanceCriteria } from '../repos/acceptance-criteria.js';
import { listClarifyingQuestions } from '../repos/clarifying-questions.js';
import { listTaskPlans } from '../repos/task-plans.js';
import { listTaskPhases } from '../repos/task-phases.js';
import {
  listTaskChecklistItems,
  listTaskChecklistNotes,
} from '../repos/task-checklist.js';
import { buildAuditStream } from '../activity-stream/audit-stream.js';

function isoDate(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  return new Date(timestamp).toISOString();
}

function escapeMarkdown(text: string): string {
  // Conservative: escape characters that could otherwise be interpreted as
  // markdown control. Inline code / bold / etc. are caller-controlled.
  return text.replace(/([\\`*_{}\[\]<>])/g, '\\$1');
}

function block(label: string, value: string): string {
  if (!value) return '';
  return `**${label}:** ${value}\n`;
}

function safeHeading(level: number, text: string): string {
  const hashes = '#'.repeat(Math.min(6, Math.max(1, level)));
  return `${hashes} ${text}`;
}

export interface MissionExportOptions {
  /** Cap on the number of audit events to include. Defaults to 25. */
  activityLimit?: number;
}

export interface MissionExportResult {
  filename: string;
  markdown: string;
}

export function exportMissionMarkdown(
  db: Database,
  taskId: string,
  options: MissionExportOptions = {},
): MissionExportResult | null {
  const task = getTask(db, taskId);
  if (!task) return null;
  const room = getRoom(db, task.roomId);
  const activityLimit = options.activityLimit ?? 25;

  const acs = listAcceptanceCriteria(db, taskId);
  const questions = listClarifyingQuestions(db, taskId);
  const plans = listTaskPlans(db, taskId);
  const phases = listTaskPhases(db, taskId);
  const checklist = listTaskChecklistItems(db, taskId);
  const allNotes = listTaskChecklistNotes(db, taskId);
  const notesByItem = new Map<string, typeof allNotes>();
  for (const note of allNotes) {
    const list = notesByItem.get(note.itemId) ?? [];
    list.push(note);
    notesByItem.set(note.itemId, list);
  }

  const lines: string[] = [];

  // Header.
  lines.push(safeHeading(1, task.title));
  lines.push('');
  lines.push(block('Mission id', `\`${task.id}\``));
  if (room) lines.push(block('Room', `${room.name} (\`${room.id}\`)`));
  lines.push(block('Status', task.status));
  lines.push(block('Proposal status', task.proposalStatus));
  if (task.verifierAgentId) lines.push(block('Verifier', task.verifierAgentId));
  if (task.proposedByAgentId) lines.push(block('Proposed by', task.proposedByAgentId));
  if (task.agents.length > 0) lines.push(block('Assigned agents', task.agents.join(', ')));
  lines.push(block('Capability profile', task.capabilityProfile));
  lines.push(block('Created', isoDate(task.createdAt)));
  lines.push(block('Updated', isoDate(task.updatedAt)));
  lines.push('');

  // Goal.
  if (task.goal) {
    lines.push(safeHeading(2, 'Goal'));
    lines.push('');
    lines.push(task.goal);
    lines.push('');
  }

  if (task.summary) {
    lines.push(safeHeading(2, 'Summary'));
    lines.push('');
    lines.push(task.summary);
    lines.push('');
  }

  // Acceptance criteria with verification evidence.
  if (acs.length > 0) {
    lines.push(safeHeading(2, 'Acceptance criteria'));
    lines.push('');
    lines.push('| # | Title | Status | Doer | Verifier |');
    lines.push('|---|-------|--------|------|----------|');
    acs.forEach((ac, idx) => {
      lines.push(
        `| ${idx + 1} | ${escapeMarkdown(ac.title)} | ${ac.status} | ${ac.doerCheckStatus}${ac.doerCheckByAgentId ? ` (${ac.doerCheckByAgentId})` : ''} | ${ac.verifierCheckStatus}${ac.verifierCheckByAgentId ? ` (${ac.verifierCheckByAgentId})` : ''} |`,
      );
    });
    lines.push('');
    for (const ac of acs) {
      if (!ac.detail && !ac.doerCheckEvidence && !ac.verifierCheckEvidence) continue;
      lines.push(safeHeading(3, ac.title));
      if (ac.detail) {
        lines.push('');
        lines.push(ac.detail);
      }
      if (ac.doerCheckEvidence) {
        lines.push('');
        lines.push(`> **Doer evidence (${ac.doerCheckByAgentId ?? '—'}):** ${ac.doerCheckEvidence}`);
      }
      if (ac.verifierCheckEvidence) {
        lines.push('');
        lines.push(
          `> **Verifier evidence (${ac.verifierCheckByAgentId ?? '—'}):** ${ac.verifierCheckEvidence}`,
        );
      }
      lines.push('');
    }
  } else if (task.acceptanceCriteria) {
    lines.push(safeHeading(2, 'Acceptance criteria'));
    lines.push('');
    lines.push(task.acceptanceCriteria);
    lines.push('');
  }

  // Clarifying questions.
  if (questions.length > 0) {
    lines.push(safeHeading(2, 'Clarifying questions'));
    lines.push('');
    for (const q of questions) {
      lines.push(`- **${escapeMarkdown(q.question)}** _(${q.category})_`);
      if (q.answer) {
        lines.push(`  - **Answered by ${q.answeredBy || '—'}:** ${q.answer}`);
      } else {
        lines.push(`  - _Unanswered._`);
      }
    }
    lines.push('');
  }

  // Plans.
  if (plans.length > 0) {
    lines.push(safeHeading(2, 'Plans'));
    lines.push('');
    for (const plan of plans) {
      lines.push(safeHeading(3, `${plan.title} (${plan.status})`));
      if (plan.body) {
        lines.push('');
        lines.push(plan.body);
      }
      lines.push('');
    }
  }

  // Phases + checklist grouped by phase.
  if (phases.length > 0 || checklist.length > 0) {
    lines.push(safeHeading(2, 'Phases & checklist'));
    lines.push('');
    const itemsByPhase = new Map<string, typeof checklist>();
    const unphased: typeof checklist = [];
    for (const item of checklist) {
      if (item.phaseId) {
        const list = itemsByPhase.get(item.phaseId) ?? [];
        list.push(item);
        itemsByPhase.set(item.phaseId, list);
      } else {
        unphased.push(item);
      }
    }
    for (const phase of phases) {
      const phaseItems = itemsByPhase.get(phase.id) ?? [];
      lines.push(
        safeHeading(3, `${phase.title} — ${phase.status}${phase.gate ? ` · gate: ${phase.gate}` : ''}`),
      );
      if (phase.description) {
        lines.push('');
        lines.push(phase.description);
      }
      lines.push('');
      lines.push(...renderChecklistItems(phaseItems, notesByItem));
      lines.push('');
    }
    if (unphased.length > 0) {
      lines.push(safeHeading(3, 'Unphased items'));
      lines.push('');
      lines.push(...renderChecklistItems(unphased, notesByItem));
      lines.push('');
    }
  }

  // Recent activity.
  const events = buildAuditStream(db, task.roomId, { taskId, limit: activityLimit });
  if (events.length > 0) {
    lines.push(safeHeading(2, 'Recent activity'));
    lines.push('');
    for (const event of events) {
      const ts = isoDate(event.createdAt);
      lines.push(
        `- \`${ts}\` · **${event.kind}** · ${event.agentId || 'system'} · ${event.status}: ${event.summary}`,
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`_Exported from Fireside on ${new Date().toISOString()}._`);

  return {
    filename: `mission-${slugify(task.title)}-${shortId(task.id)}.md`,
    markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
  };
}

function renderChecklistItems(
  items: ReturnType<typeof listTaskChecklistItems>,
  notesByItem: Map<string, ReturnType<typeof listTaskChecklistNotes>>,
): string[] {
  if (items.length === 0) return ['_No checklist items._'];
  const out: string[] = [];
  for (const item of items) {
    const checkbox = item.status === 'done' ? '[x]' : item.status === 'skipped' ? '[~]' : '[ ]';
    const owner = item.ownerAgentId ? ` _(owner: ${item.ownerAgentId})_` : '';
    out.push(`- ${checkbox} **${escapeMarkdown(item.title)}** — ${item.status}${owner}`);
    if (item.detail) out.push(`  - ${item.detail}`);
    if (item.statusNote) out.push(`  - **Note:** ${item.statusNote}`);
    if (item.blockedReason) out.push(`  - **Blocked:** ${item.blockedReason}`);
    const notes = notesByItem.get(item.id) ?? [];
    for (const note of notes) {
      out.push(
        `  - _${note.kind}_ by ${note.authorId} @ ${isoDate(note.createdAt)}: ${note.body}`,
      );
    }
  }
  return out;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'mission';
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
