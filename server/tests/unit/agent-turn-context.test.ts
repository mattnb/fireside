import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db.js';
import { addMessage } from '../../src/repos/messages.js';
import { createAgentRun } from '../../src/repos/agent-runs.js';
import { recordAgentTurnOutcome } from '../../src/repos/turn-outcomes.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { prepareAgentTurnContext } from '../../src/orchestration/agent-turn-context.js';
import { classifyWorkflowRepairCollapse } from '../../src/orchestration/workflow-repair-collapse.js';

describe('agent turn context assembly', () => {
  it('assembles bounded prompt context, active task context, and task permission grants', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'room', agents: ['codex'] });
    addMessage(db, {
      roomId: room.id,
      authorId: 'matt',
      authorKind: 'human',
      text: 'previous context',
    });
    const trigger = addMessage(db, {
      roomId: room.id,
      authorId: 'matt',
      authorKind: 'human',
      text: 'please work',
    });
    const task = createTask(db, {
      roomId: room.id,
      title: 'Mission',
      repoPath: 'C:/work/project',
      capabilityProfile: 'edit',
      agents: ['codex'],
    });

    const prepared = prepareAgentTurnContext({
      db,
      room,
      agentId: 'codex',
      trigger,
      maxHistory: 8,
      maxPromptChars: 16_000,
      sessionPolicy: 'ephemeral',
      getResumableCliSessionId: () => 'session',
      loadWorkflowProfileForTask: () => null,
      buildTaskControl: () => ({
        currentPhase: null,
        openChecklistItems: [],
        blockedChecklistItems: [],
        activePlan: null,
      }),
      workflowWorkspacePath: () => '',
      workflowProfilePromptItem: () => undefined,
      workLanePromptItem: (item) => ({
        id: item.id,
        title: item.title,
        detail: item.detail,
        status: item.status,
        planId: item.planId,
        phaseId: item.phaseId,
      }),
    });

    expect(prepared.activeTask?.id).toBe(task.id);
    expect(prepared.taskContext).toMatchObject({
      title: 'Mission',
      repoPath: 'C:/work/project',
    });
    expect(prepared.effectivePermission).toMatchObject({
      source: 'task',
      mode: 'edit',
      target: 'C:/work/project',
    });
    expect(prepared.prompt).toContain('Mission');
    expect(prepared.promptStats.historyMessagesIncluded).toBe(1);
    expect(prepared.sessionId).toBeNull();
  });

  it('keeps an oversized latest message inline while preserving its artifact path', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'room', agents: ['codex'] });
    addMessage(db, {
      roomId: room.id,
      authorId: 'matt',
      authorKind: 'human',
      text: 'previous context',
    });
    const longLatest = [
      'BEGIN-LATEST',
      'a'.repeat(120),
      'MIDDLE-LATEST-SENTINEL',
      'b'.repeat(120),
      'END-LATEST',
    ].join('\n');
    const trigger = addMessage(db, {
      roomId: room.id,
      authorId: 'claude',
      authorKind: 'agent',
      text: longLatest,
    });
    const contextDir = mkdtempSync(path.join(os.tmpdir(), 'fireside-agent-context-'));

    const prepared = prepareAgentTurnContext({
      db,
      room,
      agentId: 'codex',
      trigger,
      maxHistory: 8,
      maxPromptChars: 16_000,
      contextDir,
      largeMessageThresholdChars: 80,
      artifactExcerptChars: 40,
      sessionPolicy: 'ephemeral',
      getResumableCliSessionId: () => null,
      loadWorkflowProfileForTask: () => null,
      buildTaskControl: () => ({
        currentPhase: null,
        openChecklistItems: [],
        blockedChecklistItems: [],
        activePlan: null,
      }),
      workflowWorkspacePath: () => '',
      workflowProfilePromptItem: () => undefined,
      workLanePromptItem: (item) => ({
        id: item.id,
        title: item.title,
        detail: item.detail,
        status: item.status,
        planId: item.planId,
        phaseId: item.phaseId,
      }),
    });

    expect(prepared.contextArtifactCount).toBe(1);
    expect(prepared.prompt).toContain('MIDDLE-LATEST-SENTINEL');
    expect(prepared.prompt).toContain('END-LATEST');
    expect(prepared.prompt).toContain('Full latest message also stored outside the live prompt');
    expect(prepared.prompt).not.toContain('[Large message stored outside the live prompt');
  });

  it('accounts for lead rehydration in prompt stats after prepending it', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'room', agents: ['codex'] });
    addMessage(db, {
      roomId: room.id,
      authorId: 'matt',
      authorKind: 'human',
      text: 'previous context',
    });
    const trigger = addMessage(db, {
      roomId: room.id,
      authorId: 'matt',
      authorKind: 'human',
      text: 'please work',
    });
    const leadRehydrationBlock = [
      '/lead-rehydration',
      'Mission: prompt accounting',
      'Recent worker outcomes: none',
      '/end-lead-rehydration',
    ].join('\n');

    const common = {
      db,
      room,
      agentId: 'codex',
      trigger,
      maxHistory: 8,
      maxPromptChars: 16_000,
      sessionPolicy: 'ephemeral',
      getResumableCliSessionId: () => null,
      loadWorkflowProfileForTask: () => null,
      buildTaskControl: () => ({
        currentPhase: null,
        openChecklistItems: [],
        blockedChecklistItems: [],
        activePlan: null,
      }),
      workflowWorkspacePath: () => '',
      workflowProfilePromptItem: () => undefined,
      workLanePromptItem: (item) => ({
        id: item.id,
        title: item.title,
        detail: item.detail,
        status: item.status,
        planId: item.planId,
        phaseId: item.phaseId,
      }),
    } satisfies Parameters<typeof prepareAgentTurnContext>[0];
    const withoutRehydration = prepareAgentTurnContext(common);
    const prepared = prepareAgentTurnContext({
      ...common,
      leadRehydrationBlock,
    });
    const leadSection = prepared.promptStats.sections[0];

    expect(prepared.prompt).toBe(`${leadRehydrationBlock}\n\n${withoutRehydration.prompt}`);
    expect(prepared.promptStats.promptChars).toBe(prepared.prompt.length);
    expect(prepared.promptStats.estimatedPromptTokens).toBe(Math.ceil(prepared.prompt.length / 4));
    expect(leadSection).toMatchObject({
      id: 'leadRehydration',
      label: 'Lead rehydration block',
      chars: leadRehydrationBlock.length + 2,
      estimatedTokens: Math.ceil((leadRehydrationBlock.length + 2) / 4),
      stablePrefix: false,
      alwaysIncludedContext: true,
    });
    expect(prepared.promptStats.alwaysIncludedContextChars).toBe(
      withoutRehydration.promptStats.alwaysIncludedContextChars + leadRehydrationBlock.length + 2,
    );
    expect(prepared.promptStats.stablePrefixChars).toBe(0);
    expect(prepared.promptStats.stablePrefixEstimatedTokens).toBe(0);
    expect(prepared.promptStats.sections.filter((section) => section.stablePrefix)).toEqual([]);
  });
});

