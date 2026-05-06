import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/db.js';
import type { AgentRunStatus } from '../../src/repos/agent-runs.js';
import { createAgentRunAction } from '../../src/repos/run-actions.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { createTaskChecklistItem } from '../../src/repos/task-checklist.js';
import { buildStatusSnapshot } from '../../src/status-snapshot.js';

let runSequence = 0;

function insertRun(
  db: ReturnType<typeof openDatabase>,
  input: {
    roomId: string;
    taskId?: string | null;
    triggerMessageId: string;
    replyMessageId?: string | null;
    agentId: string;
    status?: AgentRunStatus;
    permissionMode?: 'plan' | 'edit' | 'full-auto';
    promptChars?: number;
    estimatedPromptTokens?: number;
    liveMessages?: number;
    contextArtifacts?: number;
    startedAt?: number;
    completedAt?: number | null;
    error?: string;
    cliSessionId?: string | null;
  },
): { id: string } {
  const id = `run-${++runSequence}`;
  db.prepare(
    `INSERT INTO agent_runs (
      id, room_id, task_id, trigger_message_id, reply_message_id, agent_id, status,
      permission_mode, prompt_chars, estimated_prompt_tokens, live_messages, context_artifacts,
      started_at, completed_at, error, cli_session_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.roomId,
    input.taskId ?? null,
    input.triggerMessageId,
    input.replyMessageId ?? null,
    input.agentId,
    input.status ?? 'running',
    input.permissionMode ?? 'plan',
    input.promptChars ?? 0,
    input.estimatedPromptTokens ?? 0,
    input.liveMessages ?? 0,
    input.contextArtifacts ?? 0,
    input.startedAt ?? Date.now(),
    input.completedAt ?? null,
    input.error ?? '',
    input.cliSessionId ?? null,
  );
  return { id };
}

describe('status snapshot', () => {
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_800_000_000_000));
    runSequence = 0;
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('returns a safe empty snapshot when no rooms exist', () => {
    const snapshot = buildStatusSnapshot({ db });

    expect(snapshot).toMatchObject({
      version: 1,
      generatedAt: 1_800_000_000_000,
      scope: { roomId: null },
      counts: {
        rooms: 0,
        agents: 0,
        activeMissions: 0,
        tasks: { total: 0, activeLike: 0 },
        runs: { total: 0, running: 0, retrying: 0, completed: 0 },
        runActions: { total: 0, withContextUsage: 0 },
      },
      rooms: [],
      activeMissions: [],
      activeTasks: [],
      runs: { last: null, running: [], retrying: [], completed: [] },
      runActions: { last: null, recent: [] },
      contextUsage: { latest: null, byAgent: [] },
      tokenUsage: {
        totalTokens: 0,
        promptEstimateTokens: 0,
        usageEvents: 0,
        runs: 0,
        byProvider: [],
        byAgent: [],
        recentEvents: [],
      },
    });
  });

  it('scopes the snapshot to a single room', () => {
    const alpha = createRoom(db, { name: 'alpha', agents: ['codex'] });
    const beta = createRoom(db, { name: 'beta', agents: ['claude', 'gemini'] });
    createTask(db, { roomId: alpha.id, title: 'Alpha mission', agents: ['codex'] });
    createTask(db, { roomId: beta.id, title: 'Beta mission', agents: ['claude'] });

    const snapshot = buildStatusSnapshot({ db, roomId: alpha.id });

    expect(snapshot.scope.roomId).toBe(alpha.id);
    expect(snapshot.counts.rooms).toBe(1);
    expect(snapshot.counts.agents).toBe(1);
    expect(snapshot.counts.tasks.total).toBe(1);
    expect(snapshot.counts.activeMissions).toBe(1);
    expect(snapshot.rooms.map((room) => room.id)).toEqual([alpha.id]);
    expect(snapshot.activeTasks.map((task) => task.title)).toEqual(['Alpha mission']);
  });

  it('counts active missions and running/completed runs', () => {
    const room = createRoom(db, { name: 'ops', agents: ['codex'] });
    const task = createTask(db, { roomId: room.id, title: 'Ship state API', agents: ['codex'] });
    vi.setSystemTime(new Date(1_800_000_000_100));
    const runningRun = insertRun(db, {
      roomId: room.id,
      taskId: task.id,
      triggerMessageId: 'msg-running',
      agentId: 'codex',
      permissionMode: 'edit',
      promptChars: 200,
      estimatedPromptTokens: 50,
      liveMessages: 3,
      contextArtifacts: 1,
    });
    vi.setSystemTime(new Date(1_800_000_000_200));
    const completedRun = insertRun(db, {
      roomId: room.id,
      taskId: task.id,
      triggerMessageId: 'msg-completed',
      agentId: 'codex',
      status: 'completed',
      permissionMode: 'edit',
      promptChars: 120,
      estimatedPromptTokens: 30,
      liveMessages: 2,
      contextArtifacts: 0,
      startedAt: 1_800_000_000_200,
      completedAt: 1_800_000_000_250,
      replyMessageId: 'reply-completed',
    });

    const snapshot = buildStatusSnapshot({ db });

    expect(snapshot.counts.activeMissions).toBe(1);
    expect(snapshot.counts.tasks.active).toBe(1);
    expect(snapshot.counts.runs).toMatchObject({
      total: 2,
      running: 1,
      retrying: 0,
      completed: 1,
    });
    expect(snapshot.runs.running.map((run) => run.id)).toEqual([runningRun.id]);
    expect(snapshot.runs.completed.map((run) => run.id)).toEqual([completedRun.id]);
  });

  it('includes the latest run, action summary, and context usage', () => {
    const room = createRoom(db, { name: 'ops', agents: ['codex', 'claude'] });
    const task = createTask(db, { roomId: room.id, title: 'Summarize state' });
    vi.setSystemTime(new Date(1_800_000_000_100));
    const firstRun = insertRun(db, {
      roomId: room.id,
      taskId: task.id,
      triggerMessageId: 'msg-1',
      agentId: 'claude',
      permissionMode: 'plan',
      promptChars: 80,
      estimatedPromptTokens: 20,
      liveMessages: 1,
      contextArtifacts: 0,
    });
    createAgentRunAction(db, {
      roomId: room.id,
      taskId: task.id,
      runId: firstRun.id,
      agentId: 'claude',
      kind: 'run',
      status: 'running',
      label: 'claude started',
    });

    vi.setSystemTime(new Date(1_800_000_000_300));
    const latestRun = insertRun(db, {
      roomId: room.id,
      taskId: task.id,
      triggerMessageId: 'msg-2',
      agentId: 'codex',
      permissionMode: 'edit',
      promptChars: 160,
      estimatedPromptTokens: 40,
      liveMessages: 2,
      contextArtifacts: 1,
    });
    const latestAction = createAgentRunAction(db, {
      roomId: room.id,
      taskId: task.id,
      runId: latestRun.id,
      agentId: 'codex',
      kind: 'diagnostic',
      status: 'completed',
      label: 'context usage captured',
      detail: 'codex used 123 tokens',
      contextUsage: {
        provider: 'codex',
        model: 'gpt-5.5',
        usedTokens: 123,
        contextWindow: 400_000,
        remainingTokens: 399_877,
        percentUsed: 0.03075,
        source: 'test',
      },
    });

    const snapshot = buildStatusSnapshot({ db });

    expect(snapshot.runs.last).toMatchObject({
      id: latestRun.id,
      roomId: room.id,
      taskId: task.id,
      agentId: 'codex',
      status: 'running',
    });
    expect(snapshot.rooms[0]?.lastRun?.id).toBe(latestRun.id);
    expect(snapshot.runActions.last).toMatchObject({
      id: latestAction.id,
      runId: latestRun.id,
      kind: 'diagnostic',
      status: 'completed',
      label: 'context usage captured',
    });
    expect(snapshot.runActions.summary).toMatchObject({
      total: 2,
      running: 1,
      completed: 1,
      withContextUsage: 1,
    });
    expect(snapshot.runActions.summary.byKind.diagnostic).toBe(1);
    expect(snapshot.contextUsage.latest).toMatchObject({
      agentId: 'codex',
      actionId: latestAction.id,
      usage: { provider: 'codex', model: 'gpt-5.5', usedTokens: 123 },
    });
    expect(snapshot.rooms[0]?.contextUsage.byAgent).toHaveLength(1);
  });

  it('merges quota-only context updates into the latest agent usage row', () => {
    const room = createRoom(db, { name: 'quota-room', agents: ['claude'] });
    const run = insertRun(db, {
      roomId: room.id,
      triggerMessageId: 'msg-1',
      agentId: 'claude',
      status: 'completed',
      completedAt: Date.now(),
    });
    vi.setSystemTime(new Date(1_800_000_000_100));
    createAgentRunAction(db, {
      roomId: room.id,
      taskId: null,
      runId: run.id,
      agentId: 'claude',
      kind: 'adapter',
      status: 'completed',
      label: 'claude result received',
      detail: 'usage',
      contextUsage: {
        provider: 'claude',
        model: 'claude-opus-4-7[1m]',
        usedTokens: 50_000,
        contextWindow: 1_000_000,
        source: 'claude:usage',
      },
    });
    vi.setSystemTime(new Date(1_800_000_000_200));
    createAgentRunAction(db, {
      roomId: room.id,
      taskId: null,
      runId: run.id,
      agentId: 'claude',
      kind: 'adapter',
      status: 'info',
      label: 'claude rate limit update',
      detail: 'quota',
      contextUsage: {
        provider: 'claude',
        model: 'claude',
        usedTokens: 0,
        quotaOnly: true,
        quota: {
          fiveHour: { windowMinutes: 300, resetsAt: 1_800_001_000_000, status: 'allowed' },
          source: 'claude:rate_limit_info',
        },
        source: 'claude:rate_limit_info',
      },
    });

    const snapshot = buildStatusSnapshot({ db });

    expect(snapshot.contextUsage.byAgent).toMatchObject([
      {
        agentId: 'claude',
        usage: {
          provider: 'claude',
          usedTokens: 50_000,
          quota: {
            fiveHour: {
              windowMinutes: 300,
              resetsAt: 1_800_001_000_000,
              status: 'allowed',
            },
          },
        },
      },
    ]);
    expect(snapshot.contextUsage.byAgent[0]?.usage.quotaOnly).toBeUndefined();
  });

  it('aggregates room and active-mission lifetime token usage', () => {
    const room = createRoom(db, { name: 'token-room', agents: ['claude', 'codex'] });
    const activeTask = createTask(db, {
      roomId: room.id,
      title: 'Active mission',
      agents: ['claude', 'codex'],
    });
    const doneTask = createTask(db, {
      roomId: room.id,
      title: 'Done mission',
      status: 'done',
      agents: ['claude'],
    });
    const activeClaudeRun = insertRun(db, {
      roomId: room.id,
      taskId: activeTask.id,
      triggerMessageId: 'msg-active-claude',
      agentId: 'claude',
      status: 'completed',
      completedAt: Date.now(),
      estimatedPromptTokens: 100,
    });
    const activeCodexRun = insertRun(db, {
      roomId: room.id,
      taskId: activeTask.id,
      triggerMessageId: 'msg-active-codex',
      agentId: 'codex',
      status: 'completed',
      completedAt: Date.now(),
      estimatedPromptTokens: 50,
    });
    const historicalRun = insertRun(db, {
      roomId: room.id,
      taskId: doneTask.id,
      triggerMessageId: 'msg-done',
      agentId: 'claude',
      status: 'completed',
      completedAt: Date.now(),
      estimatedPromptTokens: 25,
    });

    createAgentRunAction(db, {
      roomId: room.id,
      taskId: activeTask.id,
      runId: activeClaudeRun.id,
      agentId: 'claude',
      kind: 'adapter',
      status: 'completed',
      label: 'claude result received',
      contextUsage: {
        provider: 'claude',
        model: 'claude-opus-4-7[1m]',
        usedTokens: 1_250,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 1_000,
        cacheReadInputTokens: 100,
        source: 'test',
      },
    });
    createAgentRunAction(db, {
      roomId: room.id,
      taskId: activeTask.id,
      runId: activeCodexRun.id,
      agentId: 'codex',
      kind: 'adapter',
      status: 'completed',
      label: 'codex turn completed',
      contextUsage: {
        provider: 'codex',
        model: 'gpt-5.5',
        usedTokens: 225,
        inputTokens: 200,
        outputTokens: 25,
        reasoningOutputTokens: 10,
        source: 'test',
      },
    });
    createAgentRunAction(db, {
      roomId: room.id,
      taskId: doneTask.id,
      runId: historicalRun.id,
      agentId: 'claude',
      kind: 'adapter',
      status: 'info',
      label: 'claude rate limit update',
      contextUsage: {
        provider: 'claude',
        model: 'claude',
        usedTokens: 0,
        quotaOnly: true,
        quota: { source: 'test' },
        source: 'test',
      },
    });

    const snapshot = buildStatusSnapshot({ db });
    const roomSnapshot = snapshot.rooms[0]!;

    expect(snapshot.tokenUsage).toMatchObject({
      totalTokens: 1_475,
      promptEstimateTokens: 175,
      inputTokens: 300,
      outputTokens: 75,
      cacheCreationInputTokens: 1_000,
      cacheReadInputTokens: 100,
      reasoningOutputTokens: 10,
      usageEvents: 2,
      runs: 3,
    });
    expect(roomSnapshot.activeMissionTokenUsage).toMatchObject({
      totalTokens: 1_475,
      promptEstimateTokens: 150,
      usageEvents: 2,
      runs: 2,
    });
    expect(roomSnapshot.tokenUsage.byProvider).toMatchObject([
      { id: 'claude', totalTokens: 1_250 },
      { id: 'codex', totalTokens: 225 },
    ]);
    expect(roomSnapshot.tokenUsage.byAgent).toMatchObject([
      { id: 'claude', totalTokens: 1_250, promptEstimateTokens: 125 },
      { id: 'codex', totalTokens: 225, promptEstimateTokens: 50 },
    ]);
    expect(roomSnapshot.tokenUsage.recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'claude', provider: 'claude', totalTokens: 1_250 }),
        expect.objectContaining({ agentId: 'codex', provider: 'codex', totalTokens: 225 }),
      ]),
    );
    expect(roomSnapshot.tokenUsage.recentEvents).toHaveLength(2);
  });

  it('does not let diagnostic reported tokens inflate lifetime burn totals', () => {
    const room = createRoom(db, { name: 'diagnostic-token-noise', agents: ['codex'] });
    const run = insertRun(db, {
      roomId: room.id,
      triggerMessageId: 'msg-codex',
      agentId: 'codex',
      status: 'completed',
      completedAt: Date.now(),
      estimatedPromptTokens: 1_000,
    });

    createAgentRunAction(db, {
      roomId: room.id,
      runId: run.id,
      agentId: 'codex',
      kind: 'adapter',
      status: 'completed',
      label: 'codex turn completed',
      contextUsage: {
        provider: 'codex',
        model: 'gpt-5.5',
        usedTokens: 225_000,
        reportedUsedTokens: 120_000_000,
        inputTokens: 224_000,
        outputTokens: 1_000,
        source: 'test',
      },
    });

    const snapshot = buildStatusSnapshot({ db });

    expect(snapshot.tokenUsage.totalTokens).toBe(225_000);
    expect(snapshot.tokenUsage.recentEvents[0]).toMatchObject({
      provider: 'codex',
      totalTokens: 225_000,
    });
  });

  it('merges partial quota window fragments without losing existing fields', () => {
    const room = createRoom(db, { name: 'quota-fragments', agents: ['claude'] });
    const run = insertRun(db, {
      roomId: room.id,
      triggerMessageId: 'msg-1',
      agentId: 'claude',
      status: 'completed',
      completedAt: Date.now(),
    });
    vi.setSystemTime(new Date(1_800_000_000_100));
    createAgentRunAction(db, {
      roomId: room.id,
      taskId: null,
      runId: run.id,
      agentId: 'claude',
      kind: 'adapter',
      status: 'completed',
      label: 'claude result received',
      contextUsage: {
        provider: 'claude',
        model: 'claude-opus-4-7[1m]',
        usedTokens: 50_000,
        contextWindow: 1_000_000,
        source: 'claude:usage',
      },
    });
    vi.setSystemTime(new Date(1_800_000_000_200));
    createAgentRunAction(db, {
      roomId: room.id,
      taskId: null,
      runId: run.id,
      agentId: 'claude',
      kind: 'adapter',
      status: 'info',
      label: 'claude rate limit headers',
      contextUsage: {
        provider: 'claude',
        model: 'claude',
        usedTokens: 0,
        quotaOnly: true,
        quota: {
          fiveHour: { percent: 15, windowMinutes: 300 },
          sevenDay: { percent: 23, windowMinutes: 10_080 },
          source: 'claude:debug-rate-limit-headers',
        },
        source: 'claude:debug-rate-limit-headers',
      },
    });
    vi.setSystemTime(new Date(1_800_000_000_300));
    createAgentRunAction(db, {
      roomId: room.id,
      taskId: null,
      runId: run.id,
      agentId: 'claude',
      kind: 'adapter',
      status: 'info',
      label: 'claude rate limit headers',
      contextUsage: {
        provider: 'claude',
        model: 'claude',
        usedTokens: 0,
        quotaOnly: true,
        quota: {
          fiveHour: { windowMinutes: 300, resetsAt: 1_800_001_000_000, status: 'allowed' },
          sevenDay: { windowMinutes: 10_080, resetsAt: 1_800_100_000_000, status: 'allowed' },
          source: 'claude:debug-rate-limit-headers',
        },
        source: 'claude:debug-rate-limit-headers',
      },
    });

    const snapshot = buildStatusSnapshot({ db });

    expect(snapshot.contextUsage.byAgent[0]?.usage.quota).toMatchObject({
      fiveHour: {
        percent: 15,
        windowMinutes: 300,
        resetsAt: 1_800_001_000_000,
        status: 'allowed',
      },
      sevenDay: {
        percent: 23,
        windowMinutes: 10_080,
        resetsAt: 1_800_100_000_000,
        status: 'allowed',
      },
    });
  });

  it('shares Claude account quota across Claude-backed room agents', () => {
    const room = createRoom(db, {
      name: 'multi-claude-quota',
      agents: ['sean', 'alexander', 'codex-reviewer'],
      agentProfiles: [
        {
          id: 'sean',
          providerId: 'claude',
          displayName: 'Sean',
          personaId: 'technical-lead',
          personaName: 'Technical Lead',
          personaSummary: 'Owns technical direction.',
        },
        {
          id: 'alexander',
          providerId: 'claude',
          displayName: 'Alexander',
          personaId: 'engineering-manager',
          personaName: 'Engineering Manager',
          personaSummary: 'Keeps the team moving.',
        },
        {
          id: 'codex-reviewer',
          providerId: 'codex',
          displayName: 'Reviewer',
          personaId: 'principal-software-engineer',
          personaName: 'Principal Software Engineer',
          personaSummary: 'Reviews implementation quality.',
        },
      ],
    });
    const seanRun = insertRun(db, {
      roomId: room.id,
      triggerMessageId: 'msg-sean',
      agentId: 'sean',
      status: 'completed',
      completedAt: Date.now(),
    });
    vi.setSystemTime(new Date(1_800_000_000_100));
    createAgentRunAction(db, {
      roomId: room.id,
      taskId: null,
      runId: seanRun.id,
      agentId: 'sean',
      kind: 'adapter',
      status: 'completed',
      label: 'claude result received',
      contextUsage: {
        provider: 'claude',
        model: 'claude-opus-4-7[1m]',
        usedTokens: 92_000,
        contextWindow: 1_000_000,
        source: 'claude:usage',
      },
    });
    const alexanderRun = insertRun(db, {
      roomId: room.id,
      triggerMessageId: 'msg-alexander',
      agentId: 'alexander',
      status: 'completed',
      completedAt: Date.now(),
    });
    vi.setSystemTime(new Date(1_800_000_000_200));
    createAgentRunAction(db, {
      roomId: room.id,
      taskId: null,
      runId: alexanderRun.id,
      agentId: 'alexander',
      kind: 'adapter',
      status: 'info',
      label: 'claude rate limit headers',
      contextUsage: {
        provider: 'claude',
        model: 'claude',
        usedTokens: 0,
        quotaOnly: true,
        quota: {
          fiveHour: { percent: 15, windowMinutes: 300, resetsAt: 1_800_001_000_000 },
          sevenDay: { percent: 23, windowMinutes: 10_080, resetsAt: 1_800_100_000_000 },
          source: 'claude:debug-rate-limit-headers',
        },
        source: 'claude:debug-rate-limit-headers',
      },
    });

    const snapshot = buildStatusSnapshot({ db });
    const byAgent = new Map(
      snapshot.rooms[0]!.contextUsage.byAgent.map((entry) => [entry.agentId, entry]),
    );

    expect(byAgent.get('sean')?.usage).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-4-7[1m]',
      usedTokens: 92_000,
      quota: {
        fiveHour: { percent: 15, resetsAt: 1_800_001_000_000 },
        sevenDay: { percent: 23, resetsAt: 1_800_100_000_000 },
      },
    });
    expect(byAgent.get('alexander')?.usage).toMatchObject({
      provider: 'claude',
      quotaOnly: true,
      quota: {
        fiveHour: { percent: 15 },
        sevenDay: { percent: 23 },
      },
    });
    expect(byAgent.has('codex-reviewer')).toBe(false);
  });

  it('shares Gemini account quota across Gemini-backed room agents', () => {
    const room = createRoom(db, {
      name: 'multi-gemini-quota',
      agents: ['holly', 'biggs', 'sean'],
      agentProfiles: [
        {
          id: 'holly',
          providerId: 'gemini',
          displayName: 'Holly',
          personaId: 'ux-researcher',
          personaName: 'UX Researcher',
          personaSummary: 'Broad synthesis and research.',
        },
        {
          id: 'biggs',
          providerId: 'gemini',
          displayName: 'Biggs',
          personaId: 'quality-assurance-engineer',
          personaName: 'Quality Assurance Engineer',
          personaSummary: 'Tests behavior.',
        },
        {
          id: 'sean',
          providerId: 'claude',
          displayName: 'Sean',
          personaId: 'technical-lead',
          personaName: 'Technical Lead',
          personaSummary: 'Owns technical direction.',
        },
      ],
    });
    const run = insertRun(db, {
      roomId: room.id,
      triggerMessageId: 'msg-holly',
      agentId: 'holly',
      status: 'completed',
      completedAt: Date.now(),
    });
    createAgentRunAction(db, {
      roomId: room.id,
      taskId: null,
      runId: run.id,
      agentId: 'holly',
      kind: 'adapter',
      status: 'completed',
      label: 'gemini quota sampled',
      contextUsage: {
        provider: 'gemini',
        model: 'gemini-2.5-pro',
        usedTokens: 0,
        quotaOnly: true,
        quota: {
          daily: { percent: 32, windowMinutes: 1440, resetsAt: 1_800_050_000_000 },
          source: 'gemini:stats-model',
        },
        source: 'gemini:stats-model',
      },
    });

    const snapshot = buildStatusSnapshot({ db });
    const byAgent = new Map(
      snapshot.rooms[0]!.contextUsage.byAgent.map((entry) => [entry.agentId, entry]),
    );

    expect(byAgent.get('holly')?.usage.quota?.daily).toMatchObject({ percent: 32 });
    expect(byAgent.get('biggs')?.usage).toMatchObject({
      provider: 'gemini',
      quotaOnly: true,
      quota: {
        daily: { percent: 32 },
      },
    });
    expect(byAgent.has('sean')).toBe(false);
  });

  it('projects per-agent workflow state from runs, permissions, and checklist ownership', () => {
    const room = createRoom(db, { name: 'ops', agents: ['codex', 'claude', 'gemini', 'echo'] });
    const task = createTask(db, {
      roomId: room.id,
      title: 'Coordinate mission',
      agents: ['codex', 'claude', 'gemini', 'echo'],
    });
    const codexItem = createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Ready lane',
      ownerAgentId: 'codex',
      status: 'open',
    });
    createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Needs council',
      ownerAgentId: 'claude',
      status: 'blocked',
      blockedReason: 'Waiting for Matt to choose an option.',
      councilRequired: true,
    });
    createTaskChecklistItem(db, {
      taskId: task.id,
      title: 'Known technical blocker',
      ownerAgentId: 'echo',
      status: 'blocked',
      blockedReason: 'A non-council technical blocker is recorded.',
      councilRequired: false,
    });
    const geminiRun = insertRun(db, {
      roomId: room.id,
      taskId: task.id,
      triggerMessageId: 'msg-gemini',
      agentId: 'gemini',
      startedAt: 1_800_000_000_000,
    });

    const snapshot = buildStatusSnapshot({ db });
    const states = new Map(snapshot.rooms[0]!.agentStates.map((state) => [state.agentId, state]));

    expect(states.get('gemini')).toMatchObject({
      state: 'working',
      label: 'working',
      runId: geminiRun.id,
    });
    expect(states.get('claude')).toMatchObject({
      state: 'waiting_on_human',
      label: 'waiting',
      severity: 'warn',
    });
    expect(states.get('codex')).toMatchObject({
      state: 'idle_ready',
      label: 'ready',
      checklistItemId: codexItem.id,
    });
    expect(states.get('echo')).toMatchObject({
      state: 'blocked',
      label: 'has blocker',
      severity: 'warn',
    });
    expect(snapshot.agentStates).toHaveLength(4);
  });

  it('projects provider quota exhaustion as an incapacitated agent state', () => {
    const room = createRoom(db, {
      name: 'ops',
      agentProfiles: [
        {
          id: 'holly',
          providerId: 'gemini',
          displayName: 'Holly',
          personaId: 'generalist',
          personaName: 'Generalist',
          personaSummary: '',
        },
      ],
    });
    const task = createTask(db, {
      roomId: room.id,
      title: 'Coordinate mission',
      agents: ['holly'],
    });
    const run = insertRun(db, {
      roomId: room.id,
      taskId: task.id,
      triggerMessageId: 'msg-holly',
      agentId: 'holly',
      status: 'failed',
      completedAt: 1_800_000_001_000,
    });
    createAgentRunAction(db, {
      roomId: room.id,
      taskId: task.id,
      runId: run.id,
      agentId: 'holly',
      kind: 'adapter',
      status: 'failed',
      label: 'gemini quota exhausted',
      detail: 'quota 1d 100%',
      contextUsage: {
        provider: 'gemini',
        model: 'gemini-2.5-pro',
        usedTokens: 0,
        quotaOnly: true,
        quota: {
          daily: {
            percent: 100,
            resetsAt: 1_800_030_000_000,
            status: 'limited',
          },
          source: 'gemini:terminal-quota',
        },
        source: 'gemini:terminal-quota',
      },
    });

    const snapshot = buildStatusSnapshot({ db });
    expect(snapshot.rooms[0]!.agentStates[0]).toMatchObject({
      agentId: 'holly',
      state: 'incapacitated',
      label: 'quota limited',
      severity: 'danger',
      runId: run.id,
    });
  });
});
