// server/tests/integration/broker-echo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { openDatabase } from '../../src/db.js';
import { createRoom, getRoom } from '../../src/repos/rooms.js';
import { addMessage, listMessages } from '../../src/repos/messages.js';
import { listAgentJobsForRoom } from '../../src/repos/agent-jobs.js';
import { listPendingDispatchQueueItemsForRoom } from '../../src/repos/dispatch-queue.js';
import { listPermissionRequests } from '../../src/repos/permission-requests.js';
import { createAgentRun, listAgentRuns, updateAgentRun } from '../../src/repos/agent-runs.js';
import { listAgentRunActions, listAgentRunActionsForRoom } from '../../src/repos/run-actions.js';
import { listTaskPhases } from '../../src/repos/task-phases.js';
import { createTaskChecklistItem, listTaskChecklistItems } from '../../src/repos/task-checklist.js';
import { listTaskPlans } from '../../src/repos/task-plans.js';
import { listTasks } from '../../src/repos/tasks.js';
import { getCliSessionId, upsertCliSessionId } from '../../src/repos/sessions.js';
import { listAgentTurnOutcomesForRoom } from '../../src/repos/turn-outcomes.js';
import { listRoutingDecisionsForRoom } from '../../src/repos/routing-decisions.js';
import { Broker } from '../../src/broker.js';
import type { AgentId, AgentReply, AgentSpec } from '../../src/agents/types.js';
import type { PermissionGrant } from '../../src/permissions.js';

function fakeSpec(id: AgentId, replyText: string): AgentSpec {
  return {
    id,
    displayName: id,
    command: 'fake',
    defaultTimeoutMs: 1000,
    buildArgs: () => [],
    parseOutput: () => ({
      text: replyText,
      sessionId: `${id}-sess`,
      raw: { stdout: '', stderr: '' },
    }),
  };
}

