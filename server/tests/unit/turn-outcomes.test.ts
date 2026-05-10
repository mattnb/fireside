import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { addMessage } from '../../src/repos/messages.js';
import { createAgentRun } from '../../src/repos/agent-runs.js';
import { createTask } from '../../src/repos/tasks.js';
import { createTaskPhase } from '../../src/repos/task-phases.js';
import {
  getAgentTurnOutcome,
  listAgentTurnOutcomesForRoom,
  listNoProgressTurnStreakAgents,
  recordAgentTurnOutcome,
} from '../../src/repos/turn-outcomes.js';

describe('turn outcomes repository', () => {
  it('records one durable outcome per run and upserts by run id', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO rooms (id, name, created_at, agents_json) VALUES ('room-1', 'r', 1, '[]')`,
    ).run();
    const trigger = addMessage(db, {
      roomId: 'room-1',
      authorId: 'human',
      authorKind: 'human',
      text: '@codex go',
    });
    const run = createAgentRun(db, {
      roomId: 'room-1',
      triggerMessageId: trigger.id,
      agentId: 'codex',
      permissionMode: 'plan',
      promptChars: 10,
      estimatedPromptTokens: 3,
      liveMessages: 1,
      contextArtifacts: 0,
    });

    recordAgentTurnOutcome(db, {
      roomId: 'room-1',
      runId: run.id,
      agentId: 'codex',
      status: 'completed',
      progressed: true,
      missionUpdates: 1,
      workDispatches: [
        {
          agentId: 'claude',
          item: {
            id: 'item-1',
            taskId: 'task-1',
            planId: null,
            phaseId: null,
            title: 'Review work',
            detail: '',
            status: 'open',
            dependencyIds: [],
            expectedTouches: [],
            parallelism: 'parallel-safe',
            conflictGroup: '',
            workRole: '',
            ownerAgentId: 'claude',
            statusNote: '',
            blockedReason: '',
            councilRequired: false,
            updatedBy: '',
            completedAt: null,
            sortOrder: 1,
            acceptanceRef: null,
            createdAt: 1,
            updatedAt: 1,
          },
          reason: 'assigned open checklist item',
        },
      ],
      summary: 'visible message emitted',
    });
    recordAgentTurnOutcome(db, {
      roomId: 'room-1',
      runId: run.id,
      agentId: 'codex',
      status: 'completed',
      progressed: true,
      missionUpdates: 2,
      summary: 'updated outcome',
    });

    expect(listAgentTurnOutcomesForRoom(db, 'room-1')).toHaveLength(1);
    expect(getAgentTurnOutcome(db, run.id)).toMatchObject({
      runId: run.id,
      phaseId: null,
      missionUpdates: 2,
      summary: 'updated outcome',
    });
    db.close();
  });

  it('identifies agents with two consecutive no-visible/no-progress turns in a phase', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO rooms (id, name, created_at, agents_json) VALUES ('room-1', 'r', 1, '[]')`,
    ).run();
    const task = createTask(db, { roomId: 'room-1', title: 'Mission' });
    const phase = createTaskPhase(db, {
      taskId: task.id,
      title: 'Phase',
      status: 'active',
    });
    const trigger = addMessage(db, {
      roomId: 'room-1',
      authorId: 'human',
      authorKind: 'human',
      text: '@codex go',
    });
    const run = (agentId: string, promptChars: number) =>
      createAgentRun(db, {
        roomId: 'room-1',
        taskId: task.id,
        triggerMessageId: trigger.id,
        agentId,
        permissionMode: 'plan',
        promptChars,
        estimatedPromptTokens: promptChars,
        liveMessages: 1,
        contextArtifacts: 0,
      });

    for (const [index, created] of [run('codex', 1), run('codex', 2), run('claude', 3)].entries()) {
      recordAgentTurnOutcome(db, {
        roomId: 'room-1',
        taskId: task.id,
        phaseId: phase.id,
        runId: created.id,
        agentId: created.agentId,
        status: 'empty',
        progressed: false,
      });
      db.prepare(`UPDATE agent_turn_outcomes SET created_at = ? WHERE run_id = ?`).run(
        10 + index,
        created.id,
      );
    }
    const productiveClaudeRun = run('claude', 4);
    recordAgentTurnOutcome(db, {
      roomId: 'room-1',
      taskId: task.id,
      phaseId: phase.id,
      runId: productiveClaudeRun.id,
      agentId: 'claude',
      status: 'completed',
      progressed: true,
      visibleMessageEmitted: true,
    });
    db.prepare(`UPDATE agent_turn_outcomes SET created_at = ? WHERE run_id = ?`).run(
      20,
      productiveClaudeRun.id,
    );

    expect(
      listNoProgressTurnStreakAgents(db, {
        roomId: 'room-1',
        taskId: task.id,
        phaseId: phase.id,
        agentIds: ['codex', 'claude'],
      }),
    ).toEqual(['codex']);
    db.close();
  });

  it('persists run_kind classifier when supplied and defaults to null when absent', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO rooms (id, name, created_at, agents_json) VALUES ('room-1', 'r', 1, '[]')`,
    ).run();
    const trigger = addMessage(db, {
      roomId: 'room-1',
      authorId: 'human',
      authorKind: 'human',
      text: '@codex go',
    });
    const make = (agentId: string) =>
      createAgentRun(db, {
        roomId: 'room-1',
        triggerMessageId: trigger.id,
        agentId,
        permissionMode: 'plan',
        promptChars: 10,
        estimatedPromptTokens: 3,
        liveMessages: 1,
        contextArtifacts: 0,
      });

    const normalRun = make('codex');
    const compactRun = make('codex');
    const repairRun = make('codex');
    const resetRun = make('claude');
    const unclassifiedRun = make('codex');

    recordAgentTurnOutcome(db, {
      roomId: 'room-1',
      runId: normalRun.id,
      agentId: 'codex',
      status: 'completed',
      runKind: 'normal.turn',
    });
    recordAgentTurnOutcome(db, {
      roomId: 'room-1',
      runId: compactRun.id,
      agentId: 'codex',
      status: 'completed',
      runKind: 'maintenance.compaction',
    });
    recordAgentTurnOutcome(db, {
      roomId: 'room-1',
      runId: repairRun.id,
      agentId: 'codex',
      status: 'completed',
      runKind: 'workflow.repair',
    });
    recordAgentTurnOutcome(db, {
      roomId: 'room-1',
      runId: resetRun.id,
      agentId: 'claude',
      status: 'completed',
      runKind: 'post-reset.first-turn',
    });
    recordAgentTurnOutcome(db, {
      roomId: 'room-1',
      runId: unclassifiedRun.id,
      agentId: 'codex',
      status: 'completed',
    });

    expect(getAgentTurnOutcome(db, normalRun.id)?.runKind).toBe('normal.turn');
    expect(getAgentTurnOutcome(db, compactRun.id)?.runKind).toBe('maintenance.compaction');
    expect(getAgentTurnOutcome(db, repairRun.id)?.runKind).toBe('workflow.repair');
    expect(getAgentTurnOutcome(db, resetRun.id)?.runKind).toBe('post-reset.first-turn');
    expect(getAgentTurnOutcome(db, unclassifiedRun.id)?.runKind).toBeNull();
    db.close();
  });
});
