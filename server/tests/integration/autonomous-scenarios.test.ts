import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { Broker } from '../../src/broker.js';
import { createRoom } from '../../src/repos/rooms.js';
import { listMessages } from '../../src/repos/messages.js';
import { createTaskChecklistItem, listTaskChecklistItems } from '../../src/repos/task-checklist.js';
import { listAgentRuns } from '../../src/repos/agent-runs.js';
import { listRoutingDecisionsForRoom } from '../../src/repos/routing-decisions.js';
import { listAgentTurnOutcomesForRoom } from '../../src/repos/turn-outcomes.js';
import type { AgentId, AgentReply, AgentSpec } from '../../src/agents/types.js';

function fakeSpec(id: AgentId): AgentSpec {
  return {
    id,
    displayName: id,
    command: 'fake',
    defaultTimeoutMs: 1000,
    buildArgs: () => [],
    parseOutput: () => ({
      text: '',
      sessionId: `${id}-session`,
      raw: { stdout: '', stderr: '' },
    }),
  };
}

function roomAgentFromPrompt(prompt: string, fallback: AgentId): AgentId {
  return /durable agent id is "([^"]+)"/.exec(prompt)?.[1] ?? fallback;
}

describe('autonomous mission scenarios', () => {
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('nudges ready owned work even when the planner emits no explicit handoff or new checklist update', async () => {
    let checklistItemId = '';
    const runs: Array<{ agentId: AgentId; prompt: string }> = [];
    const broker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt): Promise<AgentReply> => {
        const roomAgentId = roomAgentFromPrompt(prompt, spec.id);
        runs.push({ agentId: roomAgentId, prompt });
        if (roomAgentId === 'jimmy') {
          return {
            text: [
              'The plan is still valid.',
              '',
              '/mission-receipt',
              'status: no_update',
              'summary: Planner confirmed the existing assigned lane remains ready.',
              '/end-mission-receipt',
            ].join('\n'),
            sessionId: 'jimmy-session',
            raw: { stdout: '', stderr: '' },
          };
        }
        return {
          text: [
            'Assigned lane complete.',
            '',
            '/mission-task',
            'action: update',
            `id: ${checklistItemId}`,
            'status: done',
            'note: Completed after liveness nudge.',
            '/end-mission-task',
          ].join('\n'),
          sessionId: 'codex-session',
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude'),
          codex: fakeSpec('codex'),
          gemini: fakeSpec('gemini'),
          echo: fakeSpec('echo'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, {
      name: 'liveness-room',
      agentProfiles: [
        {
          id: 'jimmy',
          providerId: 'claude',
          displayName: 'Jimmy',
          personaId: 'project-manager',
          personaName: 'Project Manager',
          personaSummary: '',
        },
        {
          id: 'codex',
          providerId: 'codex',
          displayName: 'Codex',
          personaId: 'generalist',
          personaName: 'Generalist',
          personaSummary: '',
        },
      ],
    });
    const task = broker.createTask(room.id, { title: 'Existing work mission' })!;
    const item = createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Execute existing lane',
      ownerAgentId: 'codex',
      status: 'open',
    });
    checklistItemId = item.id;

    await broker.postHumanMessage(room.id, 'human', '@jimmy continue coordination');

    expect(runs.map((run) => run.agentId)).toEqual(['jimmy', 'codex']);
    expect(runs[1]!.prompt).toContain('Assigned item: - open: Execute existing lane');
    expect(listTaskChecklistItems(db, task.id)[0]).toMatchObject({
      status: 'done',
      updatedBy: 'codex',
    });
    expect(listMessages(db, room.id).map((message) => `${message.authorId}:${message.text}`)).toEqual([
      'human:@jimmy continue coordination',
      'jimmy:The plan is still valid.',
      'codex:Assigned lane complete.',
    ]);

    const outcomes = listAgentTurnOutcomesForRoom(db, room.id);
    const jimmyOutcome = outcomes.find((outcome) => outcome.agentId === 'jimmy');
    expect(jimmyOutcome).toMatchObject({
      progressed: true,
      nextAgents: ['codex'],
    });
    expect(jimmyOutcome?.workDispatches[0]).toMatchObject({
      agentId: 'codex',
      itemId: item.id,
    });
    expect(
      listRoutingDecisionsForRoom(db, room.id).some(
        (decision) => decision.action === 'liveness:dispatch-ready-work',
      ),
    ).toBe(true);
    expect(listAgentRuns(db, room.id).map((run) => run.agentId)).toEqual(['codex', 'jimmy']);
  });
});
