import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import {
  buildLeadRehydrationCheckpoint,
  renderLeadRehydrationBlock,
} from '../../src/orchestration/lead-rehydration.js';
import { addMessage } from '../../src/repos/messages.js';
import { createAgentRun } from '../../src/repos/agent-runs.js';
import { createCollaborationItem } from '../../src/repos/collaboration.js';
import { createTask } from '../../src/repos/tasks.js';
import { createTaskPhase } from '../../src/repos/task-phases.js';
import { createTaskPlan } from '../../src/repos/task-plans.js';
import { createTaskChecklistItem, updateTaskChecklistItem } from '../../src/repos/task-checklist.js';
import { recordAgentTurnOutcome } from '../../src/repos/turn-outcomes.js';

function seedRoom(db: ReturnType<typeof openDatabase>): string {
  db.prepare(
    `INSERT INTO rooms (id, name, created_at, agents_json) VALUES ('room-1', 'r', 1, '["lead", "worker-a"]')`,
  ).run();
  return 'room-1';
}

describe('lead rehydration checkpoint', () => {
  it('builds from canonical mission state without inventing summaries', () => {
    const db = openDatabase(':memory:');
    const roomId = seedRoom(db);
    const task = createTask(db, { roomId, title: 'Implement savings plan' });
    createTaskPhase(db, { taskId: task.id, title: 'Reset trigger', status: 'active' });
    const plan = createTaskPlan(db, {
      taskId: task.id,
      title: 'Locked plan',
      body: 'Step 1: deterministic lead reset.\nStep 2: bounded rehydration.\nStep 3: run-kind accounting.',
      status: 'active',
    });
    const open = createTaskChecklistItem(db, {
      taskId: task.id,
      planId: plan.id,
      title: 'Wire reset scheduler into broker',
      ownerAgentId: 'lead',
    });
    const blocked = createTaskChecklistItem(db, {
      taskId: task.id,
      planId: plan.id,
      title: 'Stub out compaction backstop',
      ownerAgentId: 'lead',
      status: 'blocked',
      blockedReason: 'awaiting Codex baseline',
    });
    const done = createTaskChecklistItem(db, {
      taskId: task.id,
      planId: plan.id,
      title: 'Add run_kind column',
      ownerAgentId: 'lead',
    });
    updateTaskChecklistItem(db, done.id, {
      status: 'done',
    });
    createCollaborationItem(db, {
      roomId,
      taskId: task.id,
      agentId: 'lead',
      kind: 'decision',
      status: 'accepted',
      title: 'LEAD_RESET_PERCENT default = 60',
      body: 'Lead reset fires at 60% of compact threshold.',
    });

    const trigger = addMessage(db, {
      roomId,
      authorId: 'human',
      authorKind: 'human',
      text: '@worker-a go',
    });
    const workerRun = createAgentRun(db, {
      roomId,
      taskId: task.id,
      triggerMessageId: trigger.id,
      agentId: 'worker-a',
      permissionMode: 'plan',
      promptChars: 10,
      estimatedPromptTokens: 3,
      liveMessages: 1,
      contextArtifacts: 0,
    });
    recordAgentTurnOutcome(db, {
      roomId,
      taskId: task.id,
      runId: workerRun.id,
      agentId: 'worker-a',
      status: 'completed',
      progressed: true,
      summary: 'wired pending-reset map',
      runKind: 'normal.turn',
    });

    const checkpoint = buildLeadRehydrationCheckpoint(db, roomId, 'lead');

    expect(checkpoint.missionTitle).toBe('Implement savings plan');
    expect(checkpoint.currentPhaseTitle).toBe('Reset trigger');
    expect(checkpoint.planExcerpt).toContain('deterministic lead reset');
    expect(checkpoint.openChecklist.map((entry) => entry.id)).toEqual([open.id]);
    expect(checkpoint.blockers.map((entry) => entry.id)).toEqual([blocked.id]);
    expect(checkpoint.recentlyResolvedChecklist.map((entry) => entry.id)).toEqual([done.id]);
    expect(checkpoint.recentCouncilDecisions[0]?.title).toBe(
      'LEAD_RESET_PERCENT default = 60',
    );
    expect(checkpoint.recentWorkerOutcomes.map((outcome) => outcome.agentId)).toEqual([
      'worker-a',
    ]);
    db.close();
  });

  it('renders a well-formed hidden block with budget enforcement', () => {
    const checkpoint = {
      missionGoal: 'goal',
      missionTitle: 'goal',
      currentPhaseTitle: 'Phase A',
      currentPhaseId: 'p-1',
      planExcerpt: 'X'.repeat(2_000),
      openChecklist: Array.from({ length: 12 }, (_, idx) => ({
        id: `open-${idx}`,
        title: `Open task ${idx} ${'lorem '.repeat(40)}`,
        status: 'open',
        ownerAgentId: 'worker-a',
      })),
      recentlyResolvedChecklist: Array.from({ length: 5 }, (_, idx) => ({
        id: `done-${idx}`,
        title: `Done task ${idx}`,
        status: 'done',
        ownerAgentId: 'worker-a',
      })),
      blockers: [
        {
          id: 'blk-1',
          title: 'Blocked thing',
          status: 'blocked',
          ownerAgentId: 'worker-b',
          blockedReason: 'needs human',
        },
      ],
      recentCouncilDecisions: Array.from({ length: 5 }, (_, idx) => ({
        id: `c-${idx}`,
        kind: 'decision',
        status: 'accepted',
        title: `Decision ${idx}`,
        body: 'lorem '.repeat(20),
        agentId: 'codex',
      })),
      recentWorkerOutcomes: Array.from({ length: 6 }, (_, idx) => ({
        agentId: 'worker-a',
        runId: `run-${idx}`,
        status: 'completed',
        runKind: 'normal.turn',
        summary: 'lorem '.repeat(10),
        at: idx,
      })),
    };

    const block = renderLeadRehydrationBlock(checkpoint);
    expect(block.startsWith('/lead-rehydration')).toBe(true);
    expect(block.endsWith('/end-lead-rehydration')).toBe(true);
    expect(block).toContain('Mission: goal');
    expect(block).toContain('Current phase: Phase A');
    expect(block).toContain('Blockers');
    expect(block).toContain('Open checklist');
    expect(block).toContain('Recent worker outcomes');
    expect(block.length).toBeLessThanOrEqual(16_000);

    // Tighter budget forces truncation while still leaving the block well-formed.
    const tight = renderLeadRehydrationBlock(checkpoint, { budgetChars: 600 });
    expect(tight.length).toBeLessThanOrEqual(600);
    expect(tight.endsWith('/end-lead-rehydration')).toBe(true);
  });
});
