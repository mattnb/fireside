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


  it('does not turn a direct human nudge into same-agent liveness work-lane loops', async () => {
    const runs: Array<{ agentId: AgentId; prompt: string }> = [];
    const broker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt): Promise<AgentReply> => {
        const roomAgentId = roomAgentFromPrompt(prompt, spec.id);
        runs.push({ agentId: roomAgentId, prompt });
        if (prompt.includes('fireside workflow contract repair')) {
          return {
            text: [
              '/mission-receipt',
              'status: continuing',
              'summary: Continuing the assigned work after the direct human nudge.',
              '/end-mission-receipt',
            ].join('\n'),
            sessionId: 'temur-session',
            raw: { stdout: '', stderr: '' },
          };
        }
        return {
          text: 'I am resuming the dashboard rebuild now.',
          sessionId: 'temur-session',
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
      name: 'direct-nudge-room',
      yoloAgents: ['codex-principal-software'],
      agentProfiles: [
        {
          id: 'codex-principal-software',
          providerId: 'codex',
          displayName: 'Temur',
          personaId: 'principal-software-engineer',
          personaName: 'Principal Software Engineer',
          personaSummary: '',
        },
      ],
    });
    const task = broker.createTask(room.id, { title: 'Dashboard mission' })!;
    createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Rebuild dashboard',
      ownerAgentId: 'codex-principal-software',
      status: 'open',
    });

    await broker.postHumanMessage(room.id, 'human', '@temur please resume your task');

    // Reply text is purely conversational and no work lane was assigned by this
    // direct nudge, so the broker auto-synthesizes a /mission-receipt and skips the
    // legacy repair turn — a single agent run is the correct steady state.
    expect(runs.map((run) => run.agentId)).toEqual(['codex-principal-software']);
    expect(runs.some((run) => run.prompt.includes('YOLO work lane'))).toBe(false);
    expect(listTaskChecklistItems(db, task.id)[0]).toMatchObject({
      status: 'open',
      ownerAgentId: 'codex-principal-software',
    });
    expect(
      listMessages(db, room.id)
        .filter((message) => message.authorKind !== 'system')
        .map((message) => `${message.authorId}:${message.text}`),
    ).toEqual([
      'human:@temur please resume your task',
      'codex-principal-software:I am resuming the dashboard rebuild now.',
    ]);

    const decisions = listRoutingDecisionsForRoom(db, room.id);
    expect(
      decisions.some(
        (decision) =>
          decision.action === 'liveness:dispatch-ready-work' &&
          decision.responders.includes('codex-principal-software'),
      ),
    ).toBe(false);
  });


  it('stops a YOLO work-lane pulse when the agent only emits visible status chatter', async () => {
    const runs: Array<{ agentId: AgentId; prompt: string }> = [];
    const broker = new Broker({
      db,
      runAgent: async (spec, prompt): Promise<AgentReply> => {
        const roomAgentId = roomAgentFromPrompt(prompt, spec.id);
        runs.push({ agentId: roomAgentId, prompt });
        if (prompt.includes('fireside workflow contract repair')) {
          return {
            text: [
              '/mission-receipt',
              'status: continuing',
              'summary: No durable checklist progress yet.',
              '/end-mission-receipt',
            ].join('\n'),
            sessionId: 'codex-session',
            raw: { stdout: '', stderr: '' },
          };
        }
        return {
          text: 'I am starting the dashboard rebuild now.',
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
      name: 'work-lane-chatter-room',
      agents: ['codex'],
      yoloAgents: ['codex'],
    });
    const task = broker.createTask(room.id, { title: 'Dashboard mission' })!;
    createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Rebuild dashboard',
      ownerAgentId: 'codex',
      status: 'open',
    });

    await broker.startYoloDiscussion(room.id, 'human');

    expect(
      runs.filter(
        (run) =>
          run.prompt.includes('YOLO work lane') &&
          !run.prompt.includes('fireside workflow contract repair'),
      ),
    ).toHaveLength(1);
    expect(runs.filter((run) => run.prompt.includes('fireside workflow contract repair'))).toHaveLength(
      1,
    );
    expect(listTaskChecklistItems(db, task.id)[0]).toMatchObject({ status: 'open' });
    expect(
      listAgentTurnOutcomesForRoom(db, room.id).some((outcome) => outcome.progressed),
    ).toBe(false);
  });
});
