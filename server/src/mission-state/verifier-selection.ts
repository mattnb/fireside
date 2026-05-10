// server/src/mission-state/verifier-selection.ts
//
// Heuristic that picks a default verifier when a task transitions
// proposed → approved without an explicit assignment. The rule (per
// docs/mission-proposal-verify-gates-2026-05-07.md sub-deliverable 5):
//   1. If task.verifierAgentId is already set, leave it.
//   2. Otherwise pick the first room agent that is neither the lead nor
//      a known doer of any AC.
//   3. If no such candidate exists, return null — the human becomes the
//      default verifier in that case (humans are always permitted on the
//      verifier side regardless of doer identity).

import type { Database } from 'better-sqlite3';

import { listAcceptanceCriteria } from '../repos/acceptance-criteria.js';
import { getRoom } from '../repos/rooms.js';
import { getTask } from '../repos/tasks.js';

export function defaultVerifierForTask(db: Database, taskId: string): string | null {
  const task = getTask(db, taskId);
  if (!task) return null;
  const room = getRoom(db, task.roomId);
  if (!room) return null;
  // Single-agent rooms: humans verify by default (the lone agent is
  // necessarily either the lead or a doer, never an independent reviewer).
  if (room.agents.length <= 1) return null;

  const doerAgents = new Set<string>();
  for (const ac of listAcceptanceCriteria(db, taskId)) {
    if (ac.doerAgentId) doerAgents.add(ac.doerAgentId);
  }

  const candidates = room.agents.filter(
    (agent) => agent !== room.leadAgentId && !doerAgents.has(agent),
  );
  return candidates[0] ?? null;
}
