import { describe, expect, it } from 'vitest';
import { Broker } from '../../src/broker.js';
import { openDatabase } from '../../src/db.js';
import { addMessage } from '../../src/repos/messages.js';
import { createAgentRun, updateAgentRun } from '../../src/repos/agent-runs.js';
import { createAgentRunAction, listAgentRunActionsForRoom } from '../../src/repos/run-actions.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { createTaskPhase } from '../../src/repos/task-phases.js';
import { createTaskPlan } from '../../src/repos/task-plans.js';
import { createTaskChecklistItem } from '../../src/repos/task-checklist.js';
import { getCliSessionId, upsertCliSessionId } from '../../src/repos/sessions.js';
import { listAgentTurnOutcomesForRoom } from '../../src/repos/turn-outcomes.js';
import type { AgentId, AgentSpec } from '../../src/agents/types.js';

function fakeSpec(id: AgentId): AgentSpec {
  return {
    id,
    displayName: id,
    command: 'fake-agent',
    defaultTimeoutMs: 1000,
    buildArgs: () => [],
    parseOutput: () => ({ text: '', sessionId: null, raw: { stdout: '', stderr: '' } }),
  };
}

describe('lead reset + rehydration end-to-end', () => {
  it('resets the lead session at the lower threshold, prepends rehydration, classifies post-reset.first-turn', async () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, {
      name: 'lead-reset',
      agents: ['lead'],
      leadAgentId: 'lead',
      agentProfiles: [
        {
          id: 'lead',
          providerId: 'codex',
          displayName: 'Lead',
          personaId: 'principal',
          personaName: 'Principal',
          personaSummary: '',
          modelId: 'gpt-5.5',
          autoCompactPercent: 55,
        },
      ],
    });
    const task = createTask(db, { roomId: room.id, title: 'Implement savings plan' });
    createTaskPhase(db, { taskId: task.id, title: 'Reset trigger', status: 'active' });
    const plan = createTaskPlan(db, {
      taskId: task.id,
      title: 'Locked plan',
      body: 'Step 1 deterministic lead reset. Step 2 bounded rehydration.',
      status: 'active',
    });
    createTaskChecklistItem(db, {
      taskId: task.id,
      planId: plan.id,
      title: 'Wire lead reset',
      ownerAgentId: 'lead',
    });

    upsertCliSessionId(db, room.id, 'lead', 'pre-reset-session', 'codex');
    const priorTrigger = addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: '@lead prior',
    });
    const priorRun = createAgentRun(db, {
      roomId: room.id,
      taskId: task.id,
      triggerMessageId: priorTrigger.id,
      agentId: 'lead',
      permissionMode: 'plan',
      promptChars: 20,
      estimatedPromptTokens: 5,
      liveMessages: 1,
      contextArtifacts: 0,
    });
    updateAgentRun(db, priorRun.id, {
      status: 'completed',
      completedAt: Date.now(),
      cliSessionId: 'pre-reset-session',
    });
    // Seed context usage well above the lead reset threshold (60% of 220k = 132k).
    createAgentRunAction(db, {
      roomId: room.id,
      runId: priorRun.id,
      agentId: 'lead',
      kind: 'adapter',
      status: 'completed',
      label: 'codex turn completed',
      detail: 'context usage',
      contextUsage: {
        provider: 'codex',
        model: 'gpt-5.5',
        usedTokens: 200_000,
        inputTokens: 200_000,
        outputTokens: 0,
        cachedInputTokens: 0,
        contextWindow: 400_000,
        source: 'codex:usage',
      },
    });

    const calls: Array<{ prompt: string; sessionId: string | null }> = [];
    const broker = new Broker({
      db,
      maxAgentRepliesPerThread: 1,
      resumeCliSessions: true,
      autoCompactEnabled: true,
      autoCompactTokenLimit: 220_000,
      leadResetPercent: 60,
      getSpec: (id) => (id === 'codex' ? fakeSpec('codex') : undefined),
      runAgent: async (_spec, prompt, sessionId) => {
        calls.push({ prompt, sessionId });
        return {
          text: 'lead reply after reset',
          sessionId: 'fresh-session',
          raw: { stdout: '{"ok":true}', stderr: '' },
        };
      },
    });

    await broker.postHumanMessage(room.id, 'human', '@lead proceed');

    // The first provider call is the post-reset turn. No /compact path fires.
    // Subsequent broker activity (workflow repair, follow-up dispatch) is out of
    // scope for this assertion — only the post-reset first turn is what Lane 2A
    // needs to prove.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.sessionId).toBeNull();
    expect(calls[0]!.prompt.startsWith('/lead-rehydration')).toBe(true);
    expect(calls[0]!.prompt).toContain('Mission: Implement savings plan');
    expect(calls[0]!.prompt).toContain('Current phase: Reset trigger');
    expect(calls[0]!.prompt).toContain('/end-lead-rehydration');
    // The /compact prompt must NOT appear for the lead under default (lead-reset enabled).
    expect(calls.map((call) => call.prompt)).not.toContain('/compact');

    // Pre-reset session was cleared; the broker stored the new fresh session id.
    expect(getCliSessionId(db, room.id, 'lead')).toBe('fresh-session');

    const labels = listAgentRunActionsForRoom(db, room.id).map((action) => action.label);
    expect(labels).toEqual(expect.arrayContaining(['context session reset']));

    const outcomes = listAgentTurnOutcomesForRoom(db, room.id);
    const postResetOutcome = outcomes.find(
      (outcome) => outcome.runKind === 'post-reset.first-turn',
    );
    expect(postResetOutcome).toBeDefined();
    expect(postResetOutcome?.agentId).toBe('lead');
    db.close();
  });

  it('honors FIRESIDE_LEAD_RESET_DISABLED via leadResetDisabled and falls back to /compact for the lead', async () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, {
      name: 'lead-reset-off',
      agents: ['lead'],
      leadAgentId: 'lead',
      agentProfiles: [
        {
          id: 'lead',
          providerId: 'codex',
          displayName: 'Lead',
          personaId: 'principal',
          personaName: 'Principal',
          personaSummary: '',
          modelId: 'gpt-5.5',
          autoCompactPercent: 55,
        },
      ],
    });
    upsertCliSessionId(db, room.id, 'lead', 'session-1', 'codex');
    const priorTrigger = addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: '@lead prior',
    });
    const priorRun = createAgentRun(db, {
      roomId: room.id,
      triggerMessageId: priorTrigger.id,
      agentId: 'lead',
      permissionMode: 'plan',
      promptChars: 20,
      estimatedPromptTokens: 5,
      liveMessages: 1,
      contextArtifacts: 0,
    });
    updateAgentRun(db, priorRun.id, {
      status: 'completed',
      completedAt: Date.now(),
      cliSessionId: 'session-1',
    });
    createAgentRunAction(db, {
      roomId: room.id,
      runId: priorRun.id,
      agentId: 'lead',
      kind: 'adapter',
      status: 'completed',
      label: 'codex turn completed',
      detail: 'context usage',
      contextUsage: {
        provider: 'codex',
        model: 'gpt-5.5',
        usedTokens: 240_000,
        inputTokens: 240_000,
        outputTokens: 0,
        cachedInputTokens: 0,
        contextWindow: 400_000,
        source: 'codex:usage',
      },
    });

    const calls: Array<{ prompt: string; sessionId: string | null }> = [];
    const broker = new Broker({
      db,
      resumeCliSessions: true,
      autoCompactEnabled: true,
      autoCompactTokenLimit: 220_000,
      leadResetPercent: 60,
      leadResetDisabled: true,
      getSpec: (id) => (id === 'codex' ? fakeSpec('codex') : undefined),
      runAgent: async (_spec, prompt, sessionId) => {
        calls.push({ prompt, sessionId });
        return {
          text: prompt === '/compact' ? 'Compacted.' : 'Ready.',
          sessionId: 'session-2',
          raw: { stdout: '{"ok":true}', stderr: '' },
        };
      },
    });

    await broker.postHumanMessage(room.id, 'human', '@lead go');

    // Kill-switch on: legacy /compact path runs first, then the actual turn.
    expect(calls.map((call) => call.prompt)).toEqual([
      '/compact',
      expect.stringContaining('@lead go'),
    ]);
    db.close();
  });
});