describe('Broker', () => {
  let db: ReturnType<typeof openDatabase>;
  let broker: Broker;
  let runs: Array<{
    agentId: AgentId;
    prompt: string;
    sessionId: string | null;
    permission?: PermissionGrant;
  }>;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runs = [];
    broker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId, permission) => {
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text: `${spec.id}-says-hello`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
      maxAgentRepliesPerThread: 1,
    });
  });

  it('routes a human message with @claude mention to claude only', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });
    await broker.postHumanMessage(room.id, 'human', '@claude hey');
    const messages = listMessages(db, room.id);
    expect(messages.map((m) => `${m.authorId}:${m.text}`)).toEqual([
      'human:@claude hey',
      'claude:claude-says-hello',
    ]);
    expect(runs.map((r) => r.agentId)).toEqual(['claude']);
  });

  it('requires a named reference when multiple room participants share one provider', async () => {
    const room = createRoom(db, {
      name: 'g',
      agentProfiles: [
        {
          id: 'claude-ada',
          providerId: 'claude',
          displayName: 'Ada',
          personaId: 'generalist',
          personaName: 'Generalist',
          personaSummary: '',
        },
        {
          id: 'claude-grace',
          providerId: 'claude',
          displayName: 'Grace',
          personaId: 'generalist',
          personaName: 'Generalist',
          personaSummary: '',
        },
      ],
    });

    await broker.postHumanMessage(room.id, 'human', '@claude hey');
    expect(listAgentRuns(db, room.id)).toEqual([]);

    await broker.postHumanMessage(room.id, 'human', '@ada hey');
    expect(listAgentRuns(db, room.id).map((run) => run.agentId)).toEqual(['claude-ada']);
  });

  it('routes an exact room-local handle even when another participant shares the provider', async () => {
    const room = createRoom(db, {
      name: 'g',
      agentProfiles: [
        {
          id: 'claude',
          providerId: 'claude',
          displayName: 'claude',
          personaId: 'generalist',
          personaName: 'Generalist',
          personaSummary: '',
        },
        {
          id: 'codex',
          providerId: 'codex',
          displayName: 'codex',
          personaId: 'generalist',
          personaName: 'Generalist',
          personaSummary: '',
        },
        {
          id: 'claude-reliability',
          providerId: 'claude',
          displayName: 'claude-reliability',
          personaId: 'reliability-engineer',
          personaName: 'Reliability Engineer',
          personaSummary: '',
        },
      ],
    });

    await broker.postHumanMessage(room.id, 'human', '@claude hey');

    expect(runs.map((run) => run.agentId)).toEqual(['claude']);
    expect(listAgentRuns(db, room.id).map((run) => run.agentId)).toEqual(['claude']);
    const [humanMessage] = listMessages(db, room.id);
    expect(humanMessage).toMatchObject({ authorId: 'human', seenBy: ['claude'] });
  });

  it('records read receipts when an agent turn begins, even if the reply is empty', async () => {
    const receiptUpdates: Array<{
      roomId: string;
      messageId: string;
      agentId: AgentId;
      seenBy: AgentId[];
      runId: string;
    }> = [];
    const emptyBroker = new Broker({
      db,
      runAgent: async () => ({
        text: '',
        sessionId: null,
        raw: { stdout: '', stderr: '' },
      }),
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', ''),
        };
        return map[id];
      },
      maxAgentRepliesPerThread: 1,
    });
    emptyBroker.on('messageReadReceiptUpdated', (update) => receiptUpdates.push(update));
    const room = createRoom(db, { name: 'g', agents: ['claude'] });

    await emptyBroker.postHumanMessage(room.id, 'human', '@claude take a look');

    const messages = listMessages(db, room.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ authorId: 'human', seenBy: ['claude'] });
    expect(receiptUpdates).toHaveLength(1);
    expect(receiptUpdates[0]).toMatchObject({
      roomId: room.id,
      messageId: messages[0]!.id,
      agentId: 'claude',
      seenBy: ['claude'],
    });
    expect(receiptUpdates[0]!.runId).toBeTruthy();
  });

  it('lets an engineering manager add a visible temporary agent with a focused assignment', async () => {
    let added = false;
    const rosterBroker = new Broker({
      db,
      runAgent: async (spec) => {
        if (spec.id === 'claude' && !added) {
          added = true;
          return {
            text: [
              'Adding a temporary reviewer now.',
              '',
              '/agent-roster',
              'action: add',
              'id: codex-regression',
              'name: Codex Regression',
              'provider: codex',
              'persona: quality-assurance-engineer',
              'scope: regression review for checklist item A',
              'reason: implementation agents are busy',
              'yolo: true',
              'max_turns: 1',
              'prompt:',
              'Review the regression surface and report evidence.',
              '/end-agent-roster',
            ].join('\n'),
            sessionId: `${spec.id}-sess`,
            raw: { stdout: '', stderr: '' },
          };
        }
        return {
          text: `${spec.id} temp review complete`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
        };
        return map[id];
      },
      maxAgentRepliesPerThread: 1,
    });
    const room = createRoom(db, {
      name: 'temp-roster',
      agentProfiles: [
        {
          id: 'em',
          providerId: 'claude',
          displayName: 'Engineering Manager',
          personaId: 'engineering-manager',
          personaName: 'Engineering Manager',
          personaSummary: '',
        },
      ],
    });

    await rosterBroker.postHumanMessage(room.id, 'human', '@em add a reviewer');

    const updated = getRoom(db, room.id)!;
    expect(updated.agents).toContain('codex-regression');
    expect(updated.yoloAgents).toContain('codex-regression');
    expect(updated.agentProfiles.find((profile) => profile.id === 'codex-regression')).toMatchObject(
      {
        providerId: 'codex',
        personaId: 'quality-assurance-engineer',
        temporary: true,
        spawnedBy: 'em',
        maxTurns: 1,
      },
    );
    const runAgentIds = listAgentRuns(db, room.id, { limit: 10 }).map((run) => run.agentId);
    expect(runAgentIds).toEqual(expect.arrayContaining(['em', 'codex-regression']));
    expect(listMessages(db, room.id).map((message) => message.authorId)).toContain(
      'codex-regression',
    );
  });

  it('enforces the per-lead temporary agent limit without a mission-wide cap', async () => {
    const rosterBroker = new Broker({
      db,
      temporaryAgentLimitPerLead: 1,
      runAgent: async (spec) => {
        if (spec.id !== 'claude') {
          return {
            text: '',
            sessionId: null,
            raw: { stdout: '', stderr: '' },
          };
        }
        return {
          text: [
            '/agent-roster',
            'action: add',
            'id: codex-one',
            'provider: codex',
            'persona: quality-assurance-engineer',
            'max_turns: 1',
            'prompt: first review',
            '/end-agent-roster',
            '',
            '/agent-roster',
            'action: add',
            'id: codex-two',
            'provider: codex',
            'persona: quality-assurance-engineer',
            'max_turns: 1',
            'prompt: second review',
            '/end-agent-roster',
          ].join('\n'),
          sessionId: null,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', ''),
        };
        return map[id];
      },
      maxAgentRepliesPerThread: 1,
    });
    const room = createRoom(db, {
      name: 'temp-limit',
      agentProfiles: [
        {
          id: 'qa-lead',
          providerId: 'claude',
          displayName: 'QA Lead',
          personaId: 'qa-lead',
          personaName: 'QA Lead',
          personaSummary: '',
        },
      ],
    });

    await rosterBroker.postHumanMessage(room.id, 'human', '@qa-lead add reviewers');

    const updated = getRoom(db, room.id)!;
    expect(updated.agents).toContain('codex-one');
    expect(updated.agents).not.toContain('codex-two');
    const qaLeadRun = listAgentRuns(db, room.id, { limit: 10 }).find(
      (run) => run.agentId === 'qa-lead',
    );
    expect(qaLeadRun).toBeTruthy();
    const actions = listAgentRunActions(db, qaLeadRun!.id);
    expect(actions.map((action) => action.label)).toContain('temporary agent limit reached');
  });

  it('records read receipts for prompt history messages that survived the budget', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude'] });

    await broker.postHumanMessage(room.id, 'human', '@claude first');
    await broker.postHumanMessage(room.id, 'human', '@claude second');

    const messages = listMessages(db, room.id);
    const firstHuman = messages.find((message) => message.text === '@claude first');
    const secondHuman = messages.find((message) => message.text === '@claude second');
    const claudeReply = messages.find((message) => message.authorId === 'claude');
    expect(firstHuman?.seenBy).toEqual(['claude']);
    expect(secondHuman?.seenBy).toEqual(['claude']);
    expect(claudeReply?.seenBy).toEqual([]);
  });

  it('without mentions, all agents in the room reply', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });
    await broker.postHumanMessage(room.id, 'human', 'hi everyone');
    const messages = listMessages(db, room.id);
    expect(messages).toHaveLength(3);
    expect(runs.map((r) => r.agentId).sort()).toEqual(['claude', 'codex']);
  });

  it('records provider stream events as live run actions', async () => {
    const streamBroker = new Broker({
      db,
      runAgent: async (spec, _prompt, _sessionId, _permission, _cancelSignal, onStreamEvent) => {
        onStreamEvent?.({
          kind: 'event',
          status: 'running',
          label: `${spec.id} turn started`,
          detail: 'provider emitted a live signal',
        });
        return {
          text: `${spec.id}-done`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
      maxAgentRepliesPerThread: 1,
    });
    const room = createRoom(db, { name: 'g', agents: ['codex'] });
    await streamBroker.postHumanMessage(room.id, 'human', '@codex hi');

    const run = listAgentRuns(db, room.id, { limit: 1 })[0];
    expect(run).toBeDefined();
    const actions = listAgentRunActions(db, run!.id);
    expect(actions.some((action) => action.label === 'codex turn started')).toBe(true);
    expect(actions.find((action) => action.label === 'codex turn started')?.detail).toBe(
      'provider emitted a live signal',
    );
  });

  it('persists a durable agent job for each provider turn', async () => {
    const room = createRoom(db, { name: 'durable-jobs', agents: ['codex'] });

    await broker.postHumanMessage(room.id, 'human', '@codex do the work');

    const [run] = listAgentRuns(db, room.id);
    const [job] = listAgentJobsForRoom(db, room.id);
    expect(run).toBeDefined();
    expect(job).toMatchObject({
      roomId: room.id,
      agentId: 'codex',
      runId: run!.id,
      status: 'completed',
      triggerMessageId: expect.any(String),
    });
    expect(run).toMatchObject({ agentJobId: job!.id });
    expect(JSON.parse(job!.workPacketJson)).toMatchObject({
      permission: { mode: 'plan' },
      promptStats: { estimatedPromptTokens: expect.any(Number) },
    });
  });

  it('suppresses low-signal provider stream events before storing run actions', async () => {
    const streamBroker = new Broker({
      db,
      runAgent: async (spec, _prompt, _sessionId, _permission, _cancelSignal, onStreamEvent) => {
        onStreamEvent?.({
          kind: 'event',
          status: 'running',
          label: 'claude message_start',
        });
        onStreamEvent?.({
          kind: 'event',
          status: 'running',
          label: 'claude content_block_start',
        });
        onStreamEvent?.({
          kind: 'tool',
          status: 'running',
          label: 'claude tool_use',
          detail: 'Edit',
        });
        onStreamEvent?.({
          kind: 'message',
          status: 'completed',
          label: 'claude assistant message ready',
          detail: '{"message":"Thanks for flagging this; I am checking the failure path now."}',
        });
        return {
          text: `${spec.id}-done`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
      maxAgentRepliesPerThread: 1,
    });
    const room = createRoom(db, { name: 'filtered-streams', agents: ['claude'] });

    await streamBroker.postHumanMessage(room.id, 'human', '@claude hi');

    const run = listAgentRuns(db, room.id, { limit: 1 })[0];
    expect(run).toBeDefined();
    const actions = listAgentRunActions(db, run!.id);
    expect(actions.map((action) => action.label)).not.toContain('claude message_start');
    expect(actions.map((action) => action.label)).not.toContain('claude content_block_start');
    expect(actions.map((action) => action.label)).not.toContain('claude tool_use');
    expect(
      actions.find((action) => action.label === 'claude assistant message ready'),
    ).toMatchObject({
      detail: 'Thanks for flagging this; I am checking the failure path now.',
    });
  });

  it('recovers interrupted running agent rows on broker startup', () => {
    const room = createRoom(db, { name: 'interrupted-runs', agents: ['claude'] });
    const run = createAgentRun(db, {
      roomId: room.id,
      agentId: 'claude',
      triggerMessageId: 'stale-trigger',
      permissionMode: 'full-auto',
      promptChars: 100,
      estimatedPromptTokens: 25,
      liveMessages: 1,
      contextArtifacts: 0,
      promptText: 'stale prompt',
      permissionSource: 'yolo',
      permissionTarget: 'unrestricted filesystem',
      permissionReason: 'YOLO profile',
      permissionFilesystemScope: 'unrestricted',
      permissionWeb: true,
    });

    new Broker({
      db,
      runAgent: async () => ({
        text: '',
        sessionId: null,
        raw: { stdout: '', stderr: '' },
      }),
      getSpec: () => fakeSpec('claude', 'claude reply'),
    });

    expect(listAgentRuns(db, room.id)[0]).toMatchObject({
      id: run.id,
      status: 'failed',
      error: 'Interrupted by Fireside server restart before the provider turn completed.',
    });
    expect(listAgentRunActions(db, run.id).map((action) => action.label)).toContain(
      'run interrupted',
    );
  });

  it('single-agent mention remains a single reply', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });
    await broker.postHumanMessage(room.id, 'human', '@claude kick it off');
    expect(runs.map((r) => r.agentId)).toEqual(['claude']);
  });

  it('routes a human bare-name handoff to that agent', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });
    await broker.postHumanMessage(room.id, 'human', 'Codex, can you verify this?');
    expect(runs.map((r) => r.agentId)).toEqual(['codex']);
  });

  it('routes markdown-styled bare-name handoffs', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });
    await broker.postHumanMessage(room.id, 'human', '**Codex:** can you verify this?');
    expect(runs.map((r) => r.agentId)).toEqual(['codex']);
  });

  it('removes a dangling self label from an agent message', async () => {
    const labelBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: 'Finished the work.\n\nClaude:',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });

    await labelBroker.postHumanMessage(room.id, 'human', '@claude do the work');

    expect(runs.map((r) => r.agentId)).toEqual(['claude']);
    expect(listMessages(db, room.id).map((m) => `${m.authorId}:${m.text}`)).toEqual([
      'human:@claude do the work',
      'claude:Finished the work.',
    ]);
  });

  it('continues a directed handoff when an agent names another agent without @', async () => {
    let turn = 0;
    const handoffBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        turn += 1;
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text:
            turn === 1
              ? 'Codex, please verify this before we continue.'
              : 'Verified and ready for the next step.',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
      maxAgentRepliesPerThread: 1,
    });
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });

    await handoffBroker.postHumanMessage(room.id, 'human', '@claude kick it off');

    expect(runs.map((r) => r.agentId)).toEqual(['claude', 'codex']);
    expect(listMessages(db, room.id).map((m) => `${m.authorId}:${m.text}`)).toEqual([
      'human:@claude kick it off',
      'claude:Codex, please verify this before we continue.',
      'codex:Verified and ready for the next step.',
    ]);
  });

  it('continues explicit multi-agent handoffs from an agent message that also carries hidden state updates', async () => {
    const handoffBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId, permission) => {
        const agentId = (prompt.match(/next message to be sent by "([^"]+)"/)?.[1] ??
          spec.id) as AgentId;
        runs.push({
          agentId,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        if (agentId === 'claude-ux-architect') {
          return {
            text: [
              '@nat @temur @jimmy — IA-fidelity review pass is ready.',
              '@nat verify the acceptance criteria before the gate closes.',
              '@temur pick up the dashboard rebuild after Nat signs off.',
              '@jimmy coordinate the phase gate once those checks land.',
              '',
              '/mission-receipt',
              'status: continuing',
              'summary: Review handoff posted to the named owners.',
              '/end-mission-receipt',
            ].join('\n'),
            sessionId: `${spec.id}-sess`,
            raw: { stdout: '', stderr: '' },
          };
        }
        return {
          text: '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, {
      name: 'named-handoff',
      yoloAgents: [
        'claude-ux-architect',
        'claude-qa-lead',
        'codex-principal-software',
        'claude-project-manager',
      ],
      agentProfiles: [
        {
          id: 'claude-ux-architect',
          providerId: 'claude',
          displayName: 'Rob',
          personaId: 'ux-architect',
          personaName: 'UX Architect',
          personaSummary: '',
        },
        {
          id: 'claude-qa-lead',
          providerId: 'claude',
          displayName: 'Nat',
          personaId: 'qa-lead',
          personaName: 'QA Lead',
          personaSummary: '',
        },
        {
          id: 'codex-principal-software',
          providerId: 'codex',
          displayName: 'Temur',
          personaId: 'principal-software-engineer',
          personaName: 'Principal Software Engineer',
          personaSummary: '',
        },
        {
          id: 'claude-project-manager',
          providerId: 'claude',
          displayName: 'Jimmy',
          personaId: 'project-manager',
          personaName: 'Project Manager',
          personaSummary: '',
        },
      ],
    });
    const task = handoffBroker.createTask(room.id, {
      title: 'Named handoff mission',
      capabilityProfile: 'full-auto',
    });
    createTaskChecklistItem(db, {
      taskId: task!.id,
      title: 'Document-viewer rebuild',
      status: 'open',
      ownerAgentId: 'codex-principal-software',
      parallelism: 'parallel-safe',
    });

    await handoffBroker.startYoloDiscussion(
      room.id,
      'human',
      {
        mode: 'full-auto',
        filesystemScope: 'unrestricted',
        web: true,
      },
      '@rob begin the review handoff',
      ['claude-ux-architect'],
    );

    expect(runs[0]!.agentId).toBe('claude-ux-architect');
    expect(runs.map((r) => r.agentId)).toEqual(
      expect.arrayContaining([
        'claude-qa-lead',
        'codex-principal-software',
        'claude-project-manager',
      ]),
    );
    const decisions = listRoutingDecisionsForRoom(db, room.id);
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'agent-message',
          action: 'agent-handoff',
          reason: 'agent-mentioned-room-participant',
          responders: ['claude-qa-lead', 'codex-principal-software', 'claude-project-manager'],
        }),
      ]),
    );
  });

  it('allows bounded group discussion up to five replies per agent by default', async () => {
    const discussionBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: `${spec.id}-round`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });

    await discussionBroker.postHumanMessage(room.id, 'human', 'work together');

    expect(runs).toHaveLength(10);
    expect(runs.filter((r) => r.agentId === 'claude')).toHaveLength(5);
    expect(runs.filter((r) => r.agentId === 'codex')).toHaveLength(5);
    expect(runs[0]!.prompt).toContain('round 1 of 5');
    expect(runs[runs.length - 1]!.prompt).toContain('round 5 of 5');
    expect(runs[runs.length - 1]!.prompt).toContain('final allowed discussion round');

    const messages = listMessages(db, room.id);
    expect(messages).toHaveLength(11);
  });

  it('starts YOLO collaboration with a 100 total agent-message cap', async () => {
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: `${spec.id}-yolo`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'overnight', agents: ['claude', 'codex'] });

    await yoloBroker.startYoloDiscussion(room.id, 'human');

    expect(runs).toHaveLength(100);
    expect(runs[0]!.prompt).toContain('YOLO collaboration budget');
    expect(runs[0]!.prompt).toContain('up to 100 total agent messages');
    expect(runs.filter((r) => r.agentId === 'claude')).toHaveLength(50);
    expect(runs.filter((r) => r.agentId === 'codex')).toHaveLength(50);
    expect(listMessages(db, room.id)).toHaveLength(101);
  });

  it('queues a targeted message while the same room agent has active provider work', async () => {
    let markStarted: () => void = () => {};
    let releaseReply: (reply: AgentReply) => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const reply = new Promise<AgentReply>((resolve) => {
      releaseReply = resolve;
    });
    const guardedBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        markStarted();
        return reply;
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          gemini: fakeSpec('gemini', 'gemini reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'single-flight', agents: ['gemini'] });

    const first = guardedBroker.postHumanMessage(room.id, 'human', '@gemini start');
    await started;
    const second = guardedBroker.postSystemMessage(room.id, '@gemini duplicate nudge');
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(runs).toHaveLength(1);
    expect(listAgentRuns(db, room.id).filter((run) => run.status === 'running')).toHaveLength(1);
    expect(listPendingDispatchQueueItemsForRoom(db, room.id)).toMatchObject([
      {
        targetId: 'gemini',
        kind: 'chat-message',
        status: 'pending',
      },
    ]);

    releaseReply({
      text: 'gemini finished',
      sessionId: 'gemini-sess',
      raw: { stdout: '', stderr: '' },
    });
    await Promise.all([first, second]);

    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toContain('@gemini duplicate nudge');
    expect(listPendingDispatchQueueItemsForRoom(db, room.id)).toEqual([]);
    expect(listAgentRuns(db, room.id).filter((run) => run.status === 'running')).toHaveLength(0);
  });

  it('delivers an agent-to-agent handoff after the target finishes active work', async () => {
    let codexInitialStarted: () => void = () => {};
    let releaseCodexInitial: (reply: AgentReply) => void = () => {};
    const codexStarted = new Promise<void>((resolve) => {
      codexInitialStarted = resolve;
    });
    const codexInitialReply = new Promise<AgentReply>((resolve) => {
      releaseCodexInitial = resolve;
    });
    let codexRuns = 0;
    const handoffBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        if (spec.id === 'codex') {
          codexRuns += 1;
          if (codexRuns === 1) {
            codexInitialStarted();
            return codexInitialReply;
          }
          return {
            text: 'codex acknowledged claude handoff',
            sessionId: 'codex-sess',
            raw: { stdout: '', stderr: '' },
          };
        }
        return {
          text: '@codex please review the Lighthouse finding before the phase closes.',
          sessionId: 'claude-sess',
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
        };
        return map[id];
      },
      maxAgentRepliesPerThread: 1,
    });
    const room = createRoom(db, { name: 'handoffs', agents: ['claude', 'codex'] });

    const first = handoffBroker.postHumanMessage(room.id, 'human', '@codex start long work');
    await codexStarted;
    await handoffBroker.postHumanMessage(room.id, 'human', '@claude tell codex what changed');

    const claudeMessage = listMessages(db, room.id).find(
      (message) => message.authorId === 'claude' && message.text.includes('@codex please review'),
    );
    expect(claudeMessage).toBeTruthy();
    expect(listPendingDispatchQueueItemsForRoom(db, room.id)).toMatchObject([
      {
        sourceMessageId: claudeMessage!.id,
        authorId: 'claude',
        targetId: 'codex',
        kind: 'agent-handoff',
        status: 'pending',
      },
    ]);

    releaseCodexInitial({
      text: 'codex finished initial work',
      sessionId: 'codex-sess',
      raw: { stdout: '', stderr: '' },
    });
    await first;

    expect(runs.map((run) => run.agentId)).toEqual(['codex', 'claude', 'codex']);
    expect(runs[2]!.prompt).toContain('@codex please review the Lighthouse finding');
    expect(listPendingDispatchQueueItemsForRoom(db, room.id)).toEqual([]);
    const decisions = listRoutingDecisionsForRoom(db, room.id, 20);
    expect(
      decisions.some(
        (decision) =>
          decision.action === 'agent-handoff' && decision.messageId === claudeMessage!.id,
      ),
    ).toBe(true);
    expect(
      decisions.some(
        (decision) =>
          decision.action === 'agent-handoff-delivered' &&
          decision.messageId === claudeMessage!.id &&
          decision.responders.includes('codex'),
      ),
    ).toBe(true);
  });

  it('queues a targeted message instead of starting an overlapping YOLO loop', async () => {
    let markStarted: () => void = () => {};
    let releaseReply: (reply: AgentReply) => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const reply = new Promise<AgentReply>((resolve) => {
      releaseReply = resolve;
    });
    const guardedBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        markStarted();
        return reply;
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          gemini: fakeSpec('gemini', 'gemini reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, {
      name: 'single-yolo-loop',
      agents: ['gemini'],
      yoloAgents: ['gemini'],
    });

    const first = guardedBroker.startYoloDiscussion(room.id, 'human');
    await started;
    const second = guardedBroker.postSystemMessage(room.id, '@gemini duplicate yolo nudge');
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(runs).toHaveLength(1);
    expect(listPendingDispatchQueueItemsForRoom(db, room.id)).toMatchObject([
      {
        targetId: 'gemini',
        kind: 'chat-message',
        status: 'pending',
      },
    ]);

    releaseReply({
      text: '',
      sessionId: 'gemini-sess',
      raw: { stdout: '', stderr: '' },
    });
    await Promise.all([first, second]);

    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toContain('@gemini duplicate yolo nudge');
    expect(listPendingDispatchQueueItemsForRoom(db, room.id)).toEqual([]);
  });

  it('applies YOLO permission profiles to agent turns for the run', async () => {
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId, permission) => {
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text: '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'overnight-permissions', agents: ['claude', 'codex'] });
    yoloBroker.createTask(room.id, {
      title: 'Night shift',
      repoPath: 'C:/work/project',
    });

    await yoloBroker.startYoloDiscussion(room.id, 'human', {
      mode: 'edit',
      filesystemScope: 'task',
      web: true,
    });

    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.permission).toMatchObject({
        source: 'yolo',
        mode: 'edit',
        target: 'C:/work/project',
        filesystemScope: 'task',
        web: true,
      });
      expect(run.prompt).toContain('Approved YOLO permission profile for this turn: edit');
      expect(run.prompt).toContain('Web access for this run');
    }
    expect(listMessages(db, room.id)[0]!.text).toContain(
      'YOLO permissions: edit; filesystem scope: active mission path: C:/work/project; web: requested.',
    );
    expect(listAgentRuns(db, room.id).map((run) => run.permissionMode)).toEqual(['edit', 'edit']);
  });

  it('assigns independent checklist lanes to YOLO agents in the same pulse', async () => {
    let turn = 0;
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId, permission) => {
        turn += 1;
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text:
            turn <= 2
              ? [
                  `${spec.id} taking the assigned lane.`,
                  '',
                  '/mission-receipt',
                  'status: continuing',
                  'summary: Started the assigned YOLO lane.',
                  '/end-mission-receipt',
                ].join('\n')
              : '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'parallel-lanes', agents: ['claude', 'codex'] });
    const task = yoloBroker.createTask(room.id, {
      title: 'Parallel mission',
      repoPath: 'C:/work/project',
    });
    if (!task) throw new Error('task not created');
    createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Implement UI lane',
      detail: 'Touch only the UI files.',
    });
    createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Verify broker lane',
      detail: 'Run broker tests and inspect failures.',
    });

    await yoloBroker.startYoloDiscussion(room.id, 'human', {
      mode: 'edit',
      filesystemScope: 'task',
    });

    expect(runs.slice(0, 2)).toHaveLength(2);
    expect(runs[0]!.prompt).toContain('YOLO work lane');
    expect(runs[1]!.prompt).toContain('YOLO work lane');
    expect(runs[0]!.prompt).not.toEqual(runs[1]!.prompt);
    const firstRoundLaneTitles = runs.slice(0, 2).map((run) => {
      const assignedLine = run.prompt
        .split(/\r?\n/)
        .find((line) => line.startsWith('Assigned item:'));
      if (assignedLine?.includes('Implement UI lane')) return 'Implement UI lane';
      if (assignedLine?.includes('Verify broker lane')) return 'Verify broker lane';
      return 'unknown';
    });
    expect(new Set(firstRoundLaneTitles)).toEqual(
      new Set(['Implement UI lane', 'Verify broker lane']),
    );
    const items = listTaskChecklistItems(db, task.id);
    expect(items.map((item) => item.ownerAgentId).sort()).toEqual(['claude', 'codex']);
    const actionLabels = listAgentRuns(db, room.id).flatMap((run) =>
      listAgentRunActions(db, run.id).map((action) => action.label),
    );
    expect(actionLabels).toContain('YOLO lane assigned');
    expect(actionLabels).toContain('mission receipt: continuing');
  });

  it('stops YOLO after no-update receipt-only turns instead of burning the full turn bank', async () => {
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            '/mission-receipt',
            'status: no_update',
            'summary: Standby continues. No checklist state changed.',
            '/end-mission-receipt',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'standby-yolo', agents: ['claude', 'codex'] });
    yoloBroker.createTask(room.id, { title: 'No-op mission' });

    await yoloBroker.startYoloDiscussion(room.id, 'human', {
      mode: 'edit',
      filesystemScope: 'task',
    });

    expect(runs.map((run) => run.agentId).sort()).toEqual(['claude', 'codex']);
    const actions = listAgentRuns(db, room.id).flatMap((run) => listAgentRunActions(db, run.id));
    expect(actions.map((action) => action.label)).toContain('mission receipt: no_update');
    expect(actions.map((action) => action.detail)).toContain(
      'mission receipt stored without progress',
    );
  });

  it('stops YOLO after continuing standby receipts that only update checklist notes', async () => {
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            '/mission-receipt',
            'status: continuing',
            'summary: Honest standby. No new commits to verify.',
            'next: Run verification when the implementation commit lands.',
            '/end-mission-receipt',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'standby-status-note-yolo', agents: ['claude'] });
    const task = yoloBroker.createTask(room.id, { title: 'Standby mission' });
    if (!task) throw new Error('task not created');
    createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Regression coverage',
      ownerAgentId: 'claude',
    });

    await yoloBroker.startYoloDiscussion(room.id, 'human', {
      mode: 'edit',
      filesystemScope: 'task',
    });

    expect(runs.map((run) => run.agentId)).toEqual(['claude']);
    const actions = listAgentRuns(db, room.id).flatMap((run) => listAgentRunActions(db, run.id));
    expect(actions.map((action) => action.label)).toEqual(
      expect.arrayContaining([
        'reconciled checklist status note',
        'mission control update only',
      ]),
    );
    expect(actions.map((action) => action.detail)).toContain(
      'mission receipt stored without progress',
    );
    expect(listAgentTurnOutcomesForRoom(db, room.id)).toMatchObject([
      {
        agentId: 'claude',
        progressed: false,
        visibleMessageEmitted: false,
        missionReconciliations: 1,
      },
    ]);
  });

  it('dispatches a lead repair turn when YOLO launch has empty open phases', async () => {
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            `${spec.id}-repairing-empty-phases`,
            '/mission-receipt',
            'status: continuing',
            'summary: Lead repair turn saw the empty phase blocker.',
            '/end-mission-receipt',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'empty-phase-yolo', agents: ['claude'] });
    const task = yoloBroker.createTask(room.id, { title: 'Mission with an empty phase' });
    if (!task) throw new Error('task not created');
    const phase = yoloBroker.createTaskPhase(room.id, task.id, {
      title: 'Unseeded phase',
      status: 'active',
    });

    await yoloBroker.startYoloDiscussion(room.id, 'human', {
      mode: 'edit',
      filesystemScope: 'task',
    });

    expect(runs.map((run) => run.agentId)).toEqual(['claude']);
    expect(runs[0]!.prompt).toContain('Unseeded phase');
    expect(listMessages(db, room.id).map((message) => message.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`Unseeded phase [active, id=${phase!.id}]`),
        'claude-repairing-empty-phases',
      ]),
    );
  });

  it('uses an explicit team lead before role fallback for empty-phase YOLO repair', async () => {
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            `${spec.id}-lead-repair`,
            '/mission-receipt',
            'status: continuing',
            'summary: Explicit lead took the launch repair.',
            '/end-mission-receipt',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => fakeSpec(id, `${id} reply`),
    });
    const room = createRoom(db, {
      name: 'explicit-lead-yolo',
      leadAgentId: 'codex-tech-lead',
      agentProfiles: [
        {
          id: 'claude-project-manager',
          providerId: 'claude',
          displayName: 'Jimmy',
          personaId: 'project-manager',
          personaName: 'Project Manager',
          personaSummary: '',
        },
        {
          id: 'codex-tech-lead',
          providerId: 'codex',
          displayName: 'Sean',
          personaId: 'technical-lead',
          personaName: 'Technical Lead',
          personaSummary: '',
        },
      ],
    });
    const task = yoloBroker.createTask(room.id, { title: 'Mission with explicit lead' });
    if (!task) throw new Error('task not created');
    yoloBroker.createTaskPhase(room.id, task.id, {
      title: 'Empty lead-owned phase',
      status: 'active',
    });

    await yoloBroker.startYoloDiscussion(room.id, 'human', {
      mode: 'edit',
      filesystemScope: 'task',
    });

    expect(runs.map((run) => run.agentId)).toEqual(['codex']);
    expect(runs[0]!.prompt).toContain('produce only the next message to be sent by "codex-tech-lead"');
    expect(runs[0]!.prompt).toContain('Team lead: Sean (@sean)');
  });

  it('routes explicit human mentions as direct turns even when the target is a YOLO agent', async () => {
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            `${spec.id}-saw-direct-mention`,
            '/mission-receipt',
            'status: no_update',
            'summary: Direct human mention answered; no mission state changed.',
            '/end-mission-receipt',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, {
      name: 'direct-yolo-mention',
      agents: ['claude'],
      yoloAgents: ['claude'],
    });
    const task = yoloBroker.createTask(room.id, { title: 'Mission with an empty phase' });
    if (!task) throw new Error('task not created');
    yoloBroker.createTaskPhase(room.id, task.id, {
      title: 'Unseeded phase',
      status: 'active',
    });

    await yoloBroker.postHumanMessage(room.id, 'human', '@claude answer directly');

    expect(runs.map((run) => run.agentId)).toEqual(['claude']);
    expect(runs[0]!.prompt).not.toContain('YOLO collaboration budget');
    expect(listMessages(db, room.id).map((message) => `${message.authorId}:${message.text}`)).toEqual([
      'human:@claude answer directly',
      'claude:claude-saw-direct-mention',
    ]);
  });

  it('pauses YOLO when the active mission is waiting on a human council item', async () => {
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: `${spec.id}-should-not-run`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'human-wait-yolo', agents: ['claude'] });
    const task = yoloBroker.createTask(room.id, { title: 'Human decision mission' });
    if (!task) throw new Error('task not created');
    createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Choose polish scope',
      status: 'blocked',
      blockedReason: 'Waiting on Matt to choose the scope.',
      councilRequired: true,
    });
    yoloBroker.updateTask(room.id, task.id, { status: 'blocked' });

    await yoloBroker.startYoloDiscussion(room.id, 'human', {
      mode: 'edit',
      filesystemScope: 'task',
    });

    expect(runs).toHaveLength(0);
  });

  it('lets a seeded YOLO planner fan assigned work out to the room YOLO pool', async () => {
    let createdPlan = false;
    let completedSeededOwners = 0;
    let roomId = '';
    let yoloBroker: Broker;
    yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId, permission) => {
        const agentId =
          (prompt.match(/next message to be sent by "([^"]+)"/)?.[1] ?? spec.id) as AgentId;
        runs.push({
          agentId,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        if (agentId === 'codex-project-manager' && !createdPlan) {
          createdPlan = true;
          return {
            text: [
              'Plan scaffolded. The team can start the assigned lanes.',
              '',
              '/mission-create',
              'title: Seeded planner fanout',
              'goal: Prove assigned work fans out beyond the explicitly mentioned planner.',
              'agents: codex-project-manager, claude-technical-lead, gemini-qa-lead',
              'capability_profile: full-auto',
              '/end-mission-create',
              '',
              '/mission-plan',
              'action: create',
              'title: Fanout plan',
              'status: active',
              '/end-mission-plan',
              '',
              '/mission-phase',
              'action: create',
              'title: Discovery',
              'status: active',
              'gate: Assigned owners have received their lanes.',
              '/end-mission-phase',
              '',
              '/mission-task',
              'action: create',
              'title: Technical sequencing',
              'status: open',
              'phase: Discovery',
              'owner: claude-technical-lead',
              'parallelism: parallel-safe',
              '/end-mission-task',
              '',
              '/mission-task',
              'action: create',
              'title: QA acceptance matrix',
              'status: open',
              'phase: Discovery',
              'owner: gemini-qa-lead',
              'parallelism: parallel-safe',
              '/end-mission-task',
            ].join('\n'),
            sessionId: `${spec.id}-sess`,
            raw: { stdout: '', stderr: '' },
          };
        }
        if (agentId !== 'codex-project-manager') {
          const assignedItemId = prompt.match(/Assigned item:.*?\[id=([^\]]+)\]/)?.[1] ?? '';
          completedSeededOwners += 1;
          if (completedSeededOwners >= 2) {
            yoloBroker.cancelYoloDiscussion(roomId, 'test');
          }
          return {
            text: [
              `${agentId} completed the assigned lane.`,
              '',
              '/mission-task',
              'action: update',
              `id: ${assignedItemId}`,
              'status: done',
              'note: Seeded YOLO fanout reached this assigned owner.',
              '/end-mission-task',
            ].join('\n'),
            sessionId: `${spec.id}-sess`,
            raw: { stdout: '', stderr: '' },
          };
        }
        return {
          text: '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, {
      name: 'seeded-yolo-fanout',
      yoloAgents: ['codex-project-manager', 'claude-technical-lead', 'gemini-qa-lead'],
      agentProfiles: [
        {
          id: 'codex-project-manager',
          providerId: 'codex',
          displayName: 'Jimmy',
          personaId: 'project-manager',
          personaName: 'Project Manager',
          personaSummary: '',
        },
        {
          id: 'claude-technical-lead',
          providerId: 'claude',
          displayName: 'Sean',
          personaId: 'technical-lead',
          personaName: 'Technical Lead',
          personaSummary: '',
        },
        {
          id: 'gemini-qa-lead',
          providerId: 'gemini',
          displayName: 'Holly',
          personaId: 'qa-lead',
          personaName: 'QA Lead',
          personaSummary: '',
        },
      ],
    });
    roomId = room.id;

    await yoloBroker.startYoloDiscussion(
      room.id,
      'human',
      {
        mode: 'full-auto',
        filesystemScope: 'unrestricted',
        web: true,
      },
      '@codex-project-manager build the plan',
      ['codex-project-manager'],
    );

    expect(runs[0]!.agentId).toBe('codex-project-manager');
    expect(runs.map((run) => run.agentId)).toEqual(
      expect.arrayContaining([
        'codex-project-manager',
        'claude-technical-lead',
        'gemini-qa-lead',
      ]),
    );
    const laneJobs = listAgentJobsForRoom(db, room.id).filter((job) => job.checklistItemId);
    expect(laneJobs.map((job) => job.agentId)).toEqual(
      expect.arrayContaining(['claude-technical-lead', 'gemini-qa-lead']),
    );
    for (const job of laneJobs.filter((candidate) => candidate.agentId !== 'codex-project-manager')) {
      expect(job.status).toBe('completed');
    }
  });

  it('does not assign conflicting YOLO lane scope contracts in the same pulse', async () => {
    let turn = 0;
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId, permission) => {
        turn += 1;
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text:
            turn <= 2
              ? [
                  `${spec.id} started a lane.`,
                  '',
                  '/mission-receipt',
                  'status: continuing',
                  'summary: Started assigned work.',
                  '/end-mission-receipt',
                ].join('\n')
              : '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'scope-contracts', agents: ['claude', 'codex'] });
    const task = yoloBroker.createTask(room.id, {
      title: 'Scoped parallel mission',
      repoPath: 'C:/work/project',
    });
    if (!task) throw new Error('task not created');
    createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Implement board shell',
      expectedTouches: ['client/app/app.html', 'client/app/app.css'],
      parallelism: 'coordinate',
      conflictGroup: 'mission-board-ui',
    });
    createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Polish board cards',
      expectedTouches: ['client/app/app.css'],
      parallelism: 'coordinate',
      conflictGroup: 'mission-board-ui',
    });
    createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Verify broker tests',
      expectedTouches: ['server/tests/integration/broker-echo.test.ts'],
      parallelism: 'parallel-safe',
      conflictGroup: 'broker-tests',
    });

    await yoloBroker.startYoloDiscussion(room.id, 'human', {
      mode: 'edit',
      filesystemScope: 'task',
    });

    const assignedLines = runs
      .slice(0, 2)
      .map((run) => run.prompt.split(/\r?\n/).find((line) => line.startsWith('Assigned item:')));
    const assignedText = assignedLines.join('\n');
    const assignedBoardItems = ['Implement board shell', 'Polish board cards'].filter((title) =>
      assignedText.includes(title),
    );
    expect(assignedBoardItems).toHaveLength(1);
    expect(assignedLines.join('\n')).toContain('Verify broker tests');
    expect(runs[0]!.prompt).toContain('Scope contract: expected_touches=');
    const items = listTaskChecklistItems(db, task.id);
    const unassignedBoardItems = items.filter(
      (item) =>
        ['Implement board shell', 'Polish board cards'].includes(item.title) && !item.ownerAgentId,
    );
    expect(unassignedBoardItems).toHaveLength(1);
    const jobs = listAgentJobsForRoom(db, room.id);
    expect(
      jobs
        .map(
          (job) => JSON.parse(job.workPacketJson) as { assignedItem?: { conflictGroup?: string } },
        )
        .map((packet) => packet.assignedItem?.conflictGroup)
        .filter(Boolean),
    ).toContain('mission-board-ui');
  });

  it('auto-approves agent permission requests during YOLO without creating a prompt', async () => {
    let turn = 0;
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId, permission) => {
        turn += 1;
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text:
            turn === 1
              ? [
                  '/permission-request',
                  'mode: bash',
                  'target: git status',
                  'reason: Run a scoped git status command before editing.',
                ].join('\n')
              : turn === 2
                ? 'ran git status and continued'
                : '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
      resumeCliSessions: true,
    });
    const room = createRoom(db, { name: 'overnight-auto-permissions', agents: ['claude'] });

    await yoloBroker.startYoloDiscussion(room.id, 'human', {
      mode: 'edit',
      filesystemScope: 'task',
      web: true,
    });

    expect(runs).toHaveLength(3);
    expect(runs[0]!.permission).toMatchObject({
      source: 'yolo',
      mode: 'edit',
      filesystemScope: 'task',
      web: true,
    });
    expect(runs[1]!.permission).toMatchObject({
      source: 'yolo',
      mode: 'full-auto',
      requestedMode: 'bash',
      target: 'git status',
      filesystemScope: 'task',
      web: true,
    });
    expect(runs[1]!.prompt).toContain('Approved YOLO permission profile for this turn: full-auto');
    expect(listPermissionRequests(db, room.id)).toEqual([]);
    expect(listMessages(db, room.id).map((m) => `${m.authorId}:${m.text}`)).toEqual([
      expect.stringContaining('human:YOLO collaboration mode:'),
      'claude:ran git status and continued',
    ]);
    const agentRuns = listAgentRuns(db, room.id);
    expect(agentRuns).toHaveLength(3);
    expect(agentRuns.map((run) => run.status)).not.toContain('permission-requested');
    const actionLabels = agentRuns.flatMap((run) =>
      listAgentRunActions(db, run.id).map((action) => action.label),
    );
    expect(actionLabels).toContain('full-auto permission auto-approved in YOLO');
  });

  it('applies room-level YOLO agent flags and budget to normal chat turns', async () => {
    let turn = 0;
    const yoloBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId, permission) => {
        turn += 1;
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text:
            turn === 1
              ? [
                  '/permission-request',
                  'mode: edit',
                  'target: C:\\work\\project',
                  'reason: Continue the assigned implementation lane.',
                ].join('\n')
              : turn === 2
                ? 'continued under room-level YOLO'
                : '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, {
      name: 'room-yolo-flags',
      agents: ['claude', 'gemini'],
      yoloAgents: ['claude'],
    });

    await yoloBroker.postHumanMessage(room.id, 'human', 'keep going');

    expect(runs).toHaveLength(3);
    expect(runs[0]!.permission).toMatchObject({
      source: 'yolo',
      mode: 'full-auto',
      target: 'unrestricted filesystem',
      filesystemScope: 'unrestricted',
      web: true,
    });
    expect(runs[0]!.prompt).toContain('Approved YOLO permission profile for this turn: full-auto');
    expect(runs[0]!.prompt).toContain('YOLO collaboration budget');
    expect(runs[1]!.permission).toMatchObject({
      source: 'yolo',
      mode: 'edit',
      target: 'C:\\work\\project',
      filesystemScope: 'unrestricted',
      web: true,
    });
    expect(listPermissionRequests(db, room.id)).toEqual([]);
    expect(listMessages(db, room.id).map((m) => `${m.authorId}:${m.text}`)).toEqual([
      'human:keep going',
      'claude:continued under room-level YOLO',
    ]);
  });

  it('applies room-level YOLO budget to agent handoffs', async () => {
    let turn = 0;
    const yoloBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId, permission) => {
        turn += 1;
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text:
            turn === 1
              ? 'Codex, please verify this before I continue.'
              : turn === 2
                ? 'Verified under room-level YOLO.'
                : '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, {
      name: 'room-yolo-handoff',
      agents: ['claude', 'codex'],
      yoloAgents: ['codex'],
    });

    await yoloBroker.postHumanMessage(room.id, 'human', '@claude start the handoff');

    expect(runs.map((run) => run.agentId)).toEqual(['claude', 'codex', 'codex']);
    expect(runs[1]!.prompt).toContain('YOLO collaboration budget');
    expect(runs[1]!.prompt).toContain('up to 100 total agent messages');
    expect(runs[1]!.permission).toMatchObject({
      source: 'yolo',
      mode: 'full-auto',
      filesystemScope: 'unrestricted',
      web: true,
    });
    expect(listMessages(db, room.id).map((m) => `${m.authorId}:${m.text}`)).toContain(
      'codex:Verified under room-level YOLO.',
    );
  });

  it('treats explicit unrestricted YOLO chat as a broker-managed YOLO run', async () => {
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId, permission) => {
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text: `${spec.id} working`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'inline-yolo', agents: ['claude'] });

    await yoloBroker.postHumanMessage(
      room.id,
      'human',
      "i need you to understand you're in unrestricted yolo mode. follow the plan.",
    );

    expect(runs).toHaveLength(100);
    expect(runs[0]!.permission).toMatchObject({
      source: 'yolo',
      mode: 'full-auto',
      target: 'unrestricted filesystem',
      filesystemScope: 'unrestricted',
    });
    expect(runs[0]!.prompt).toContain('YOLO collaboration budget');
    expect(runs[0]!.prompt).toContain('Approved YOLO permission profile for this turn: full-auto');
  });

  it('lets a human stop YOLO before it launches more rounds', async () => {
    const events: Array<{ active: boolean; reason?: string }> = [];
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId, permission, cancelSignal) => {
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        if (runs.length === 2) {
          yoloBroker.cancelYoloDiscussion(room.id, 'human');
        }
        expect(cancelSignal).toBeDefined();
        return {
          text: `${spec.id}-yolo`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    yoloBroker.on('yoloStatusUpdated', (status) => events.push(status));
    const room = createRoom(db, { name: 'stoppable-yolo', agents: ['claude', 'codex'] });

    await yoloBroker.startYoloDiscussion(room.id, 'human');

    expect(runs).toHaveLength(2);
    expect(events[0]!.active).toBe(true);
    expect(events.at(-1)).toMatchObject({ active: false, reason: 'manual' });
    expect(listMessages(db, room.id).map((message) => message.text)).toContain(
      'YOLO collaboration stopped: human clicked stop. In-flight agent turns are interrupted where possible; no further YOLO rounds will start.',
    );
  });

  it('emits live YOLO turn-bank status and lets a human add turns', async () => {
    const events: Array<{
      active: boolean;
      maxTotalReplies?: number;
      totalRepliesUsed?: number;
      remainingReplies?: number;
      reason?: string;
    }> = [];
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId, permission) => {
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        if (runs.length === 1) {
          yoloBroker.addYoloTurns(room.id, 'human', 25);
          yoloBroker.cancelYoloDiscussion(room.id, 'human');
        }
        return {
          text: `${spec.id}-yolo`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    yoloBroker.on('yoloStatusUpdated', (status) => events.push(status));
    const room = createRoom(db, { name: 'extend-yolo', agents: ['claude'] });

    await yoloBroker.startYoloDiscussion(room.id, 'human');

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          active: true,
          maxTotalReplies: 100,
          totalRepliesUsed: 0,
          remainingReplies: 100,
        }),
        expect.objectContaining({
          active: true,
          maxTotalReplies: 125,
          totalRepliesUsed: 0,
          remainingReplies: 125,
          reason: 'turns-added:human:25',
        }),
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      active: false,
      maxTotalReplies: 125,
      reason: 'manual',
    });
  });

  it('aborts an in-flight YOLO agent turn when stopped', async () => {
    let signalSeen: AbortSignal | undefined;
    const yoloBroker = new Broker({
      db,
      runAgent: async (_spec, _prompt, _sessionId, _permission, cancelSignal) => {
        signalSeen = cancelSignal;
        return await new Promise<AgentReply>((resolve) => {
          cancelSignal?.addEventListener(
            'abort',
            () =>
              resolve({
                text: '',
                sessionId: 'claude-sess',
                raw: { stdout: '', stderr: '' },
              }),
            { once: true },
          );
        });
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'abort-yolo', agents: ['claude'] });

    const discussion = yoloBroker.startYoloDiscussion(room.id, 'human');
    while (!signalSeen) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    yoloBroker.cancelYoloDiscussion(room.id, 'human');
    await discussion;

    expect(signalSeen.aborted).toBe(true);
    expect(listMessages(db, room.id).map((message) => message.text)).toContain(
      'YOLO collaboration stopped: human clicked stop. In-flight agent turns are interrupted where possible; no further YOLO rounds will start.',
    );
  });

  it('queues human messages while an agent run is active instead of dispatching immediately', async () => {
    const room = createRoom(db, { name: 'queued-context', agents: ['claude'] });
    createAgentRun(db, {
      roomId: room.id,
      agentId: 'claude',
      triggerMessageId: 'active-trigger',
      permissionMode: 'plan',
      promptChars: 10,
      estimatedPromptTokens: 3,
      liveMessages: 1,
      contextArtifacts: 0,
    });

    await broker.postHumanMessage(room.id, 'human', '@claude additional context');

    expect(runs).toEqual([]);
    expect(
      listMessages(db, room.id).map((message) => `${message.authorId}:${message.text}`),
    ).toEqual(['human:@claude additional context']);
  });

  it('drains queued human context after the active turn finishes', async () => {
    let turn = 0;
    const queuedBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        turn += 1;
        runs.push({ agentId: spec.id, prompt, sessionId });
        if (turn === 1) {
          await queuedBroker.postHumanMessage(room.id, 'human', '@claude queued context');
          return {
            text: '',
            sessionId: `${spec.id}-sess`,
            raw: { stdout: '', stderr: '' },
          };
        }
        return {
          text: 'saw queued context',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'queued-context-drain', agents: ['claude'] });

    await queuedBroker.postHumanMessage(room.id, 'human', '@claude first');

    expect(runs.map((run) => run.agentId)).toEqual(['claude', 'claude']);
    expect(runs[1]!.prompt).toContain('@claude queued context');
    expect(
      listMessages(db, room.id).map((message) => `${message.authorId}:${message.text}`),
    ).toEqual(['human:@claude first', 'human:@claude queued context', 'claude:saw queued context']);
  });

  it('drains queued context for a YOLO agent', async () => {
    let turn = 0;
    const queuedBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId, permission) => {
        turn += 1;
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        if (turn === 1) {
          await queuedBroker.postHumanMessage(room.id, 'human', '@claude queued yolo context');
          return {
            text: '',
            sessionId: `${spec.id}-sess`,
            raw: { stdout: '', stderr: '' },
          };
        }
        return {
          text: turn === 2 ? 'saw queued yolo context' : '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, {
      name: 'queued-yolo-context-drain',
      agents: ['gemini', 'claude'],
      yoloAgents: ['claude'],
    });

    await queuedBroker.postHumanMessage(room.id, 'human', '@gemini first');

    expect(runs.map((run) => run.agentId)).toEqual(['gemini', 'claude']);
    expect(
      listMessages(db, room.id).map((message) => `${message.authorId}:${message.text}`),
    ).toEqual([
      'human:@gemini first',
      'human:@claude queued yolo context',
      'claude:saw queued yolo context',
    ]);
  });

  it('explicit stop aborts an in-flight non-YOLO agent turn', async () => {
    let signalSeen: AbortSignal | undefined;
    const stopBroker = new Broker({
      db,
      runAgent: async (_spec, _prompt, _sessionId, _permission, cancelSignal) => {
        signalSeen = cancelSignal;
        return await new Promise<AgentReply>((resolve) => {
          cancelSignal?.addEventListener(
            'abort',
            () =>
              resolve({
                text: '',
                sessionId: 'claude-sess',
                raw: { stdout: '', stderr: '' },
              }),
            { once: true },
          );
        });
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'stop-normal-run', agents: ['claude'] });

    const discussion = stopBroker.postHumanMessage(room.id, 'human', '@claude start');
    while (!signalSeen) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const result = stopBroker.stopRoomRuns(room.id, 'human');
    await discussion;

    expect(result.stopped).toBe(1);
    expect(signalSeen.aborted).toBe(true);
    expect(listMessages(db, room.id).map((message) => message.text)).toContain(
      'Agent work stopped: human clicked stop. In-flight provider turns are interrupted where possible.',
    );
  });

  it('stopAgentRun aborts the targeted run and lands canceled_by_user', async () => {
    let signalSeen: AbortSignal | undefined;
    const stopBroker = new Broker({
      db,
      runAgent: async (_spec, _prompt, _sessionId, _permission, cancelSignal) => {
        signalSeen = cancelSignal;
        return await new Promise<AgentReply>((_resolve, reject) => {
          cancelSignal?.addEventListener(
            'abort',
            () => {
              // Mirror the real runner: a canceled subprocess surfaces as a
              // SubprocessCanceledError so the broker's cancel branch fires.
              const err = new Error('subprocess canceled');
              err.name = 'SubprocessCanceledError';
              reject(err);
            },
            { once: true },
          );
        });
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'stop-single-run', agents: ['claude'] });

    const discussion = stopBroker.postHumanMessage(room.id, 'human', '@claude start');
    while (!signalSeen) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const liveRuns = listAgentRuns(db, room.id, { limit: 10 });
    const runningRun = liveRuns.find((run) => run.status === 'running');
    expect(runningRun).toBeDefined();

    const result = stopBroker.stopAgentRun(room.id, runningRun!.id, 'matt');
    await discussion;

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(signalSeen.aborted).toBe(true);

    const finalRun = listAgentRuns(db, room.id, { limit: 10 }).find(
      (run) => run.id === runningRun!.id,
    );
    expect(finalRun?.lifecycleState).toBe('canceled_by_user');
    expect(finalRun?.lifecycleReason).toBe('matt stopped this run');

    const messages = listMessages(db, room.id).map((message) => message.text);
    expect(messages).toContain("matt stopped @claude's active run.");
  });

  it('stopAgentRun on an already-terminal run is a no-op success', () => {
    const room = createRoom(db, { name: 'stop-terminal', agents: ['claude'] });
    const trigger = addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: 'hi',
    });
    const created = createAgentRun(db, {
      roomId: room.id,
      agentId: 'claude',
      triggerMessageId: trigger.id,
      taskId: null,
      promptText: 'hi',
      promptChars: 2,
      estimatedPromptTokens: 0,
      permissionMode: 'plan',
      liveMessages: 0,
      contextArtifacts: 0,
    });
    updateAgentRun(db, created.id, {
      status: 'completed',
      completedAt: Date.now(),
      lifecycleState: 'released',
      lifecycleReason: 'already done',
    });
    const result = broker.stopAgentRun(room.id, created.id, 'matt');
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.run?.lifecycleState).toBe('released');
  });

  it('stopAgentRun returns 404 for an unknown run', () => {
    const room = createRoom(db, { name: 'stop-unknown', agents: ['claude'] });
    const result = broker.stopAgentRun(room.id, 'nope', 'matt');
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.error).toBe('run not found');
  });

  it('does not let one responding agent monologue when peers pass', async () => {
    const discussionBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: spec.id === 'claude' ? 'claude-only-reply' : '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });

    await discussionBroker.postHumanMessage(room.id, 'human', 'work together');

    expect(runs.map((r) => r.agentId)).toEqual(['claude', 'codex', 'codex']);
    expect(listMessages(db, room.id).map((m) => `${m.authorId}:${m.text}`)).toEqual([
      'human:work together',
      'claude:claude-only-reply',
    ]);
  });

  it('does not resume CLI session ids by default', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude'] });
    await broker.postHumanMessage(room.id, 'human', '@claude hi');
    await broker.postHumanMessage(room.id, 'human', '@claude again');
    expect(runs[0]!.sessionId).toBeNull();
    expect(runs[1]!.sessionId).toBeNull();
  });

  it('can opt into resuming CLI session ids', async () => {
    const resumeBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      resumeCliSessions: true,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: `${spec.id}-says-hello`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'g', agents: ['claude'] });

    await resumeBroker.postHumanMessage(room.id, 'human', '@claude hi');
    await resumeBroker.postHumanMessage(room.id, 'human', '@claude again');

    expect(runs[0]!.sessionId).toBeNull();
    expect(runs[1]!.sessionId).toBe('claude-sess');
  });

  it('clears a stale resumed CLI session and retries fresh when the provider reports prompt_too_long', async () => {
    const resumeBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      resumeCliSessions: true,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        if (sessionId) {
          throw new Error('[claude] prompt too long (prompt_too_long)');
        }
        return {
          text: 'fresh session recovered',
          sessionId: 'claude-fresh-session',
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'stale-session', agents: ['claude'] });
    upsertCliSessionId(db, room.id, 'claude', 'stale-session', 'claude');

    await resumeBroker.postHumanMessage(room.id, 'human', '@claude recover');

    expect(runs.map((run) => run.sessionId)).toEqual(['stale-session', null]);
    expect(getCliSessionId(db, room.id, 'claude')).toBe('claude-fresh-session');
    expect(listMessages(db, room.id).map((m) => `${m.authorId}:${m.text}`)).toEqual([
      'human:@claude recover',
      'claude:fresh session recovered',
    ]);
    expect(
      listAgentRunActionsForRoom(db, room.id).some(
        (action) => action.label === 'stale CLI session cleared',
      ),
    ).toBe(true);
  });

  it('clears a stale Codex session when a successful turn reports missing rollout thread storage', async () => {
    const resumeBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      resumeCliSessions: true,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: 'codex answered',
          sessionId: sessionId ?? 'codex-fresh-session',
          raw: {
            stdout: '',
            stderr: sessionId
              ? '2026-05-04T14:03:11.116283Z ERROR codex_core::session: failed to record rollout items: thread stale-codex-session not found'
              : '',
          },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'stale-codex-session', agents: ['codex'] });
    upsertCliSessionId(db, room.id, 'codex', 'stale-codex-session', 'codex');

    await resumeBroker.postHumanMessage(room.id, 'human', '@codex first');
    await resumeBroker.postHumanMessage(room.id, 'human', '@codex second');

    expect(runs.map((run) => run.sessionId)).toEqual(['stale-codex-session', null]);
    expect(getCliSessionId(db, room.id, 'codex')).toBe('codex-fresh-session');
    expect(
      listAgentRunActionsForRoom(db, room.id).some(
        (action) => action.label === 'stale CLI session cleared',
      ),
    ).toBe(true);
  });

  it('emits "messageAppended" events for both human and agent messages', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude'] });
    const events: Array<{ author: string; text: string }> = [];
    broker.on('messageAppended', (msg) => events.push({ author: msg.authorId, text: msg.text }));
    await broker.postHumanMessage(room.id, 'human', '@claude hi');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ author: 'human' });
    expect(events[1]).toMatchObject({ author: 'claude' });
  });

  it('marks queued human messages as delivered when an agent receives them', async () => {
    let releaseRun!: () => void;
    let firstRunStarted!: () => void;
    const releaseRunPromise = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    let runCount = 0;
    const queueBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runCount += 1;
        runs.push({ agentId: spec.id, prompt, sessionId });
        if (runCount === 1) {
          firstRunStarted();
          await releaseRunPromise;
        }
        return {
          text: `${spec.id}-says-hello-${runCount}`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => (id === 'claude' ? fakeSpec('claude', 'claude reply') : undefined),
    });
    const room = createRoom(db, { name: 'g', agents: ['claude'] });
    const deliveryUpdates: Array<{ messageId: string; deliveryStatus: string }> = [];
    queueBroker.on('messageDeliveryUpdated', (update) => {
      deliveryUpdates.push({
        messageId: update.messageId,
        deliveryStatus: update.deliveryStatus,
      });
    });

    const firstTurn = queueBroker.postHumanMessage(room.id, 'human', '@claude start slow');
    await firstRunStartedPromise;

    const queued = await queueBroker.postHumanMessage(room.id, 'human', '@claude queued context');
    expect(queued.deliveryStatus).toBe('queued');
    expect(
      queueBroker.listMessages(room.id).find((message) => message.id === queued.id),
    ).toMatchObject({
      deliveryStatus: 'queued',
    });

    releaseRun();
    await firstTurn;

    expect(deliveryUpdates).toContainEqual({
      messageId: queued.id,
      deliveryStatus: 'delivered',
    });
    expect(
      queueBroker.listMessages(room.id).find((message) => message.id === queued.id),
    ).not.toHaveProperty('deliveryStatus', 'queued');
    expect(runs).toHaveLength(2);
  });

  it('routes targeted messages to a free mentioned agent while another agent is running', async () => {
    let releaseRun!: () => void;
    let firstRunStarted!: () => void;
    const releaseRunPromise = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    const queueBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        if (spec.id === 'claude') {
          firstRunStarted();
          await releaseRunPromise;
        }
        return {
          text: `${spec.id}-says-hello`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });

    const firstTurn = queueBroker.postHumanMessage(room.id, 'human', '@claude start slow');
    await firstRunStartedPromise;

    const routed = await queueBroker.postHumanMessage(room.id, 'human', '@codex take this');

    expect(routed.deliveryStatus).toBe('delivered');
    expect(runs.map((run) => run.agentId)).toEqual(['claude', 'codex']);
    expect(
      queueBroker.listMessages(room.id).find((message) => message.id === routed.id),
    ).not.toHaveProperty('deliveryStatus', 'queued');

    releaseRun();
    await firstTurn;
  });

  it('routes a display-name mention to an idle same-provider agent while another instance is running', async () => {
    let releaseRun!: () => void;
    let firstRunStarted!: () => void;
    const releaseRunPromise = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    const queueBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        const turn = runs.length + 1;
        runs.push({ agentId: spec.id, prompt, sessionId });
        if (turn === 1) {
          firstRunStarted();
          await releaseRunPromise;
        }
        return {
          text: turn === 2 ? 'holly-says-hello' : 'biggs-says-hello',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          codex: fakeSpec('codex', 'codex reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, {
      name: 'same-provider-targeting',
      agentProfiles: [
        {
          id: 'gemini-qa-lead',
          providerId: 'codex',
          displayName: 'Holly',
          personaId: 'qa-lead',
          personaName: 'QA Lead',
          personaSummary: '',
        },
        {
          id: 'gemini-quality-assurance',
          providerId: 'codex',
          displayName: 'Biggs',
          personaId: 'quality-assurance-engineer',
          personaName: 'Quality Assurance Engineer',
          personaSummary: '',
        },
      ],
    });

    const firstTurn = queueBroker.postHumanMessage(room.id, 'human', '@biggs start slow');
    await firstRunStartedPromise;

    const routed = await queueBroker.postHumanMessage(
      room.id,
      'human',
      '@holly take this from @biggs',
    );

    expect(routed.deliveryStatus).toBe('delivered');
    expect(listAgentRuns(db, room.id).map((run) => run.agentId)).toEqual(expect.arrayContaining([
      'gemini-quality-assurance',
      'gemini-qa-lead',
    ]));
    expect(
      queueBroker.listMessages(room.id).find((message) => message.id === routed.id),
    ).not.toHaveProperty('deliveryStatus', 'queued');

    releaseRun();
    await firstTurn;
  });

  it('routes an explicit mention to a free YOLO agent while another YOLO agent is running', async () => {
    let releaseRun!: () => void;
    let firstRunStarted!: () => void;
    const releaseRunPromise = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    const queueBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId, permission) => {
        const turn = runs.length + 1;
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        if (turn === 1) {
          firstRunStarted();
          await releaseRunPromise;
        }
        return {
          text: turn === 2 ? 'jimmy-says-hello' : '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, {
      name: 'yolo-targeting',
      agentProfiles: [
        {
          id: 'claude-technical-lead',
          providerId: 'claude',
          displayName: 'Sean',
          personaId: 'technical-lead',
          personaName: 'Technical Lead',
          personaSummary: '',
        },
        {
          id: 'codex-project-manager',
          providerId: 'codex',
          displayName: 'Jimmy',
          personaId: 'project-manager',
          personaName: 'Project Manager',
          personaSummary: '',
        },
      ],
      yoloAgents: ['claude-technical-lead', 'codex-project-manager'],
    });

    const firstTurn = queueBroker.postHumanMessage(room.id, 'human', '@sean start slow');
    await firstRunStartedPromise;

    const routed = await queueBroker.postHumanMessage(room.id, 'human', '@jimmy take this');

    expect(routed.deliveryStatus).toBe('delivered');
    const roomRunAgents = listAgentRuns(db, room.id).map((run) => run.agentId);
    expect(roomRunAgents).toHaveLength(2);
    expect(roomRunAgents).toEqual(
      expect.arrayContaining(['claude-technical-lead', 'codex-project-manager']),
    );
    expect(runs[1]!.prompt).not.toContain('YOLO collaboration budget');
    expect(
      queueBroker.listMessages(room.id).find((message) => message.id === routed.id),
    ).not.toHaveProperty('deliveryStatus', 'queued');

    releaseRun();
    await firstTurn;
  });

  it('does not resume historical sessions from a previous provider for a room-local agent', async () => {
    const sessionsSeen: Array<string | null> = [];
    const queueBroker = new Broker({
      db,
      resumeCliSessions: true,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        sessionsSeen.push(sessionId);
        return {
          text: 'holly fresh session',
          sessionId: '019deb68-7430-71b2-93ca-f5ad8c61e971',
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          codex: fakeSpec('codex', 'codex reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, {
      name: 'provider-switched-session',
      agentProfiles: [
        {
          id: 'gemini-qa-lead',
          providerId: 'codex',
          displayName: 'Holly',
          personaId: 'qa-lead',
          personaName: 'QA Lead',
          personaSummary: '',
        },
      ],
    });
    const oldTrigger = addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: 'old gemini turn',
    });
    const oldRun = createAgentRun(db, {
      roomId: room.id,
      triggerMessageId: oldTrigger.id,
      agentId: 'gemini-qa-lead',
      permissionMode: 'plan',
      promptChars: 20,
      estimatedPromptTokens: 5,
      liveMessages: 1,
      contextArtifacts: 0,
    });
    updateAgentRun(db, oldRun.id, {
      status: 'completed',
      completedAt: Date.now(),
      cliSessionId: '1b7e862a-8c6f-40ed-b4ce-c7fab99bae8b',
    });

    await queueBroker.postHumanMessage(room.id, 'human', '@holly start fresh');

    expect(sessionsSeen).toEqual([null]);
    expect(getCliSessionId(db, room.id, 'gemini-qa-lead')).toBe(
      '019deb68-7430-71b2-93ca-f5ad8c61e971',
    );
  });

  it('edits and retracts queued human messages before they are delivered', async () => {
    let releaseRun!: () => void;
    let firstRunStarted!: () => void;
    const releaseRunPromise = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    let runCount = 0;
    const queueBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runCount += 1;
        runs.push({ agentId: spec.id, prompt, sessionId });
        if (runCount === 1) {
          firstRunStarted();
          await releaseRunPromise;
        }
        return {
          text: `${spec.id}-says-hello-${runCount}`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => (id === 'claude' ? fakeSpec('claude', 'claude reply') : undefined),
    });
    const room = createRoom(db, { name: 'g', agents: ['claude'] });
    const updatedMessages: string[] = [];
    const retractedMessages: string[] = [];
    queueBroker.on('messageUpdated', (message) => updatedMessages.push(message.text));
    queueBroker.on('messageRetracted', (update) => retractedMessages.push(update.messageId));

    const firstTurn = queueBroker.postHumanMessage(room.id, 'human', '@claude start slow');
    await firstRunStartedPromise;
    const queued = await queueBroker.postHumanMessage(room.id, 'human', '@claude original');
    const retracted = await queueBroker.postHumanMessage(room.id, 'human', '@claude retract me');

    const edited = queueBroker.editQueuedHumanMessage(
      room.id,
      queued.id,
      'human',
      '@claude edited context',
    );
    const retractUpdate = queueBroker.retractQueuedHumanMessage(room.id, retracted.id, 'human');

    expect(edited).toMatchObject({ id: queued.id, text: '@claude edited context' });
    expect(retractUpdate.messageId).toBe(retracted.id);
    expect(updatedMessages).toEqual(['@claude edited context']);
    expect(retractedMessages).toEqual([retracted.id]);

    releaseRun();
    await firstTurn;

    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toContain('@claude edited context');
    expect(runs[1]!.prompt).not.toContain('@claude original');
    expect(runs[1]!.prompt).not.toContain('@claude retract me');
    expect(listMessages(db, room.id).map((message) => message.text)).toEqual([
      '@claude start slow',
      '@claude edited context',
      'claude-says-hello-1',
      'claude-says-hello-2',
    ]);
  });

  it('injects active mission context and records agent run visibility', async () => {
    const room = createRoom(db, { name: 'mission-room', agents: ['claude'] });
    const task = broker.createTask(room.id, {
      title: 'Ship command center',
      goal: 'Add task execution controls',
      acceptanceCriteria: 'Runs and artifacts are visible',
      summary: 'Task shell is ready for implementation.',
    });
    expect(task).toBeDefined();

    await broker.postHumanMessage(room.id, 'human', '@claude next step');

    expect(runs[0]!.prompt).toContain('Active mission: Ship command center (active)');
    expect(runs[0]!.prompt).toContain('Mission goal: Add task execution controls');
    expect(runs[0]!.prompt).toContain('Mission summary: Task shell is ready for implementation.');

    expect(runs[1]!.prompt).toContain('workflow contract repair');
    const agentRuns = listAgentRuns(db, room.id);
    expect(agentRuns).toHaveLength(2);
    for (const run of agentRuns) {
      expect(run).toMatchObject({
        agentId: 'claude',
        status: 'completed',
        taskId: task!.id,
        permissionMode: 'plan',
      });
      expect(run.promptChars).toBeGreaterThan(0);
      expect(run.estimatedPromptTokens).toBeGreaterThan(0);
    }
    const actionLabels = agentRuns.flatMap((run) =>
      listAgentRunActions(db, run.id).map((action) => action.label),
    );
    expect(actionLabels).toContain('workflow contract repair requested');
  });

  it('stores hidden mission plan, phase, and checklist updates from agent replies', async () => {
    const missionBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            'Plan recorded.',
            '',
            '/mission-plan',
            'action: publish',
            'title: Agreement for mission updates',
            'status: active',
            'body:',
            '## Direction',
            'Use Mission Control as the source of truth for planning and execution.',
            '',
            '## Execution Shape',
            'Create phase gates first, then attach dependency-aware checklist items.',
            '/end-mission-plan',
            '',
            '/mission-phase',
            'action: create',
            'title: Planning',
            'status: active',
            'gate: Direction is agreed and dependencies are known',
            '/end-mission-phase',
            '',
            '/mission-task',
            'action: create',
            'title: Identify constraints',
            'status: open',
            'phase: Planning',
            'detail: Collect known task constraints before implementation.',
            '/end-mission-task',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'mission-updates', agents: ['claude'] });
    const task = missionBroker.createTask(room.id, { title: 'Plan mission updates' });

    await missionBroker.postHumanMessage(room.id, 'human', '@claude plan this');

    const plans = listTaskPlans(db, task!.id);
    const phases = listTaskPhases(db, task!.id);
    const items = listTaskChecklistItems(db, task!.id);
    expect(plans).toMatchObject([
      {
        title: 'Agreement for mission updates',
        status: 'active',
        body: expect.stringContaining('## Direction'),
      },
    ]);
    expect(phases).toMatchObject([
      {
        planId: plans[0]!.id,
        title: 'Planning',
        status: 'active',
        gate: 'Direction is agreed and dependencies are known',
      },
    ]);
    expect(items).toMatchObject([
      {
        planId: plans[0]!.id,
        title: 'Identify constraints',
        phaseId: phases[0]!.id,
        status: 'open',
      },
    ]);
    expect(listMessages(db, room.id).map((message) => message.text)).toEqual([
      '@claude plan this',
      'Plan recorded.',
    ]);
    const [run] = listAgentRuns(db, room.id);
    expect(listAgentRunActions(db, run!.id).map((action) => action.label)).toEqual(
      expect.arrayContaining([
        'mission plan create',
        'mission phase create',
        'mission task create',
      ]),
    );
  });

  it('dispatches newly assigned checklist work to the owner without a visible handoff', async () => {
    const dispatchBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        const agentId =
          (prompt.match(/next message to be sent by "([^"]+)"/)?.[1] ?? spec.id) as AgentId;
        runs.push({ agentId, prompt, sessionId });
        if (agentId === 'codex-project-manager') {
          return {
            text: [
              '/mission-task',
              'action: create',
              'title: Build routing proof',
              'status: open',
              'owner: claude-technical-lead',
              'detail: Verify mission work dispatch wakes assigned owners.',
              '/end-mission-task',
            ].join('\n'),
            sessionId: `${spec.id}-sess`,
            raw: { stdout: '', stderr: '' },
          };
        }
        const assignedItemId = prompt.match(/Assigned item:.*?\[id=([^\]]+)\]/)?.[1] ?? '';
        return {
          text: [
            '/mission-receipt',
            'status: completed',
            `item: ${assignedItemId}`,
            'summary: Assigned owner received the generated work lane.',
            '/end-mission-receipt',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, {
      name: 'mission-work-dispatch',
      yoloAgents: [],
      agentProfiles: [
        {
          id: 'codex-project-manager',
          providerId: 'codex',
          displayName: 'Jimmy',
          personaId: 'project-manager',
          personaName: 'Project Manager',
          personaSummary: '',
        },
        {
          id: 'claude-technical-lead',
          providerId: 'claude',
          displayName: 'Sean',
          personaId: 'technical-lead',
          personaName: 'Technical Lead',
          personaSummary: '',
        },
      ],
    });
    const task = dispatchBroker.createTask(room.id, { title: 'Dispatch owner mission' });

    await dispatchBroker.postHumanMessage(room.id, 'human', '@jimmy create assigned work');

    expect(runs.map((run) => run.agentId)).toEqual([
      'codex-project-manager',
      'claude-technical-lead',
    ]);
    expect(runs[1]!.prompt).toContain('Assigned item: - open: Build routing proof');
    expect(listTaskChecklistItems(db, task!.id)).toMatchObject([
      {
        title: 'Build routing proof',
        ownerAgentId: 'claude-technical-lead',
        status: 'done',
        updatedBy: 'claude-technical-lead',
      },
    ]);
    const labels = listAgentRuns(db, room.id).flatMap((run) =>
      listAgentRunActions(db, run.id).map((action) => action.label),
    );
    expect(labels).toContain('mission work dispatch');
    expect(labels).toContain('reconciled checklist completion');
  });

  it('lets an agent create a mission and populate control state in one reply', async () => {
    const missionBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            'Mission scaffolded from the document.',
            '',
            '/mission-create',
            'title: Document implementation mission',
            'goal: Turn the shared document into executable team work.',
            'repo_path: C:/work/project',
            'acceptance: Plan, gates, checklist, dependencies, and owners are recorded.',
            'agents: claude, codex',
            'capability_profile: edit',
            'summary: Agent-created mission scaffold.',
            '/end-mission-create',
            '',
            '/mission-plan',
            'action: create',
            'title: Document execution plan',
            'status: active',
            'body:',
            '## Direction',
            'Decompose the document into phase-gated work.',
            '/end-mission-plan',
            '',
            '/mission-phase',
            'action: create',
            'title: Phase 1',
            'status: active',
            'gate: Checklist is actionable',
            '/end-mission-phase',
            '',
            '/mission-task',
            'action: create',
            'title: Build task graph',
            'status: open',
            'phase: Phase 1',
            'owner: claude',
            'detail: Create independent and dependent work items.',
            '/end-mission-task',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'agent-created-mission', agents: ['claude', 'codex'] });

    await missionBroker.postHumanMessage(room.id, 'human', '@claude draft the mission');

    const [task] = listTasks(db, room.id);
    expect(task).toMatchObject({
      title: 'Document implementation mission',
      goal: 'Turn the shared document into executable team work.',
      repoPath: 'C:/work/project',
      acceptanceCriteria: 'Plan, gates, checklist, dependencies, and owners are recorded.',
      agents: ['claude', 'codex'],
      capabilityProfile: 'edit',
      summary: 'Agent-created mission scaffold.',
      status: 'active',
    });
    const plans = listTaskPlans(db, task!.id);
    const phases = listTaskPhases(db, task!.id);
    const items = listTaskChecklistItems(db, task!.id);
    expect(plans[0]).toMatchObject({ title: 'Document execution plan', status: 'active' });
    expect(phases[0]).toMatchObject({
      planId: plans[0]!.id,
      title: 'Phase 1',
      status: 'active',
    });
    expect(items[0]).toMatchObject({
      planId: plans[0]!.id,
      phaseId: phases[0]!.id,
      title: 'Build task graph',
      ownerAgentId: 'claude',
      status: 'open',
    });
    expect(listMessages(db, room.id).map((message) => message.text)).toEqual([
      '@claude draft the mission',
      'Mission scaffolded from the document.',
    ]);
    const [run] = listAgentRuns(db, room.id);
    expect(run).toMatchObject({ status: 'completed', taskId: null });
    expect(listAgentRunActions(db, run!.id).map((action) => action.label)).toEqual(
      expect.arrayContaining([
        'mission created',
        'mission plan create',
        'mission phase create',
        'mission task create',
      ]),
    );
  });

  it('records mission receipts, strips them from chat, and feeds the protocol into prompts', async () => {
    const receiptBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            'The current gate is satisfied.',
            '',
            '/mission-receipt',
            'status: completed',
            'phase: Phase 1',
            'summary: Verified the acceptance evidence and handed off the next phase.',
            'evidence: test:npm test',
            '/end-mission-receipt',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'mission-receipt', agents: ['claude'] });
    const task = receiptBroker.createTask(room.id, { title: 'Receipt mission' });

    await receiptBroker.postHumanMessage(room.id, 'human', '@claude verify the gate');

    expect(runs[0]!.prompt).toContain('Mission receipt protocol');
    expect(listMessages(db, room.id).map((message) => message.text)).toEqual([
      '@claude verify the gate',
      'The current gate is satisfied.',
    ]);
    const [run] = listAgentRuns(db, room.id);
    const actions = listAgentRunActions(db, run!.id);
    expect(actions.map((action) => action.label)).toContain('mission receipt: completed');
    expect(actions.map((action) => action.label)).not.toContain('mission receipt missing');
    expect(actions.find((action) => action.label === 'mission receipt: completed')).toMatchObject({
      taskId: task!.id,
      status: 'completed',
    });
  });

  it('reconciles receipt-only completion into checklist and phase state', async () => {
    const receiptBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            'The implementation gate is complete.',
            '',
            '/mission-receipt',
            'status: completed',
            'item: Wire backend reconciler',
            'phase: Implementation',
            'summary: Reconciler landed and tests passed.',
            'evidence: test:npm test',
            '/end-mission-receipt',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'receipt-reconciliation', agents: ['codex'] });
    const task = receiptBroker.createTask(room.id, { title: 'Reconcile receipts' });
    const phase = receiptBroker.createTaskPhase(room.id, task!.id, {
      title: 'Implementation',
      status: 'active',
      sortOrder: 1,
    });
    receiptBroker.createTaskChecklistItem(room.id, task!.id, {
      title: 'Wire backend reconciler',
      phaseId: phase!.id,
      status: 'open',
    });

    await receiptBroker.postHumanMessage(room.id, 'human', '@codex report status');

    expect(listTaskChecklistItems(db, task!.id)).toMatchObject([
      {
        title: 'Wire backend reconciler',
        status: 'done',
        statusNote: expect.stringContaining('Reconciler landed'),
        updatedBy: 'codex',
      },
    ]);
    expect(listTaskPhases(db, task!.id)).toMatchObject([
      { title: 'Implementation', status: 'done' },
    ]);
    const [run] = listAgentRuns(db, room.id);
    const labels = listAgentRunActions(db, run!.id).map((action) => action.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'reconciled checklist completion',
        'reconciled phase completion',
        'mission state reconciled',
      ]),
    );
  });

  it('infers a completed YOLO lane from the assigned work packet and final message', async () => {
    let turn = 0;
    const yoloBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId, permission) => {
        turn += 1;
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text: turn === 1 ? 'Implemented and verified the assigned lane.' : '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'lane-reconciliation', agents: ['codex'] });
    const task = yoloBroker.createTask(room.id, { title: 'Infer lane completion' });
    yoloBroker.createTaskChecklistItem(room.id, task!.id, {
      title: 'Implement isolated lane',
      status: 'open',
    });

    await yoloBroker.startYoloDiscussion(room.id, 'human', {
      mode: 'edit',
      filesystemScope: 'task',
    });

    expect(listTaskChecklistItems(db, task!.id)).toMatchObject([
      {
        title: 'Implement isolated lane',
        status: 'done',
        ownerAgentId: 'codex',
        updatedBy: 'codex',
      },
    ]);
    const labels = listAgentRuns(db, room.id).flatMap((run) =>
      listAgentRunActions(db, run.id).map((action) => action.label),
    );
    expect(labels).toContain('mission work packet');
    expect(labels).toContain('reconciled lane completion');
    expect(labels).not.toContain('mission receipt missing');
  });

  it('flags active-mission replies that do not reconcile mission state', async () => {
    let turn = 0;
    const missingReceiptBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        turn += 1;
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text:
            turn === 1
              ? 'I finished the work described above.'
              : [
                  '/mission-receipt',
                  'status: no_update',
                  'summary: Repair turn acknowledged the missing mission receipt.',
                  '/end-mission-receipt',
                ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'missing-receipt', agents: ['claude'] });
    const task = missingReceiptBroker.createTask(room.id, { title: 'Missing receipt mission' });

    await missingReceiptBroker.postHumanMessage(room.id, 'human', '@claude execute the next item');

    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toContain('workflow contract repair');
    const runActions = listAgentRuns(db, room.id).flatMap((run) => listAgentRunActions(db, run.id));
    const missing = runActions.find((action) => action.label === 'mission receipt missing');
    expect(missing).toMatchObject({
      taskId: task!.id,
      status: 'failed',
    });
    expect(missing!.detail).toContain('without a /mission-receipt');
    expect(runActions.map((action) => action.label)).toContain(
      'workflow contract repair requested',
    );
    expect(runActions.map((action) => action.label)).toContain('mission receipt: no_update');
  });

  it('does not keep YOLO alive when workflow repair only restates an open work lane', async () => {
    const agentId = 'codex-principal-software';
    let itemId = '';
    const repairBroker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: prompt.includes('workflow contract repair')
            ? [
                '/mission-task',
                'action: update',
                `id: ${itemId}`,
                'status: open',
                'note: State receipt: dashboard rebuild remains open and active. No completion evidence yet.',
                '/end-mission-task',
              ].join('\n')
            : '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          codex: fakeSpec('codex', 'codex reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, {
      name: 'workflow-repair-loop',
      agentProfiles: [
        {
          id: agentId,
          providerId: 'codex',
          displayName: 'Temur',
          personaId: 'principal-software-engineer',
          personaName: 'Principal Software Engineer',
          personaSummary: '',
        },
      ],
      yoloAgents: [agentId],
    });
    const task = repairBroker.createTask(room.id, { title: 'Rebuild dashboard mission' });
    const item = repairBroker.createTaskChecklistItem(room.id, task!.id, {
      title: 'Rebuild dashboard',
      status: 'open',
      ownerAgentId: agentId,
    });
    itemId = item!.id;

    await repairBroker.startYoloDiscussion(room.id, 'human', {
      mode: 'edit',
      filesystemScope: 'task',
    });

    expect(runs).toHaveLength(2);
    expect(runs[0]!.agentId).toBe('codex');
    expect(runs[1]!.prompt).toContain('workflow contract repair');

    const agentRuns = listAgentRuns(db, room.id, { limit: 10 });
    expect(agentRuns).toHaveLength(2);
    expect(agentRuns.every((run) => run.agentId === agentId)).toBe(true);
    const runActions = agentRuns.flatMap((run) => listAgentRunActions(db, run.id));
    expect(
      runActions.filter((action) => action.label === 'workflow contract repair requested'),
    ).toHaveLength(1);
    expect(runActions.map((action) => action.label)).toContain('mission task update');

    const outcomes = listAgentTurnOutcomesForRoom(db, room.id, 10);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.progressed === false)).toBe(true);
    expect(listTaskChecklistItems(db, task!.id)).toMatchObject([
      {
        title: 'Rebuild dashboard',
        status: 'open',
        ownerAgentId: agentId,
      },
    ]);
  });

  it('retroactively associates existing checklist items with a new plan and phase', async () => {
    const retroBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            'Retrofit recorded.',
            '',
            '/mission-plan',
            'action: create',
            'title: Retrofit agreement',
            'status: active',
            'body:',
            '## Direction',
            'Organize existing work under explicit phase gates.',
            '/end-mission-plan',
            '',
            '/mission-phase',
            'action: create',
            'title: Discovery',
            'status: active',
            'gate: Existing work is classified under the agreed plan',
            '/end-mission-phase',
            '',
            '/mission-task',
            'action: update',
            'title: Classify legacy task',
            'phase: Discovery',
            'note: Attached legacy work to the new hierarchy.',
            '/end-mission-task',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'retro-mission-updates', agents: ['claude'] });
    const task = retroBroker.createTask(room.id, { title: 'Retrofit mission updates' });
    retroBroker.createTaskChecklistItem(room.id, task!.id, {
      title: 'Classify legacy task',
      status: 'open',
      sortOrder: 1,
    });

    await retroBroker.postHumanMessage(room.id, 'human', '@claude retrofit this');

    const [plan] = listTaskPlans(db, task!.id);
    const [phase] = listTaskPhases(db, task!.id);
    const [item] = listTaskChecklistItems(db, task!.id);
    expect(plan).toMatchObject({ title: 'Retrofit agreement', status: 'active' });
    expect(phase).toMatchObject({ title: 'Discovery', planId: plan!.id });
    expect(item).toMatchObject({
      title: 'Classify legacy task',
      planId: plan!.id,
      phaseId: phase!.id,
    });
  });

  it('auto-activates the next planned phase when an agent completes the current gate', async () => {
    const phaseBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            'Audit gate is complete; moving on.',
            '',
            '/mission-phase',
            'action: update',
            'title: Audit',
            'status: done',
            '@end-mission-phase',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'phase-auto-advance', agents: ['codex'] });
    const task = phaseBroker.createTask(room.id, { title: 'Advance phases' });
    phaseBroker.createTaskPhase(room.id, task!.id, {
      title: 'Audit',
      status: 'active',
      sortOrder: 1,
      gate: 'Audit merge is accepted',
    });
    phaseBroker.createTaskPhase(room.id, task!.id, {
      title: 'Implementation',
      status: 'planned',
      sortOrder: 2,
      gate: 'Implementation tasks are complete',
    });

    await phaseBroker.postHumanMessage(room.id, 'human', '@codex verify the audit gate');

    expect(listTaskPhases(db, task!.id)).toMatchObject([
      { title: 'Audit', status: 'done' },
      { title: 'Implementation', status: 'active' },
    ]);
    expect(
      listMessages(db, room.id)
        .map((message) => message.text)
        .join('\n'),
    ).not.toContain('/mission-phase');
    const [run] = listAgentRuns(db, room.id);
    expect(listAgentRunActions(db, run!.id).map((action) => action.label)).toEqual(
      expect.arrayContaining(['mission phase update', 'mission phase auto-advance']),
    );
  });

  it('resolves slug-style phase refs to the active duplicate phase', async () => {
    const phaseBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            'Live verification is complete.',
            '',
            '/mission-phase',
            'action: complete',
            'id: memo-first-live-verification',
            'status: done',
            'note: Acceptance evidence is recorded.',
            '/end-mission-phase',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'phase-slug-resolution', agents: ['claude'] });
    const task = phaseBroker.createTask(room.id, { title: 'Close duplicate phase' });
    const stalePhase = phaseBroker.createTaskPhase(room.id, task!.id, {
      title: 'Memo-first Live Verification',
      status: 'done',
      sortOrder: 1,
    });
    const activePhase = phaseBroker.createTaskPhase(room.id, task!.id, {
      title: 'Memo-first Live Verification',
      status: 'active',
      sortOrder: 2,
    });
    const nextPhase = phaseBroker.createTaskPhase(room.id, task!.id, {
      title: 'Post-ship Review',
      status: 'planned',
      sortOrder: 3,
    });

    await phaseBroker.postHumanMessage(room.id, 'human', '@claude close the live gate');

    const phases = listTaskPhases(db, task!.id);
    expect(phases.find((phase) => phase.id === stalePhase!.id)).toMatchObject({ status: 'done' });
    expect(phases.find((phase) => phase.id === activePhase!.id)).toMatchObject({ status: 'done' });
    expect(phases.find((phase) => phase.id === nextPhase!.id)).toMatchObject({ status: 'active' });

    const [run] = listAgentRuns(db, room.id);
    const actions = listAgentRunActions(db, run!.id);
    expect(actions.map((action) => action.label)).toEqual(
      expect.arrayContaining(['mission phase update', 'mission phase auto-advance']),
    );
    expect(actions.map((action) => action.label)).not.toContain('mission phase update ignored');
  });

  it('marks a checklist item done when an agent reports accepted completion evidence', async () => {
    const completionBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            'Audit merge accepted.',
            '',
            '/mission-task',
            'action: update',
            'title: Merge full strategy-doc audit',
            'note: Audit merge accepted by both agents; Phase 2 ownership and dependencies are settled.',
            '@end-mission-task',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'completion-mission-updates', agents: ['codex'] });
    const task = completionBroker.createTask(room.id, { title: 'Complete audit merge' });
    completionBroker.createTaskChecklistItem(room.id, task!.id, {
      title: 'Merge full strategy-doc audit',
      status: 'open',
      ownerAgentId: 'codex',
      sortOrder: 1,
    });

    await completionBroker.postHumanMessage(room.id, 'human', '@codex update status');

    const [item] = listTaskChecklistItems(db, task!.id);
    expect(item).toMatchObject({
      title: 'Merge full strategy-doc audit',
      status: 'done',
      ownerAgentId: 'codex',
      statusNote:
        'Audit merge accepted by both agents; Phase 2 ownership and dependencies are settled.',
      updatedBy: 'codex',
    });
    expect(item!.completedAt).toEqual(expect.any(Number));
    expect(
      listMessages(db, room.id)
        .map((message) => message.text)
        .join('\n'),
    ).not.toContain('/mission-task');
  });

  it('stores advanced run detail without bloating run summaries', async () => {
    const detailBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: 'diagnostic reply',
          sessionId: 'claude-session',
          raw: {
            stdout: JSON.stringify({
              result: 'diagnostic reply',
              session_id: 'claude-session',
              duration_ms: 123,
              usage: { server_tool_use: { web_fetch_requests: 1 } },
            }),
            stderr: 'minor warning',
          },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'details', agents: ['claude'] });

    await detailBroker.postHumanMessage(room.id, 'human', '@claude inspect this');

    const [summary] = detailBroker.listAgentRuns(room.id);
    expect(summary).toBeDefined();
    expect(summary as Record<string, unknown>).not.toHaveProperty('stdout');
    const detail = detailBroker.getAgentRunDetail(room.id, summary!.id);
    expect(detail).toBeDefined();
    expect(detail!.run).toMatchObject({
      replyText: 'diagnostic reply',
      stdout: expect.stringContaining('web_fetch_requests'),
      stderr: 'minor warning',
      cliSessionId: 'claude-session',
    });
    expect(detail!.run.promptText).toContain('@claude inspect this');
    expect(detail!.triggerMessage?.text).toBe('@claude inspect this');
    expect(detail!.replyMessage?.text).toBe('diagnostic reply');
    expect(detail!.diagnostics.signals.map((signal) => signal.label)).toContain(
      'web_fetch_requests',
    );
  });

  it('records collaboration ledger notes, strips them from chat, and exposes action timelines', async () => {
    const collaborationBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: [
            'I would challenge the current plan until we verify the broker path.',
            '',
            '/collab-note',
            'kind: challenge',
            'title: Broker follow-up path may be the real blocker',
            'target: approved permission execution',
            'status: open',
            'confidence: medium',
            'evidence: file:server/src/broker.ts:292; test:npm test',
            'body: Approval only helps if the broker immediately starts the approved agent turn.',
            '/end-collab-note',
          ].join('\n'),
          sessionId: 'claude-session',
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'alignment', agents: ['claude'] });

    await collaborationBroker.postHumanMessage(room.id, 'human', '@claude review direction');

    const messages = listMessages(db, room.id);
    expect(messages[1]!.text).toBe(
      'I would challenge the current plan until we verify the broker path.',
    );
    expect(messages[1]!.text).not.toContain('/collab-note');

    const items = collaborationBroker.listCollaborationItems(room.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'challenge',
      status: 'open',
      title: 'Broker follow-up path may be the real blocker',
      target: 'approved permission execution',
      evidence: ['file:server/src/broker.ts:292', 'test:npm test'],
    });

    expect(runs[0]!.prompt).toContain('Collaboration protocol');
    expect(runs[0]!.prompt).toContain('Do not agree merely to be agreeable');
    expect(runs[0]!.prompt).toContain('/collab-note');

    const actions = collaborationBroker.listAgentRunActions(room.id);
    expect(actions.map((action) => action.label)).toEqual(
      expect.arrayContaining([
        'prompt prepared',
        'agent process started',
        'agent process completed',
        'recorded challenge',
        'message emitted',
      ]),
    );

    const [summary] = collaborationBroker.listAgentRuns(room.id);
    const detail = collaborationBroker.getAgentRunDetail(room.id, summary!.id);
    expect(detail!.actions.map((action) => action.label)).toContain('recorded challenge');
  });

  it('feeds recent collaboration ledger items into later agent prompts', async () => {
    const replies = [
      [
        'Proposal: inspect the broker before changing adapters.',
        '',
        '/collab-note',
        'kind: proposal',
        'title: Inspect broker dispatch before adapter changes',
        'status: open',
        'confidence: high',
        'body: The symptom is cross-agent and likely lives above any single provider.',
        '/end-collab-note',
      ].join('\n'),
      'I agree with inspecting the broker first.',
    ];
    const ledgerBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: replies.shift() ?? '',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'ledger-context', agents: ['claude'] });

    await ledgerBroker.postHumanMessage(room.id, 'human', '@claude propose direction');
    await ledgerBroker.postHumanMessage(room.id, 'human', '@claude continue');

    expect(runs[1]!.prompt).toContain('Current collaboration ledger');
    expect(runs[1]!.prompt).toContain('Inspect broker dispatch before adapter changes');
  });

  it('uses task capability profiles as scoped per-turn permissions', async () => {
    const room = createRoom(db, { name: 'capability-room', agents: ['claude'] });
    broker.createTask(room.id, {
      title: 'Editable mission',
      repoPath: 'C:/work/project',
      capabilityProfile: 'edit',
    });

    await broker.postHumanMessage(room.id, 'human', '@claude make the change');

    expect(runs[0]!.permission).toMatchObject({
      mode: 'edit',
      target: 'C:/work/project',
    });
    expect(runs[0]!.prompt).toContain('Task capability profile: edit');
    expect(listAgentRuns(db, room.id)[0]).toMatchObject({
      permissionMode: 'edit',
      status: 'completed',
    });
  });

  it('keeps active mission participants in sync when room agents change', () => {
    const room = createRoom(db, { name: 'agent-sync', agents: ['claude', 'codex'] });
    const task = broker.createTask(room.id, {
      title: 'Active mission',
      agents: ['claude', 'codex'],
    });

    broker.setAgents(room.id, ['claude', 'codex', 'gemini']);

    expect(listTasks(db, room.id).find((candidate) => candidate.id === task!.id)?.agents).toEqual([
      'claude',
      'codex',
      'gemini',
    ]);
  });

  it('writes context files and sends only a bounded recent window in prompts', async () => {
    const contextDir = mkdtempSync(path.join(os.tmpdir(), 'fireside-context-test-'));
    const contextBroker = new Broker({
      db,
      maxHistory: 2,
      maxAgentRepliesPerThread: 1,
      contextDir,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: `${spec.id}-reply`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'ctx', agents: ['claude'] });

    await contextBroker.postHumanMessage(room.id, 'human', '@claude first');
    await contextBroker.postHumanMessage(room.id, 'human', 'second');
    await contextBroker.postHumanMessage(room.id, 'human', 'third');

    const prompt = runs[runs.length - 1]!.prompt;
    expect(prompt).not.toContain('@claude first');
    expect(prompt).toContain('second');
    expect(prompt).toContain('third');
    expect(prompt).toContain('earlier message(s) are omitted');
    expect(prompt).toContain('Recap file:');
    expect(prompt).toContain('Bounded transcript file:');

    const recapPath = prompt.match(/Recap file: (.+)/)?.[1];
    const transcriptPath = prompt.match(/Bounded transcript file: (.+)/)?.[1];
    expect(recapPath).toBeDefined();
    expect(transcriptPath).toBeDefined();
    expect(readFileSync(recapPath as string, 'utf8')).toContain('@claude first');
    expect(readFileSync(transcriptPath as string, 'utf8')).toContain('third');
  });

  it('stores oversized latest messages as artifacts while preserving the handoff inline', async () => {
    const contextDir = mkdtempSync(path.join(os.tmpdir(), 'fireside-artifact-test-'));
    const artifactBroker = new Broker({
      db,
      maxHistory: 2,
      maxPromptChars: 5_000,
      largeMessageThresholdChars: 1_000,
      maxAgentRepliesPerThread: 1,
      contextDir,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: `${spec.id}-reply`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'artifacts', agents: ['claude'] });
    const largeText = `@claude ${Array.from({ length: 900 }, (_, i) => `chunk-${i}`).join(' ')}`;

    await artifactBroker.postHumanMessage(room.id, 'human', largeText);

    const prompt = runs[0]!.prompt;
    expect(prompt.length).toBeLessThanOrEqual(13_000);
    expect(prompt).toContain('latest message was preserved in full');
    expect(prompt).toContain('Full latest message also stored outside the live prompt');
    expect(prompt).toContain(largeText);
    expect(prompt).not.toContain('[Large message stored outside the live prompt');

    const artifactPath = prompt.match(
      /Full latest message also stored outside the live prompt: \d+ chars at (.+)]/,
    )?.[1];
    expect(artifactPath).toBeDefined();
    expect(readFileSync(artifactPath as string, 'utf8')).toContain(largeText);
  });

  it('copies shared files into durable conversation fixtures and advertises them in prompts', async () => {
    const contextDir = mkdtempSync(path.join(os.tmpdir(), 'fireside-fixture-test-'));
    const sourceDir = mkdtempSync(path.join(os.tmpdir(), 'fireside-fixture-source-'));
    const sourcePath = path.join(sourceDir, 'notes.md');
    writeFileSync(sourcePath, '# Notes\n\nImportant fixture text.', 'utf8');
    const fixtureBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      contextDir,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: `${spec.id}-reply`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'fixtures', agents: ['claude'] });

    const fixture = fixtureBroker.attachFixture(room.id, sourcePath);
    expect(fixture?.sourcePath).toBe(sourcePath);
    expect(fixture?.storedPath).not.toBe(sourcePath);
    expect(readFileSync(fixture!.storedPath, 'utf8')).toContain('Important fixture text.');

    await fixtureBroker.postHumanMessage(room.id, 'human', `@claude read ${fixture!.storedPath}`);

    const prompt = runs[0]!.prompt;
    expect(prompt).toContain('Conversation fixtures: 1');
    expect(prompt).toContain('fixture manifest:');
    expect(prompt).toContain(fixture!.storedPath);
    expect(prompt).toContain('Important fixture text.');
    const artifacts = fixtureBroker.listArtifacts(room.id);
    expect(artifacts?.files.some((file) => file.kind === 'fixture')).toBe(true);
    expect(artifacts?.files.some((file) => file.kind === 'fixture-manifest')).toBe(true);
  });

  it('removes only removable context artifacts', () => {
    const contextDir = mkdtempSync(path.join(os.tmpdir(), 'fireside-remove-artifact-test-'));
    const sourceDir = mkdtempSync(path.join(os.tmpdir(), 'fireside-remove-artifact-source-'));
    const sourcePath = path.join(sourceDir, 'brief.md');
    writeFileSync(sourcePath, 'Temporary fixture text.', 'utf8');
    const artifactBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      contextDir,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return {
          text: `${spec.id}-reply`,
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'remove-artifacts', agents: ['claude'] });

    const fixture = artifactBroker.attachFixture(room.id, sourcePath);
    expect(fixture).not.toBeNull();
    expect(existsSync(fixture!.storedPath)).toBe(true);
    expect(artifactBroker.removeArtifact(room.id, 'fixture', fixture!.storedPath)).toBe(true);
    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(fixture!.storedPath)).toBe(false);
    expect(
      artifactBroker.listArtifacts(room.id)?.files.some((file) => file.kind === 'fixture'),
    ).toBe(false);

    const draftPath = path.join(contextDir, room.id, 'drafts', 'candidate.md');
    mkdirSync(path.dirname(draftPath), { recursive: true });
    writeFileSync(draftPath, '# Candidate draft\n', 'utf8');
    expect(artifactBroker.removeArtifact(room.id, 'draft-artifact', draftPath)).toBe(true);
    expect(existsSync(draftPath)).toBe(false);
    expect(() =>
      artifactBroker.removeArtifact(
        room.id,
        'message-artifact',
        path.join(contextDir, room.id, 'artifacts.md'),
      ),
    ).toThrow(/cannot be removed/);
  });

  it('turns an agent permission request into a one-turn approved permission grant', async () => {
    const permissionBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId, permission) => {
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text: permission
            ? 'edited foobar.txt'
            : [
                '/permission-request',
                'mode: edit',
                'target: foobar.txt',
                'reason: I need to write the file we discussed.',
              ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'permissions', agents: ['claude'] });

    await permissionBroker.postHumanMessage(room.id, 'human', '@claude edit foobar.txt');

    let requests = listPermissionRequests(db, room.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      agentId: 'claude',
      mode: 'edit',
      target: 'foobar.txt',
      status: 'pending',
    });
    expect(listMessages(db, room.id).map((m) => m.authorId)).toEqual(['human']);

    const resolved = permissionBroker.resolvePermissionRequest(
      requests[0]!.id,
      'approved',
      'human',
    );
    expect(resolved).toMatchObject({ status: 'approved', decidedBy: 'human' });
    await new Promise((resolve) => setTimeout(resolve, 25));

    requests = listPermissionRequests(db, room.id);
    expect(requests[0]).toMatchObject({ status: 'approved', decidedBy: 'human' });
    expect(runs[1]!.permission).toMatchObject({
      mode: 'edit',
      target: 'foobar.txt',
      reason: 'I need to write the file we discussed.',
    });
    expect(runs[1]!.prompt).toContain('Approved tool permission for this turn: edit');
    expect(runs[1]!.prompt.match(/Permission approved for claude/g) ?? []).toHaveLength(1);
    const messageLines = listMessages(db, room.id).map((m) => `${m.authorId}:${m.text}`);
    expect(messageLines).toHaveLength(4);
    expect(messageLines[0]).toBe('human:@claude edit foobar.txt');
    expect(messageLines[1]).toContain(
      'system:Permission approved for claude: edit access to foobar.txt.',
    );
    expect(messageLines[1]).toContain('Effective capabilities:');
    expect(messageLines.slice(2)).toEqual([
      'system:(claude started approved edit turn for foobar.txt.)',
      'claude:edited foobar.txt',
    ]);
  });

  it('routes a visible handoff after an approved permission follow-up', async () => {
    let turn = 0;
    const permissionBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId, permission) => {
        turn += 1;
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text:
            turn === 1
              ? [
                  '/permission-request',
                  'mode: edit',
                  'target: foobar.txt',
                  'reason: I need to write the file we discussed.',
                ].join('\n')
              : turn === 2
                ? 'Edited foobar.txt. Codex, please verify the result.'
                : 'Verified the result.',
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'permission-handoff', agents: ['claude', 'codex'] });

    await permissionBroker.postHumanMessage(room.id, 'human', '@claude edit foobar.txt');
    const request = listPermissionRequests(db, room.id)[0];
    expect(request).toBeDefined();

    permissionBroker.resolvePermissionRequest(request!.id, 'approved', 'human');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runs.map((r) => r.agentId)).toEqual(['claude', 'claude', 'codex']);
    expect(listMessages(db, room.id).map((m) => `${m.authorId}:${m.text}`)).toContain(
      'codex:Verified the result.',
    );
  });

  it('creates a permission card from an embedded permission request and keeps surrounding text visible', async () => {
    const permissionBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId, permission) => {
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text: [
            'Understood - one at a time. Here is the first:',
            '',
            '/permission-request',
            'mode: edit',
            'target: docs/admin-deploy.md',
            'reason: Write the canonical admin deploy runbook.',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'embedded-permission', agents: ['claude'] });

    await permissionBroker.postHumanMessage(room.id, 'human', '@claude request one permission');

    const requests = listPermissionRequests(db, room.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      mode: 'edit',
      target: 'docs/admin-deploy.md',
      reason: 'Write the canonical admin deploy runbook.',
    });
    expect(listMessages(db, room.id).map((m) => `${m.authorId}:${m.text}`)).toEqual([
      'human:@claude request one permission',
      'claude:Understood - one at a time. Here is the first:',
    ]);
    expect(permissionBroker.listAgentRuns(room.id)[0]).toMatchObject({
      status: 'permission-requested',
      replyMessageId: expect.any(String),
    });
  });

  it('normalizes embedded write permission requests into edit permission cards', async () => {
    const permissionBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId, permission) => {
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text: [
            'Blocked. The approved permission was edit, but this is a new file.',
            '',
            'Re-requesting with the right mode:',
            '',
            '/permission-request',
            'mode: write',
            'target: docs/runbooks/admin-deploy.md',
            'reason: Create the canonical source-of-truth runbook.',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'write-permission', agents: ['claude'] });

    await permissionBroker.postHumanMessage(room.id, 'human', '@claude create the runbook');

    const requests = listPermissionRequests(db, room.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      mode: 'edit',
      target: 'docs/runbooks/admin-deploy.md',
      reason: 'Create the canonical source-of-truth runbook.',
    });
    expect(listMessages(db, room.id).map((m) => `${m.authorId}:${m.text}`)).toEqual([
      'human:@claude create the runbook',
      'claude:Blocked. The approved permission was edit, but this is a new file.\n\nRe-requesting with the right mode:',
    ]);
    expect(permissionBroker.listAgentRuns(room.id)[0]).toMatchObject({
      status: 'permission-requested',
      replyMessageId: expect.any(String),
    });
  });

  it('creates a permission card for embedded bash command requests', async () => {
    const permissionBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId, permission) => {
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text: [
            'Edits landed. Requesting the next scope now.',
            '',
            '/permission-request',
            'mode: bash',
            'target: C:\\workspaces\\licensing',
            'reason: Stage and commit the tightened runbook. Exact commands: git -C "C:\\workspaces\\licensing" add docs/runbooks/admin-deploy.md then git -C "C:\\workspaces\\licensing" commit -m "docs(licensing): add wm-license-contract/v1 admin-deploy runbook". No push.',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'bash-permission', agents: ['claude'] });

    await permissionBroker.postHumanMessage(room.id, 'human', '@claude commit the runbook');

    const requests = listPermissionRequests(db, room.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      mode: 'full-auto',
      requestedMode: 'bash',
      target: 'C:\\workspaces\\licensing',
      capabilities: expect.arrayContaining(['read', 'run-command', 'git-commit']),
      providerProfile: expect.stringContaining('allowed Bash(git *)'),
    });
    expect(requests[0]!.capabilities).not.toContain('git-push');
    expect(listMessages(db, room.id).map((m) => `${m.authorId}:${m.text}`)).toEqual([
      'human:@claude commit the runbook',
      'claude:Edits landed. Requesting the next scope now.',
    ]);
  });

  it('stores hidden draft artifacts before permission approval', async () => {
    const contextDir = mkdtempSync(path.join(os.tmpdir(), 'fireside-draft-artifacts-'));
    const permissionBroker = new Broker({
      db,
      contextDir,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId, permission) => {
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text: [
            'I have the runbook drafted and need permission to write it.',
            '/draft-artifact',
            'name: admin-deploy.md',
            'target: docs/runbooks/admin-deploy.md',
            'content:',
            '# Admin Deploy',
            '',
            'Canonical body.',
            '/end-draft-artifact',
            '/permission-request',
            'mode: write',
            'target: docs/runbooks/admin-deploy.md',
            'reason: Create the canonical source-of-truth runbook.',
          ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'draft-permission', agents: ['claude'] });

    await permissionBroker.postHumanMessage(room.id, 'human', '@claude draft then request');

    const requests = listPermissionRequests(db, room.id);
    expect(requests).toHaveLength(1);
    const artifacts = permissionBroker.listArtifacts(room.id);
    expect(artifacts?.files.some((file) => file.kind === 'draft-artifact')).toBe(true);
    const draftDir = path.join(contextDir, room.id, 'drafts');
    expect(readdirSync(draftDir).some((name) => name.includes('admin-deploy.md'))).toBe(true);
    expect(listMessages(db, room.id).map((m) => m.text)).toEqual([
      '@claude draft then request',
      'I have the runbook drafted and need permission to write it.',
    ]);
    expect(permissionBroker.listAgentRunActions(room.id).map((action) => action.label)).toContain(
      'draft artifact stored',
    );
  });

  it('records when an approved permission follow-up produces no visible reply', async () => {
    const permissionBroker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      runAgent: async (spec, prompt, sessionId, permission) => {
        runs.push({
          agentId: spec.id,
          prompt,
          sessionId,
          ...(permission !== undefined ? { permission } : {}),
        });
        return {
          text: permission
            ? ''
            : [
                '/permission-request',
                'mode: edit',
                'target: foobar.txt',
                'reason: I need to write the file we discussed.',
              ].join('\n'),
          sessionId: `${spec.id}-sess`,
          raw: { stdout: '', stderr: '' },
        };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
    const room = createRoom(db, { name: 'permissions-empty', agents: ['claude'] });

    await permissionBroker.postHumanMessage(room.id, 'human', '@claude edit foobar.txt');
    const [request] = listPermissionRequests(db, room.id);
    expect(request).toBeDefined();

    permissionBroker.resolvePermissionRequest(request!.id, 'approved', 'human');
    await new Promise((resolve) => setTimeout(resolve, 25));

    const messageLines = listMessages(db, room.id).map((m) => `${m.authorId}:${m.text}`);
    expect(messageLines).toHaveLength(4);
    expect(messageLines[0]).toBe('human:@claude edit foobar.txt');
    expect(messageLines[1]).toContain(
      'system:Permission approved for claude: edit access to foobar.txt.',
    );
    expect(messageLines[1]).toContain('Effective capabilities:');
    expect(messageLines.slice(2)).toEqual([
      'system:(claude started approved edit turn for foobar.txt.)',
      'system:(claude finished the approved edit follow-up without a visible chat message.)',
    ]);
  });

  describe('recheckProviderQuota', () => {
    it('force-unblocks non-Gemini providers and reports cleared count', async () => {
      const room = createRoom(db, { name: 'g', agents: ['claude'] });
      const trigger = addMessage(db, {
        roomId: room.id,
        authorId: 'human',
        authorKind: 'human',
        text: 'go',
      });
      const run = createAgentRun(db, {
        roomId: room.id,
        triggerMessageId: trigger.id,
        agentId: 'claude',
        permissionMode: 'plan',
        promptChars: 0,
        estimatedPromptTokens: 0,
        liveMessages: 0,
        contextArtifacts: 0,
      });
      const { createAgentRunAction } = await import('../../src/repos/run-actions.js');
      createAgentRunAction(db, {
        roomId: room.id,
        runId: run.id,
        agentId: 'claude',
        kind: 'diagnostic',
        status: 'failed',
        label: 'claude rate limit',
        contextUsage: {
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          usedTokens: 0,
          quotaOnly: true,
          quota: {
            fiveHour: { percent: 100, resetsAt: Date.now() + 60_000, status: 'exhausted' },
            source: 'claude:rate-limit',
          },
          source: 'claude:rate-limit',
        },
      });

      const result = await broker.recheckProviderQuota('claude');
      expect(result.ok).toBe(true);
      expect(result.cleared).toBe(1);
    });

    it('reports no-op when there is nothing to clear', async () => {
      const result = await broker.recheckProviderQuota('claude');
      expect(result.ok).toBe(true);
      expect(result.cleared).toBe(0);
      expect(result.detail).toContain('no active block');
    });

    it('Gemini probe with fresh quota clears existing blocks', async () => {
      const { resetGeminiStatsSamplerForTesting } = await import(
        '../../src/agents/gemini-quota.js'
      );
      resetGeminiStatsSamplerForTesting();
      const room = createRoom(db, { name: 'g', agents: ['gemini'] });
      const trigger = addMessage(db, {
        roomId: room.id,
        authorId: 'human',
        authorKind: 'human',
        text: 'go',
      });
      const run = createAgentRun(db, {
        roomId: room.id,
        triggerMessageId: trigger.id,
        agentId: 'gemini',
        permissionMode: 'plan',
        promptChars: 0,
        estimatedPromptTokens: 0,
        liveMessages: 0,
        contextArtifacts: 0,
      });
      const { createAgentRunAction } = await import('../../src/repos/run-actions.js');
      createAgentRunAction(db, {
        roomId: room.id,
        runId: run.id,
        agentId: 'gemini',
        kind: 'diagnostic',
        status: 'failed',
        label: 'gemini terminal quota',
        contextUsage: {
          provider: 'gemini',
          model: 'gemini-2.5-pro',
          usedTokens: 0,
          quotaOnly: true,
          quota: {
            daily: { percent: 100, resetsAt: Date.now() + 60_000, status: 'limited' },
            source: 'gemini:terminal-quota',
          },
          source: 'gemini:terminal-quota',
        },
      });

      // Probe response that parses to "fresh quota" — usage with no terminal
      // quota markers and an under-cap percent.
      const freshOutput = [
        'Model: gemini-2.5-pro',
        '5h quota: 12% used (resets in 4h)',
        '7d quota: 8% used (resets in 6d)',
      ].join('\n');

      const result = await broker.recheckProviderQuota('gemini', {
        runStatsModel: async () => freshOutput,
      });
      expect(result.ok).toBe(true);
      // The recheck cleared the stale gemini block.
      expect(result.cleared).toBeGreaterThanOrEqual(0);
    });

    it('Gemini probe with still-exhausted quota leaves the block in place', async () => {
      const { resetGeminiStatsSamplerForTesting } = await import(
        '../../src/agents/gemini-quota.js'
      );
      resetGeminiStatsSamplerForTesting();
      const exhaustedOutput =
        'TerminalQuotaError: you have exhausted your capacity on this model. quota will reset in 4h.';

      const result = await broker.recheckProviderQuota('gemini', {
        runStatsModel: async () => exhaustedOutput,
      });
      expect(result.ok).toBe(false);
      expect(result.cleared).toBe(0);
      expect(result.status).toBeDefined();
    });
  });
});
