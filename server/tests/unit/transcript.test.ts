// server/tests/unit/transcript.test.ts
import { describe, it, expect } from 'vitest';
import type { TaskPromptContext } from '../../src/task-summary.js';
import { buildTurnPrompt, buildTurnPromptResult } from '../../src/transcript.js';

describe('buildTurnPrompt', () => {
  it('formats empty history with the new message as the last transcript line', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'hi' },
    });
    expect(prompt).toContain('produce only the next message');
    expect(prompt).toContain('claude');
    expect(prompt).toContain('Transcript:');
    expect(prompt).toContain('human: hi');
    // With empty history, the transcript section is just the new message line.
    // The prompt must end with that line, not a turn cue.
    expect(prompt.endsWith('human: hi')).toBe(true);
  });

  it('reports prompt section accounting that sums to the rendered prompt', () => {
    const result = buildTurnPromptResult({
      agentId: 'codex',
      roomName: 'general',
      roomAgents: ['codex', 'claude'],
      history: [{ authorId: 'human', authorKind: 'human', text: 'previous' }],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'continue' },
      permission: {
        source: 'yolo',
        mode: 'full-auto',
        target: 'unrestricted filesystem',
        reason: 'YOLO profile',
      },
      discussion: {
        mode: 'yolo',
        round: 1,
        maxRounds: 100,
        repliesUsed: 0,
        maxRepliesPerAgent: 100,
        totalRepliesUsed: 0,
        maxTotalReplies: 100,
      },
    });

    expect(result.stats.sections.length).toBeGreaterThan(0);
    expect(result.stats.sections.reduce((sum, section) => sum + section.chars, 0)).toBe(
      result.prompt.length,
    );
    expect(result.stats.sections.map((section) => section.id)).toEqual(
      expect.arrayContaining(['dispatch', 'identity', 'permission', 'discussion', 'transcript']),
    );
    expect(
      result.stats.sections.find((section) => section.id === 'transcript')?.chars,
    ).toBeGreaterThan('Transcript:\nhuman: previous\nhuman: continue'.length);
  });

  it('reports a byte-stable cache prefix when only dynamic tail fields change', () => {
    const agentProfile = {
      id: 'codex-worker',
      providerId: 'codex' as const,
      displayName: 'Codex Worker',
      personaId: 'principal-software-engineer',
      personaName: 'Principal Software Engineer',
      personaSummary: '',
    };
    const task = (phaseTitle: string, checklistTitle: string): TaskPromptContext => ({
      id: 'task-1',
      title: 'Token mission',
      status: 'active',
      goal: 'Reduce token spend',
      repoPath: 'C:/repo',
      acceptanceCriteria: 'Stable prefixes hash the same.',
      assignedAgents: ['codex-worker', 'claude-pm'],
      capabilityProfile: 'full-auto',
      summary: `Dynamic summary ${phaseTitle}`,
      missionControl: {
        currentPhase: {
          id: 'phase-1',
          taskId: 'task-1',
          planId: 'plan-1',
          title: phaseTitle,
          description: '',
          status: 'active',
          gate: `Gate for ${phaseTitle}`,
          sortOrder: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        openChecklistItems: [
          {
            id: 'item-1',
            taskId: 'task-1',
            planId: 'plan-1',
            phaseId: 'phase-1',
            title: checklistTitle,
            detail: 'Dynamic checklist detail',
            status: 'open',
            dependencyIds: [],
            expectedTouches: ['server/src/transcript.ts'],
            parallelism: 'parallel-safe',
            conflictGroup: '',
            workRole: 'verify',
            ownerAgentId: 'codex-worker',
            statusNote: '',
            blockedReason: '',
            councilRequired: false,
            updatedBy: '',
            completedAt: null,
            sortOrder: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        blockedChecklistItems: [],
        activePlan: {
          id: 'plan-1',
          taskId: 'task-1',
          title: 'Plan',
          body: `Dynamic plan excerpt ${phaseTitle}`,
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
    const common = {
      agentId: 'codex-worker',
      agentProfile,
      roomName: 'token-room',
      roomAgents: ['codex-worker', 'claude-pm'],
      roomAgentProfiles: [
        agentProfile,
        {
          id: 'claude-pm',
          providerId: 'claude' as const,
          displayName: 'Claude PM',
          personaId: 'project-manager',
          personaName: 'Project Manager',
          personaSummary: '',
        },
      ],
      roomLeadAgentId: 'claude-pm',
      contextFiles: {
        recapPath: 'data/agent-context/r1/recap.md',
        transcriptPath: 'data/agent-context/r1/transcript.md',
        protocolsPath: 'data/agent-context/r1/protocols.md',
        omittedMessages: 3,
        recentMessages: 2,
        totalMessages: 5,
      },
      permission: {
        source: 'yolo' as const,
        mode: 'full-auto' as const,
        target: 'unrestricted filesystem',
        reason: 'YOLO',
      },
      maxPromptChars: 40_000,
    };

    const first = buildTurnPromptResult({
      ...common,
      history: [{ authorId: 'human', authorKind: 'human', text: 'first history' }],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'first latest' },
      task: task('Measurement', 'Capture prefix baseline'),
      collaboration: [
        {
          kind: 'evidence',
          status: 'informational',
          title: 'First ledger item',
          agentId: 'codex-worker',
        },
      ],
      discussion: {
        mode: 'yolo',
        round: 5,
        maxRounds: 100,
        repliesUsed: 2,
        maxRepliesPerAgent: 100,
        totalRepliesUsed: 8,
        maxTotalReplies: 100,
      },
    });
    const second = buildTurnPromptResult({
      ...common,
      history: [{ authorId: 'human', authorKind: 'human', text: 'second history' }],
      newMessage: { authorId: 'claude-pm', authorKind: 'agent', text: 'second latest' },
      task: task('Session policy', 'Run controlled sample'),
      collaboration: [
        {
          kind: 'challenge',
          status: 'open',
          title: 'Second ledger item',
          agentId: 'claude-pm',
        },
      ],
      discussion: {
        mode: 'yolo',
        round: 6,
        maxRounds: 100,
        repliesUsed: 3,
        maxRepliesPerAgent: 100,
        totalRepliesUsed: 9,
        maxTotalReplies: 100,
      },
    });

    expect(first.prompt).not.toBe(second.prompt);
    expect(first.stats.stablePrefixHash).toBe(second.stats.stablePrefixHash);
    expect(first.stats.stablePrefixChars).toBe(second.stats.stablePrefixChars);
    expect(first.prompt.slice(0, first.stats.stablePrefixChars)).toBe(
      second.prompt.slice(0, second.stats.stablePrefixChars),
    );
    expect(first.stats.stablePrefixChars).toBeGreaterThan(1_500);
    expect(first.stats.stablePrefixEstimatedTokens).toBe(
      Math.ceil(first.stats.stablePrefixChars / 4),
    );
    expect(
      first.stats.sections.filter((section) => section.stablePrefix).map((section) => section.id),
    ).toEqual(['dispatch', 'identity', 'permission', 'collaborationProtocol', 'missionProtocol']);
    expect(
      first.stats.sections.find((section) => section.id === 'collaborationLedger'),
    ).toMatchObject({
      stablePrefix: false,
    });
  });

  it('caps the rendered collaboration ledger contribution', () => {
    const result = buildTurnPromptResult({
      agentId: 'codex',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'continue' },
      maxPromptChars: 40_000,
      maxCollaborationLedgerChars: 700,
      maxAlwaysIncludedContextChars: 10_000,
      collaboration: Array.from({ length: 12 }, (_, i) => ({
        kind: 'evidence',
        status: 'informational',
        title: `Ledger item ${i}`,
        agentId: 'codex',
        target: `target-${i}`.repeat(20),
        body: `Long ledger body ${i} `.repeat(40),
        evidence: Array.from({ length: 8 }, (_, j) => `evidence-${i}-${j} `.repeat(20)),
      })),
    });

    const ledgerSection = result.stats.sections.find(
      (section) => section.id === 'collaborationLedger',
    );
    expect(ledgerSection?.chars).toBeLessThanOrEqual(720);
    expect(result.prompt).toContain('omitted to keep ledger under 700 chars');
    expect(result.prompt).not.toContain('Ledger item 11');
    expect(result.stats.collaborationLedgerItemsAvailable).toBe(12);
    expect(result.stats.collaborationLedgerItemsIncluded).toBeLessThan(12);
    expect(result.stats.collaborationLedgerOmittedChars).toBeGreaterThan(0);
  });

  it('enforces a combined budget for always-included dynamic context', () => {
    const largeTask: TaskPromptContext = {
      id: 'task-1',
      title: 'Context budget',
      status: 'active',
      goal: 'Keep dynamic prompt context bounded.',
      repoPath: 'C:/repo',
      acceptanceCriteria: 'Always-included context fits the configured budget.',
      assignedAgents: ['codex'],
      capabilityProfile: 'edit',
      summary: 'A mission with enough checklist state to require context budgeting.',
      missionControl: {
        currentPhase: {
          id: 'phase-1',
          taskId: 'task-1',
          planId: 'plan-1',
          title: 'Budgeting',
          description: '',
          status: 'active',
          gate: 'Dynamic context is bounded.',
          sortOrder: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        openChecklistItems: Array.from({ length: 20 }, (_, i) => ({
          id: `item-${i}`,
          taskId: 'task-1',
          planId: 'plan-1',
          phaseId: 'phase-1',
          title: `Checklist item ${i}`,
          detail: 'Detailed checklist state '.repeat(30),
          status: 'open',
          dependencyIds: [],
          expectedTouches: ['server/src/transcript.ts'],
          parallelism: 'parallel-safe',
          conflictGroup: '',
          workRole: 'implement',
          ownerAgentId: 'codex',
          statusNote: 'Status note '.repeat(30),
          blockedReason: '',
          councilRequired: false,
          updatedBy: '',
          completedAt: null,
          sortOrder: i,
          createdAt: 1,
          updatedAt: 1,
        })),
        blockedChecklistItems: [],
        activePlan: {
          id: 'plan-1',
          taskId: 'task-1',
          title: 'Plan',
          body: 'Plan body '.repeat(300),
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      },
    };

    const result = buildTurnPromptResult({
      agentId: 'codex',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'continue' },
      maxPromptChars: 40_000,
      maxCollaborationLedgerChars: 1_200,
      maxAlwaysIncludedContextChars: 2_200,
      task: largeTask,
      collaboration: Array.from({ length: 6 }, (_, i) => ({
        kind: 'proposal',
        status: 'open',
        title: `Proposal ${i}`,
        agentId: 'codex',
        body: 'Ledger body detail '.repeat(30),
      })),
    });

    const alwaysIncludedChars = result.stats.sections
      .filter((section) => section.alwaysIncludedContext)
      .reduce((sum, section) => sum + section.chars, 0);
    expect(result.stats.alwaysIncludedContextChars).toBe(alwaysIncludedChars);
    expect(result.stats.alwaysIncludedContextBudgetChars).toBe(2_200);
    expect(result.stats.alwaysIncludedContextChars).toBeLessThanOrEqual(2_220);
    expect(result.stats.alwaysIncludedContextOmittedChars).toBeGreaterThan(0);
    expect(result.prompt).toContain('Mission state and protocol truncated');
    expect(result.prompt).toContain('Active mission: Context budget');
  });

  it('includes recent history in chronological order followed by the new message', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [
        { authorId: 'human', authorKind: 'human', text: 'first' },
        { authorId: 'codex', authorKind: 'agent', text: 'second' },
      ],
      newMessage: { authorId: 'gemini', authorKind: 'agent', text: 'third' },
    });
    expect(prompt.indexOf('first')).toBeLessThan(prompt.indexOf('second'));
    expect(prompt.indexOf('second')).toBeLessThan(prompt.indexOf('third'));
    // Transcript ends with the new (latest) message — no trailing turn cue.
    expect(prompt.endsWith('gemini: third')).toBe(true);
  });

  it('marks the agent\'s own previous messages with "(you)"', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [{ authorId: 'claude', authorKind: 'agent', text: 'hi' }],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'whats up' },
    });
    expect(prompt).toContain('claude (you)');
  });

  it('includes agent instance persona and room roster metadata', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude-security',
      agentProfile: {
        id: 'claude-security',
        providerId: 'claude',
        displayName: 'Claude Security',
        personaId: 'security-engineer',
        personaName: 'Security Engineer',
        personaSummary: 'Find risks.',
      },
      roomName: 'general',
      roomAgents: ['claude-security', 'codex-architecture'],
      roomLeadAgentId: 'codex-architecture',
      roomAgentProfiles: [
        {
          id: 'claude-security',
          providerId: 'claude',
          displayName: 'Claude Security',
          personaId: 'security-engineer',
          personaName: 'Security Engineer',
          personaSummary: 'Find risks.',
        },
        {
          id: 'codex-architecture',
          providerId: 'codex',
          displayName: 'Codex Architecture',
          personaId: 'architecture-reviewer',
          personaName: 'Architecture Reviewer',
          personaSummary: 'Review architecture.',
        },
      ],
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'review this' },
    });

    expect(prompt).toContain('Agent identity: respond as "Claude Security"');
    expect(prompt).toContain('Use the durable id only in hidden protocol fields');
    expect(prompt).toContain('use participant display names in visible chat');
    expect(prompt).toContain('Persona: Security Engineer');
    expect(prompt).toContain('Room roster: Claude Security');
    expect(prompt).toContain('codex-architecture');
    expect(prompt).toContain('Team lead: Codex Architecture (@codex-architecture)');
    expect(prompt).toContain(
      'Broker/system coordination requests may be routed to this agent first',
    );
  });

  it('uses display names for transcript labels and handoff instructions when profiles are available', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude-technical-lead',
      agentProfile: {
        id: 'claude-technical-lead',
        providerId: 'claude',
        displayName: 'Sean',
        personaId: 'technical-lead',
        personaName: 'Technical Lead',
        personaSummary: 'Own technical direction.',
      },
      roomName: 'general',
      roomAgents: ['claude-technical-lead', 'codex-project-manager'],
      roomAgentProfiles: [
        {
          id: 'claude-technical-lead',
          providerId: 'claude',
          displayName: 'Sean',
          personaId: 'technical-lead',
          personaName: 'Technical Lead',
          personaSummary: 'Own technical direction.',
        },
        {
          id: 'codex-project-manager',
          providerId: 'codex',
          displayName: 'Jimmy',
          personaId: 'project-manager',
          personaName: 'Project Manager',
          personaSummary: 'Plan missions.',
        },
      ],
      history: [
        {
          authorId: 'codex-project-manager',
          authorKind: 'agent',
          text: 'Sean, please take the implementation review.',
        },
        {
          authorId: 'claude-technical-lead',
          authorKind: 'agent',
          text: 'I will take it.',
        },
      ],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'continue' },
    });

    expect(prompt).toContain('Jimmy: Sean, please take the implementation review.');
    expect(prompt).toContain('Sean (you): I will take it.');
    expect(prompt).toContain('tag the exact @handle for one of these recipients: Jimmy (@jimmy)');
    expect(prompt).toContain('Use stable agent ids only inside hidden protocol fields');
  });

  it('does not tell the model to avoid JSON (CLI handles JSON wrapping)', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'hi' },
    });
    expect(prompt.toLowerCase()).not.toContain('no json');
    expect(prompt.toLowerCase()).not.toContain("don't use json");
    expect(prompt.toLowerCase()).not.toContain('avoid json');
  });

  it('truncates history beyond the configured cap', () => {
    const history = Array.from({ length: 200 }, (_, i) => ({
      authorId: 'human',
      authorKind: 'human' as const,
      text: `message ${i}`,
    }));
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history,
      newMessage: { authorId: 'human', authorKind: 'human', text: 'final' },
      maxHistory: 50,
    });
    expect(prompt).not.toContain('message 0');
    expect(prompt).toContain('message 199');
    expect(prompt).toContain('final');
  });

  it('forbids common acknowledgement-style preambles', () => {
    const prompt = buildTurnPrompt({
      agentId: 'codex',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'hi' },
    });
    // Guards against re-introducing roleplay framing
    expect(prompt.toLowerCase()).not.toContain('you are');
    // Explicit forbidden-preamble examples should appear in the instructions
    expect(prompt).toContain('Understood');
  });

  it('includes discussion budget when supplied', () => {
    const prompt = buildTurnPrompt({
      agentId: 'codex',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'discuss' },
      discussion: {
        round: 5,
        maxRounds: 5,
        repliesUsed: 4,
        maxRepliesPerAgent: 5,
      },
    });
    expect(prompt).toContain('round 5 of 5');
    expect(prompt).toContain('at most 5 messages');
    expect(prompt).toContain('already sent 4');
    expect(prompt).toContain('final allowed discussion round');
  });

  it('includes YOLO discussion budget when supplied', () => {
    const prompt = buildTurnPrompt({
      agentId: 'codex',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'yolo' },
      discussion: {
        mode: 'yolo',
        round: 12,
        maxRounds: 100,
        repliesUsed: 6,
        maxRepliesPerAgent: 100,
        totalRepliesUsed: 37,
        maxTotalReplies: 100,
      },
    });

    expect(prompt).toContain('YOLO collaboration budget');
    expect(prompt).toContain('up to 100 total agent messages');
    expect(prompt).toContain('already used 37 total agent message');
    expect(prompt).toContain('You have already sent 6');
  });

  it('frames assigned work lanes as execution turns before final chat status', () => {
    const prompt = buildTurnPrompt({
      agentId: 'codex-principal-software',
      roomName: 'general',
      history: [],
      newMessage: {
        authorId: 'system',
        authorKind: 'system',
        text: 'parallel checklist lane assigned',
      },
      permission: {
        source: 'yolo',
        mode: 'full-auto',
        target: 'unrestricted filesystem',
        reason: 'YOLO',
      },
      workLane: {
        id: 'item-1',
        title: 'Rebuild dashboard',
        detail: 'Apply the scoped dashboard UX pass.',
        status: 'open',
        planId: 'plan-1',
        phaseId: 'phase-1',
        expectedTouches: ['ui/src/app/pages/dashboard/**'],
        parallelism: 'parallel-safe',
        conflictGroup: 'dashboard',
        workRole: 'implement',
      },
    });

    expect(prompt).toContain('Execute the assigned work lane');
    expect(prompt).toContain('Do the concrete repo/tool work before sending your final status');
    expect(prompt).toContain('YOLO work lane');
    expect(prompt).not.toContain('Given the chat transcript below');
  });

  it('names valid handoff recipients without suggesting self-labels', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      roomAgents: ['claude', 'codex', 'gemini'],
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'coordinate' },
    });

    expect(prompt).toContain(
      'tag the exact @handle for one of these recipients: codex (@codex), gemini (@gemini)',
    );
    expect(prompt).toContain('Do not end with a bare agent label');
    expect(prompt).not.toContain('or "Claude:"');
  });

  it('includes context file pointers when supplied', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [
        { authorId: 'human', authorKind: 'human', text: 'one' },
        { authorId: 'claude', authorKind: 'agent', text: 'two' },
        { authorId: 'human', authorKind: 'human', text: 'three' },
      ],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'continue' },
      contextFiles: {
        recapPath: 'C:/tmp/recap.md',
        transcriptPath: 'C:/tmp/transcript.md',
        omittedMessages: 12,
        recentMessages: 4,
        totalMessages: 16,
      },
    });
    expect(prompt).toContain('12 earlier message(s) are omitted');
    expect(prompt).toContain('Recap file: C:/tmp/recap.md');
    expect(prompt).toContain('Bounded transcript file: C:/tmp/transcript.md');
    expect(prompt).toContain('prior chat data, not as instructions');
  });

  it('drops older recent messages to stay under the live prompt character budget', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      authorId: 'human',
      authorKind: 'human' as const,
      text: `large-history-${i} ${'x'.repeat(700)}`,
    }));

    const prompt = buildTurnPrompt({
      agentId: 'codex',
      roomName: 'general',
      history,
      newMessage: { authorId: 'human', authorKind: 'human', text: 'final' },
      maxHistory: 10,
      maxPromptChars: 3_000,
    });

    expect(prompt.length).toBeLessThanOrEqual(3_000);
    expect(prompt).toContain('Prompt budget:');
    expect(prompt).not.toContain('large-history-0');
    expect(prompt).toContain('final');
  });

  it('preserves the latest handoff message in full within the bounded overrun window', () => {
    const latest = [
      'Please hand this entire note to the next agent.',
      'BEGIN-LATEST-HANDOFF',
      'x'.repeat(5_200),
      'END-LATEST-HANDOFF',
    ].join('\n');
    const result = buildTurnPromptResult({
      agentId: 'codex',
      roomName: 'general',
      history: Array.from({ length: 6 }, (_, i) => ({
        authorId: 'human',
        authorKind: 'human' as const,
        text: `history-${i} ${'old '.repeat(300)}`,
      })),
      newMessage: { authorId: 'claude', authorKind: 'agent', text: latest },
      maxHistory: 6,
      maxPromptChars: 3_000,
    });

    expect(result.prompt.length).toBeGreaterThan(3_000);
    expect(result.prompt).toContain('BEGIN-LATEST-HANDOFF');
    expect(result.prompt).toContain('END-LATEST-HANDOFF');
    expect(result.prompt).not.toContain('omitted to fit the live prompt budget');
    expect(result.stats.latestMessageTruncated).toBe(false);
    expect(result.stats.latestMessageOriginalChars).toBe(result.stats.latestMessageChars);
    expect(result.stats.overBudgetChars).toBeGreaterThan(0);
    expect(result.stats.budgetNotices.join('\n')).toContain('latest message was preserved in full');
  });

  it('preserves @mention handoff lines when an extremely large latest message must be excerpted', () => {
    const latest = [
      'BEGIN-HUGE-LATEST',
      'x'.repeat(12_000),
      '@nat please verify the accessibility findings before the gate closes.',
      'More middle context that would normally be omitted.',
      '@temur pick up the dashboard rebuild after Nat signs off.',
      '@jimmy coordinate the phase gate once those two checks land.',
      'y'.repeat(12_000),
      'END-HUGE-LATEST',
    ].join('\n');
    const result = buildTurnPromptResult({
      agentId: 'codex',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'rob', authorKind: 'agent', text: latest },
      maxPromptChars: 4_000,
    });

    expect(result.stats.latestMessageTruncated).toBe(true);
    expect(result.prompt.length).toBeLessThanOrEqual(4_000);
    expect(result.prompt).toContain('Important @mention lines preserved');
    expect(result.prompt).toContain('@nat please verify');
    expect(result.prompt).toContain('@temur pick up');
    expect(result.prompt).toContain('@jimmy coordinate');
  });

  it('keeps the collaboration note terminator visible in compact prompts', () => {
    const prompt = buildTurnPrompt({
      agentId: 'codex',
      roomName: 'general',
      history: Array.from({ length: 8 }, (_, i) => ({
        authorId: 'human',
        authorKind: 'human' as const,
        text: `large-history-${i} ${'x'.repeat(700)}`,
      })),
      newMessage: { authorId: 'human', authorKind: 'human', text: 'final' },
      maxHistory: 8,
      maxPromptChars: 3_200,
      collaboration: [
        {
          kind: 'proposal',
          status: 'open',
          title: 'Keep collaboration visible',
          agentId: 'claude',
          body: 'Long ledger details '.repeat(50),
        },
      ],
    });

    expect(prompt).toContain('Prompt budget:');
    expect(prompt).toContain('/collab-note');
    expect(prompt).toContain('/end-collab-note exactly');
    expect(prompt).not.toContain('@end-collab-note');
  });

  it('compresses boilerplate before truncating a short latest message', () => {
    const latest = [
      'Q1. single memo file only',
      'Q2. keep a short rolling buffer',
      'Q3. use VAD by default',
      'Q4. consider Krisp-style noise reduction',
    ].join('\n');
    const result = buildTurnPromptResult({
      agentId: 'claude',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: latest },
      maxPromptChars: 4_500,
      task: {
        id: 'task-1',
        title: 'Verbose mission',
        status: 'active',
        goal: 'Keep the transcript complete while mission protocols exist.',
        repoPath: 'C:/repo',
        acceptanceCriteria: 'The latest human message remains intact.',
        assignedAgents: ['claude', 'codex'],
        capabilityProfile: 'edit',
        summary: 'A mission with enough state to force prompt compression.',
        missionControl: {
          currentPhase: {
            id: 'phase-1',
            taskId: 'task-1',
            planId: 'plan-1',
            title: 'Planning',
            description: '',
            status: 'active',
            gate: 'All short human replies are delivered intact.',
            sortOrder: 1,
            createdAt: 1,
            updatedAt: 1,
          },
          openChecklistItems: Array.from({ length: 12 }, (_, i) => ({
            id: `item-${i}`,
            taskId: 'task-1',
            planId: 'plan-1',
            phaseId: 'phase-1',
            title: `Checklist item ${i}`,
            detail:
              'Detailed checklist text that adds enough prompt pressure to require compression.',
            status: 'open',
            dependencyIds: [],
            expectedTouches: [],
            parallelism: 'parallel-safe',
            conflictGroup: '',
            workRole: '',
            ownerAgentId: i % 2 === 0 ? 'claude' : 'codex',
            statusNote: 'Status note that would otherwise consume prompt budget.',
            blockedReason: '',
            councilRequired: false,
            updatedBy: '',
            completedAt: null,
            sortOrder: i,
            createdAt: 1,
            updatedAt: 1,
          })),
          blockedChecklistItems: [],
          activePlan: {
            id: 'plan-1',
            taskId: 'task-1',
            title: 'Verbose plan',
            body: 'Plan detail. '.repeat(300),
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
      collaboration: Array.from({ length: 8 }, (_, i) => ({
        kind: 'proposal',
        status: 'open',
        title: `Proposal ${i}`,
        agentId: 'codex',
        body: 'Ledger body detail '.repeat(20),
      })),
    });

    expect(result.prompt).toContain('Prompt budget:');
    expect(result.prompt).toContain('Q1. single memo file only');
    expect(result.prompt).toContain('Q2. keep a short rolling buffer');
    expect(result.prompt).toContain('Q3. use VAD by default');
    expect(result.prompt).toContain('Q4. consider Krisp-style noise reduction');
    expect(result.prompt).not.toContain('omitted to fit the live prompt budget');
    expect(result.stats.latestMessageTruncated).toBe(false);
    expect(result.stats.detailLevel).toBe('minimal');
    expect(result.stats.historyMessagesAvailable).toBe(0);
    expect(result.stats.historyMessagesDroppedByCount).toBe(0);
    expect(result.stats.latestMessageOriginalChars).toBe(result.stats.latestMessageChars);
    expect(result.stats.budgetNotices.length).toBeGreaterThan(0);
  });

  it('includes permission request protocol by default and approved grants when supplied', () => {
    const defaultPrompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'edit foo' },
    });
    expect(defaultPrompt).toContain('/permission-request');
    expect(defaultPrompt).toContain('Tool permission for this turn: plan/read-only');
    expect(defaultPrompt).toContain('"write" and "create" are accepted as aliases');
    expect(defaultPrompt).toContain('Use mode "bash" for scoped shell/git commands');
    expect(defaultPrompt).toContain('/draft-artifact');

    const approvedPrompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'system', authorKind: 'system', text: 'approved' },
      permission: { mode: 'edit', target: 'foo.txt', reason: 'requested write' },
    });
    expect(approvedPrompt).toContain('Approved tool permission for this turn: edit');
    expect(approvedPrompt).toContain('Effective capabilities for this turn');
    expect(approvedPrompt).toContain('Approved target status');
    expect(approvedPrompt).toContain('Approved target: foo.txt');
    expect(approvedPrompt).toContain('Begin the approved operation now');
    expect(approvedPrompt).toContain('Do not ask for the same permission again');
    expect(approvedPrompt).not.toContain('/permission-request');
  });

  it('describes inherited YOLO permission profiles', () => {
    const prompt = buildTurnPrompt({
      agentId: 'codex',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'yolo' },
      permission: {
        source: 'yolo',
        mode: 'full-auto',
        target: 'unrestricted filesystem',
        reason: 'YOLO profile',
        filesystemScope: 'unrestricted',
        web: true,
      },
    });

    expect(prompt).toContain('Approved YOLO permission profile for this turn: full-auto');
    expect(prompt).toContain('Approved filesystem scope: unrestricted');
    expect(prompt).toContain('Web access for this run');
    expect(prompt).toContain('Do not ask for the same YOLO permission profile again');
  });

  it('includes active mission state and verification guidance when supplied', () => {
    const prompt = buildTurnPrompt({
      agentId: 'codex',
      agentProfile: {
        id: 'codex',
        providerId: 'codex',
        displayName: 'Codex',
        personaId: 'project-manager',
        personaName: 'Project Manager',
        personaSummary: '',
      },
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'verify this' },
      task: {
        id: 'task-1',
        title: 'Ship command center',
        status: 'verifying',
        goal: 'Make agent work visible',
        repoPath: 'C:/repo',
        acceptanceCriteria: 'Runs are tracked',
        assignedAgents: ['claude', 'codex'],
        capabilityProfile: 'edit',
        summary: 'Implementation is ready for review.',
        missionControl: {
          currentPhase: {
            id: 'phase-1',
            taskId: 'task-1',
            planId: 'plan-1',
            title: 'Verification',
            description: '',
            status: 'active',
            gate: 'Tests pass and findings are resolved',
            sortOrder: 1,
            createdAt: 1,
            updatedAt: 1,
          },
          openChecklistItems: [
            {
              id: 'item-1',
              taskId: 'task-1',
              planId: 'plan-1',
              phaseId: 'phase-1',
              title: 'Run backend tests',
              detail: '',
              status: 'open',
              dependencyIds: [],
              expectedTouches: [],
              parallelism: 'parallel-safe',
              conflictGroup: '',
              workRole: '',
              ownerAgentId: '',
              statusNote: '',
              blockedReason: '',
              councilRequired: false,
              updatedBy: '',
              completedAt: null,
              sortOrder: 1,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          blockedChecklistItems: [
            {
              id: 'item-2',
              taskId: 'task-1',
              planId: 'plan-1',
              phaseId: 'phase-1',
              title: 'Confirm UI contract',
              detail: 'Waiting on frontend',
              status: 'blocked',
              dependencyIds: ['item-1'],
              expectedTouches: [],
              parallelism: 'parallel-safe',
              conflictGroup: '',
              workRole: '',
              ownerAgentId: 'codex',
              statusNote: '',
              blockedReason: 'Waiting on frontend',
              councilRequired: true,
              updatedBy: 'claude',
              completedAt: null,
              sortOrder: 2,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          activePlan: {
            id: 'plan-1',
            taskId: 'task-1',
            title: 'Backend plan',
            body: 'Add tables, repositories, routes, and prompt context.',
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
    });

    expect(prompt).toContain('Active mission: Ship command center (verifying)');
    expect(prompt).toContain('Task capability profile: edit');
    expect(prompt).toContain('Current phase gate: Verification (active)');
    expect(prompt).toContain('Open checklist:');
    expect(prompt).toContain('plan=plan-1');
    expect(prompt).toContain('Blocked checklist:');
    expect(prompt).toContain('Active plan excerpt: Backend plan');
    expect(prompt).toContain('Mission plan protocol:');
    expect(prompt).toContain('/mission-plan');
    expect(prompt).toContain('The active plan is the human-readable agreement and rationale');
    expect(prompt).toContain('Mission phase protocol:');
    expect(prompt).toContain('/mission-phase');
    expect(prompt).toContain('phase: optional phase id or title');
    expect(prompt).toContain('This mission is in verification');
    expect(prompt).toContain('Lane rule: all problems are shared responsibility');
    expect(prompt).toContain('record evidence, hand it off');
  });

  it('describes mission creation protocol when no active mission exists', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      agentProfile: {
        id: 'claude',
        providerId: 'claude',
        displayName: 'Claude',
        personaId: 'project-manager',
        personaName: 'Project Manager',
        personaSummary: '',
      },
      roomName: 'general',
      roomAgents: ['claude', 'codex'],
      history: [],
      newMessage: {
        authorId: 'human',
        authorKind: 'human',
        text: 'draft a mission plan from this doc',
      },
    });

    expect(prompt).toContain('Active mission: none recorded.');
    expect(prompt).toContain('/mission-create');
    expect(prompt).toContain('agents: claude, codex');
    expect(prompt).toContain('After /mission-create in the same reply');
    expect(prompt).toContain('/mission-plan');
    expect(prompt).toContain('/mission-phase');
    expect(prompt).toContain('/mission-task');
  });
});

describe('role-sliced active-mission protocol', () => {
  const baseTask = {
    id: 'task-1',
    title: 'Ship something',
    status: 'active',
    goal: 'Goal',
    repoPath: 'C:/repo',
    acceptanceCriteria: 'Acceptance',
    assignedAgents: ['claude', 'codex'],
    capabilityProfile: 'edit',
    summary: '',
  };

  function build(args: { agentId: string; agentProfile?: any; roomLeadAgentId?: string }) {
    return buildTurnPrompt({
      agentId: args.agentId,
      ...(args.agentProfile ? { agentProfile: args.agentProfile } : {}),
      roomName: 'general',
      ...(args.roomLeadAgentId ? { roomLeadAgentId: args.roomLeadAgentId } : {}),
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'hi' },
      task: baseTask,
    });
  }

  it('worker tier (implementer persona, not lead) skips plan and phase protocols', () => {
    const prompt = build({
      agentId: 'codex-principal-software',
      agentProfile: {
        id: 'codex-principal-software',
        providerId: 'codex',
        displayName: 'Codex',
        personaId: 'principal-software-engineer',
        personaName: 'Principal Software Engineer',
        personaSummary: '',
      },
    });
    expect(prompt).toContain('Mission checklist protocol:');
    expect(prompt).toContain('/mission-task');
    expect(prompt).toContain('Mission receipt protocol:');
    expect(prompt).not.toContain('Mission plan protocol:');
    expect(prompt).not.toContain('Mission phase protocol:');
    expect(prompt).not.toContain('/mission-plan');
    expect(prompt).not.toContain('/mission-phase');
  });

  it('worker tier compact form hands off plan/phase to coordinators', () => {
    const prompt = buildTurnPrompt({
      agentId: 'codex-worker',
      agentProfile: {
        id: 'codex-worker',
        providerId: 'codex',
        displayName: 'Codex Worker',
        personaId: 'principal-software-engineer',
        personaName: 'Principal Software Engineer',
        personaSummary: '',
      },
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'hi' },
      task: baseTask,
      maxPromptChars: 2_500,
    });
    expect(prompt).toContain('Plan and phase changes belong to coordinators');
    expect(prompt).not.toContain('/mission-plan');
    expect(prompt).not.toContain('/mission-phase');
  });

  it('coordinator tier (orchestrator persona) gets plan, phase, task, and receipt', () => {
    const prompt = build({
      agentId: 'codex-pm',
      agentProfile: {
        id: 'codex-pm',
        providerId: 'codex',
        displayName: 'Codex PM',
        personaId: 'project-manager',
        personaName: 'Project Manager',
        personaSummary: '',
      },
    });
    expect(prompt).toContain('Mission plan protocol:');
    expect(prompt).toContain('/mission-plan');
    expect(prompt).toContain('Mission phase protocol:');
    expect(prompt).toContain('/mission-phase');
    expect(prompt).toContain('Mission checklist protocol:');
    expect(prompt).toContain('/mission-task');
    expect(prompt).toContain('Mission receipt protocol:');
    expect(prompt).not.toContain('Plan and phase changes belong to coordinators');
  });

  it('lead tier (matches roomLeadAgentId) gets the full protocol regardless of persona', () => {
    const prompt = build({
      agentId: 'claude-principal-software',
      roomLeadAgentId: 'claude-principal-software',
      agentProfile: {
        id: 'claude-principal-software',
        providerId: 'claude',
        displayName: 'Claude',
        personaId: 'principal-software-engineer',
        personaName: 'Principal Software Engineer',
        personaSummary: '',
      },
    });
    expect(prompt).toContain('Mission plan protocol:');
    expect(prompt).toContain('Mission phase protocol:');
    expect(prompt).toContain('/mission-plan');
    expect(prompt).toContain('/mission-phase');
    expect(prompt).toContain('/mission-task');
  });

  it('externalizes hidden-block protocols when contextFiles.protocolsPath is supplied', () => {
    const prompt = buildTurnPrompt({
      agentId: 'codex-pm',
      agentProfile: {
        id: 'codex-pm',
        providerId: 'codex',
        displayName: 'Codex PM',
        personaId: 'project-manager',
        personaName: 'Project Manager',
        personaSummary: '',
      },
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'hi' },
      task: baseTask,
      contextFiles: {
        transcriptPath: 'data/agent-context/r1/transcript.md',
        recapPath: 'data/agent-context/r1/recap.md',
        protocolsPath: 'data/agent-context/r1/protocols.md',
        omittedMessages: 0,
        recentMessages: 1,
        totalMessages: 1,
      },
    });
    expect(prompt).toContain('Hidden block protocols: data/agent-context/r1/protocols.md');
    expect(prompt).toContain('Plan and phase protocols:');
    expect(prompt).toContain('Task and receipt protocols:');
    expect(prompt).toContain('See data/agent-context/r1/protocols.md');
    // Full inline schemas should not be present
    expect(prompt).not.toContain('## Direction');
    expect(prompt).not.toContain('## Assumptions and Evidence');
    expect(prompt).not.toContain('Mission plan protocol: when the team creates');
    expect(prompt).not.toContain('Mission phase protocol: when you create or update');
    expect(prompt).not.toContain('Mission checklist protocol: when you create, update, complete');
    // Collaboration block also externalized
    expect(prompt).not.toContain('kind: proposal\ntitle: concise claim');
  });

  it('re-injects full schemas when includeFullProtocols is true even with protocols.md present', () => {
    const prompt = buildTurnPrompt({
      agentId: 'codex-pm',
      agentProfile: {
        id: 'codex-pm',
        providerId: 'codex',
        displayName: 'Codex PM',
        personaId: 'project-manager',
        personaName: 'Project Manager',
        personaSummary: '',
      },
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'human', authorKind: 'human', text: 'hi' },
      task: baseTask,
      contextFiles: {
        transcriptPath: 'data/agent-context/r1/transcript.md',
        recapPath: 'data/agent-context/r1/recap.md',
        protocolsPath: 'data/agent-context/r1/protocols.md',
        omittedMessages: 0,
        recentMessages: 1,
        totalMessages: 1,
      },
      includeFullProtocols: true,
    });
    expect(prompt).toContain('Hidden block protocols: data/agent-context/r1/protocols.md');
    expect(prompt).toContain('Mission plan protocol: when the team creates');
    expect(prompt).toContain('Mission phase protocol:');
    expect(prompt).toContain('Mission checklist protocol:');
    expect(prompt).toContain('## Direction');
  });

  it('worker tier suppresses the no-task mission-create scaffold', () => {
    const prompt = buildTurnPrompt({
      agentId: 'codex-principal-software',
      agentProfile: {
        id: 'codex-principal-software',
        providerId: 'codex',
        displayName: 'Codex',
        personaId: 'principal-software-engineer',
        personaName: 'Principal Software Engineer',
        personaSummary: '',
      },
      roomName: 'general',
      roomAgents: ['claude', 'codex-principal-software'],
      history: [],
      newMessage: {
        authorId: 'human',
        authorKind: 'human',
        text: 'create a mission for this',
      },
    });
    expect(prompt).not.toContain('/mission-create');
    expect(prompt).not.toContain('Active mission: none recorded.');
  });
});