const REPAIR_BODY_VERBOSE =
  '(fireside workflow contract repair for codex: run rEPaiR-001)\n\n' +
  'Mission Control needs a state receipt for mission "Test mission".\n' +
  'Emit only the missing hidden Mission Control block(s). No visible prose.\n\n' +
  'Required options:\n' +
  '- If assigned checklist work completed or blocked, emit /mission-task with action: update.\n' +
  'Examples:\n' +
  '/mission-task\naction: update\nid: <checklist-item-id>\nstatus: done\nnote: <evidence>\n/end-mission-task\n' +
  'Violations: active mission turn produced no mission receipt';

interface RepairScenarioFixtures {
  triggerId: string;
  runId: string;
}

function seedRepairScenario(
  db: ReturnType<typeof openDatabase>,
  opts: {
    roomId: string;
    agentId: string;
    body?: string;
    satisfied: boolean;
  },
): RepairScenarioFixtures {
  const trigger = addMessage(db, {
    roomId: opts.roomId,
    authorId: 'system',
    authorKind: 'system',
    text: opts.body ?? REPAIR_BODY_VERBOSE,
  });
  const reply = addMessage(db, {
    roomId: opts.roomId,
    authorId: opts.agentId,
    authorKind: 'agent',
    text: '/mission-receipt\nstatus: no_update\nsummary: ack\n/end-mission-receipt',
  });
  const run = createAgentRun(db, {
    roomId: opts.roomId,
    triggerMessageId: trigger.id,
    agentId: opts.agentId,
    permissionMode: 'edit',
    promptChars: 1000,
    estimatedPromptTokens: 250,
    liveMessages: 5,
    contextArtifacts: 0,
  });
  recordAgentTurnOutcome(db, {
    roomId: opts.roomId,
    runId: run.id,
    agentId: opts.agentId,
    visibleMessageId: opts.satisfied ? reply.id : null,
    visibleMessageEmitted: opts.satisfied,
    status: opts.satisfied ? 'completed' : 'empty',
    progressed: opts.satisfied,
    failed: !opts.satisfied,
    missionReceipts: opts.satisfied ? 1 : 0,
    runKind: 'workflow.repair',
  });
  return { triggerId: trigger.id, runId: run.id };
}

