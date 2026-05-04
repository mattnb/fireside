import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { addMessage } from '../../src/repos/messages.js';
import { createAgentRun } from '../../src/repos/agent-runs.js';
import {
  getAgentTurnOutcome,
  listAgentTurnOutcomesForRoom,
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
      missionUpdates: 2,
      summary: 'updated outcome',
    });
    db.close();
  });
});