describe('workflow-repair transcript collapse', () => {
  it('preserves a single unresolved repair verbatim', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'room', agents: ['codex'] });
    const repair = seedRepairScenario(db, {
      roomId: room.id,
      agentId: 'codex',
      satisfied: false,
    });
    const messages = [
      { id: repair.triggerId, authorKind: 'system' as const },
    ].map(({ id }) => ({
      id,
      roomId: room.id,
      authorId: 'system',
      authorKind: 'system' as const,
      text: REPAIR_BODY_VERBOSE,
      createdAt: 0,
      deliveryStatus: 'delivered' as const,
      seenBy: [],
    }));
    const result = classifyWorkflowRepairCollapse(db, messages);
    expect(result.classifiedIds).toEqual([repair.triggerId]);
    expect(result.collapsedText.size).toBe(0);
  });

  it('collapses a satisfied repair to a one-line marker', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'room', agents: ['codex'] });
    const repair = seedRepairScenario(db, {
      roomId: room.id,
      agentId: 'codex',
      satisfied: true,
    });
    const messages = [
      {
        id: repair.triggerId,
        roomId: room.id,
        authorId: 'system',
        authorKind: 'system' as const,
        text: REPAIR_BODY_VERBOSE,
        createdAt: 1_700_000_000_000,
        deliveryStatus: 'delivered' as const,
        seenBy: [],
      },
    ];
    const result = classifyWorkflowRepairCollapse(db, messages);
    expect(result.classifiedIds).toEqual([repair.triggerId]);
    const marker = result.collapsedText.get(repair.triggerId);
    expect(marker).toBeDefined();
    expect(marker).toContain('workflow-repair @');
    expect(marker).toContain('status=satisfied');
    expect(marker).toContain(`trigger=${repair.triggerId}`);
    expect(marker!.length).toBeLessThan(REPAIR_BODY_VERBOSE.length / 2);
  });

  it('classifies via DB join, not message text — wording change still collapses', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'room', agents: ['codex'] });
    const repair = seedRepairScenario(db, {
      roomId: room.id,
      agentId: 'codex',
      satisfied: true,
      body: 'Different wording entirely. Mission Control wants something. (no header)',
    });
    const messages = [
      {
        id: repair.triggerId,
        roomId: room.id,
        authorId: 'system',
        authorKind: 'system' as const,
        text: 'Different wording entirely. Mission Control wants something. (no header)',
        createdAt: 1_700_000_000_000,
        deliveryStatus: 'delivered' as const,
        seenBy: [],
      },
    ];
    const result = classifyWorkflowRepairCollapse(db, messages);
    expect(result.classifiedIds).toEqual([repair.triggerId]);
    expect(result.collapsedText.has(repair.triggerId)).toBe(true);
  });

  it('keeps only the most recent unresolved repair full when several stack', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'room', agents: ['codex'] });
    const r1 = seedRepairScenario(db, { roomId: room.id, agentId: 'codex', satisfied: false });
    const r2 = seedRepairScenario(db, { roomId: room.id, agentId: 'codex', satisfied: true });
    const r3 = seedRepairScenario(db, { roomId: room.id, agentId: 'codex', satisfied: false });

    const messages = [r1, r2, r3].map((scenario, idx) => ({
      id: scenario.triggerId,
      roomId: room.id,
      authorId: 'system',
      authorKind: 'system' as const,
      text: REPAIR_BODY_VERBOSE,
      createdAt: 1_700_000_000_000 + idx,
      deliveryStatus: 'delivered' as const,
      seenBy: [],
    }));
    const result = classifyWorkflowRepairCollapse(db, messages);

    expect(result.classifiedIds).toEqual([r1.triggerId, r2.triggerId, r3.triggerId]);
    expect(result.collapsedText.has(r1.triggerId)).toBe(true);
    expect(result.collapsedText.has(r2.triggerId)).toBe(true);
    expect(result.collapsedText.has(r3.triggerId)).toBe(false);
    expect(result.collapsedText.get(r1.triggerId)).toContain('status=unresolved');
    expect(result.collapsedText.get(r2.triggerId)).toContain('status=satisfied');
  });

  it('does not classify an unfinished repair (no turn outcome yet)', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'room', agents: ['codex'] });
    const trigger = addMessage(db, {
      roomId: room.id,
      authorId: 'system',
      authorKind: 'system',
      text: REPAIR_BODY_VERBOSE,
    });
    // create the agent_run but don't record a turn outcome — repair turn is still mid-flight
    createAgentRun(db, {
      roomId: room.id,
      triggerMessageId: trigger.id,
      agentId: 'codex',
      permissionMode: 'edit',
      promptChars: 1000,
      estimatedPromptTokens: 250,
      liveMessages: 5,
      contextArtifacts: 0,
    });
    const messages = [trigger];
    const result = classifyWorkflowRepairCollapse(db, messages);
    expect(result.classifiedIds).toEqual([]);
    expect(result.collapsedText.size).toBe(0);
  });

  it('skips classification for the explicitly excluded current trigger', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'room', agents: ['codex'] });
    const repair = seedRepairScenario(db, {
      roomId: room.id,
      agentId: 'codex',
      satisfied: true,
    });
    const messages = [
      {
        id: repair.triggerId,
        roomId: room.id,
        authorId: 'system',
        authorKind: 'system' as const,
        text: REPAIR_BODY_VERBOSE,
        createdAt: 1_700_000_000_000,
        deliveryStatus: 'delivered' as const,
        seenBy: [],
      },
    ];
    const result = classifyWorkflowRepairCollapse(db, messages, {
      excludeMessageId: repair.triggerId,
    });
    expect(result.classifiedIds).toEqual([]);
    expect(result.collapsedText.size).toBe(0);
  });

  it('renders the collapsed marker in the live prompt and bounded transcript file', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'room', agents: ['codex'] });
    const SENTINEL = 'CONTRACT-REPAIR-VERBOSE-BODY-SENTINEL';
    const verboseBody = `${REPAIR_BODY_VERBOSE}\n${SENTINEL}\n`;
    seedRepairScenario(db, {
      roomId: room.id,
      agentId: 'codex',
      satisfied: true,
      body: verboseBody,
    });
    const trigger = addMessage(db, {
      roomId: room.id,
      authorId: 'matt',
      authorKind: 'human',
      text: 'next instruction please',
    });

    const contextDir = mkdtempSync(path.join(os.tmpdir(), 'fireside-repair-collapse-'));
    const prepared = prepareAgentTurnContext({
      db,
      room,
      agentId: 'codex',
      trigger,
      maxHistory: 50,
      maxPromptChars: 32_000,
      contextDir,
      sessionPolicy: 'ephemeral',
      getResumableCliSessionId: () => null,
      loadWorkflowProfileForTask: () => null,
      buildTaskControl: () => ({
        currentPhase: null,
        openChecklistItems: [],
        blockedChecklistItems: [],
        activePlan: null,
      }),
      workflowWorkspacePath: () => '',
      workflowProfilePromptItem: () => undefined,
      workLanePromptItem: (item) => ({
        id: item.id,
        title: item.title,
        detail: item.detail,
        status: item.status,
        planId: item.planId,
        phaseId: item.phaseId,
      }),
    });

    expect(prepared.prompt).not.toContain(SENTINEL);
    expect(prepared.prompt).not.toContain('Required options:');
    expect(prepared.prompt).toContain('workflow-repair @');
    expect(prepared.prompt).toContain('status=satisfied');

    const bounded = readFileSync(
      path.join(contextDir, room.id, 'transcript.md'),
      'utf8',
    );
    expect(bounded).not.toContain(SENTINEL);
    expect(bounded).toContain('workflow-repair @');
  });
});
