import { buildTurnPromptResult } from '../server/src/transcript.ts';

const baseOpts = {
  agentId: 'claude-architecture',
  agentProfile: {
    id: 'claude-architecture',
    displayName: 'Claude (Architecture)',
    providerId: 'claude',
    personaId: 'architecture-reviewer',
    personaName: 'Architecture Reviewer',
  },
  roomName: 'Test',
  roomAgents: ['claude-architecture', 'codex-principal'],
  roomAgentProfiles: [
    {
      id: 'claude-architecture',
      displayName: 'Claude (Architecture)',
      providerId: 'claude',
      personaId: 'architecture-reviewer',
      personaName: 'Architecture Reviewer',
    },
    {
      id: 'codex-principal',
      displayName: 'Codex (Principal)',
      providerId: 'codex',
      personaId: 'principal-software-engineer',
      personaName: 'Principal Software Engineer',
    },
  ],
  history: [],
  newMessage: { authorId: 'matt', authorKind: 'human', text: 'hi' },
  maxHistory: 16,
  maxPromptChars: 16000,
};

const sampleTask = {
  id: 'task1',
  title: 'Reduce token consumption',
  status: 'active',
  goal: 'Cut Fireside per-turn token cost without losing mission state.',
  repoPath: 'C:/Users/Matt/Documents/development/fireside',
  acceptanceCriteria: 'Median prompt < 8000 chars; mission still tracked.',
  assignedAgents: ['claude-architecture', 'codex-principal'],
  capabilityProfile: 'plan',
  summary: 'Multi-agent prompt audit.',
  missionControl: {
    currentPhase: { id: 'p1', title: 'Audit', status: 'active', gate: 'Findings doc reviewed', description: '', sortOrder: 0 },
    openChecklistItems: [
      { id: 'c1', title: 'Map prompt assembly surfaces', status: 'open', planId: null, phaseId: 'p1', detail: '', dependencyIds: [], expectedTouches: ['server/src/transcript.ts'], parallelism: 'parallel-safe', conflictGroup: null, workRole: 'research', ownerAgentId: 'claude-architecture' },
      { id: 'c2', title: 'Quantify protocol overhead', status: 'open', planId: null, phaseId: 'p1', detail: '', dependencyIds: ['c1'], expectedTouches: [], parallelism: 'parallel-safe', conflictGroup: null, workRole: 'research', ownerAgentId: 'codex-principal' },
      { id: 'c3', title: 'Recommend wins', status: 'open', planId: null, phaseId: 'p1', detail: '', dependencyIds: ['c1', 'c2'], expectedTouches: [], parallelism: 'coordinate', conflictGroup: null, workRole: 'docs', ownerAgentId: 'claude-architecture' },
    ],
    blockedChecklistItems: [],
    activePlan: { id: 'pl1', title: 'Audit plan', status: 'active', body: '## Direction\nAudit prompt assembly to find token wins.\n## Assumptions\nMost prompts hit the cap.\n## Execution\nMap, quantify, propose.', sortOrder: 0, createdAt: 0, updatedAt: 0 },
  },
};

const sampleCollab = [
  { kind: 'proposal', status: 'open', title: 'Compress mission protocol', agentId: 'claude-architecture', confidence: 'high', target: 'transcript.ts', body: 'Move full protocol text to a system primer once per session', evidence: ['file:server/src/transcript.ts:422'] },
  { kind: 'evidence', status: 'informational', title: 'Median prompt 16K chars', agentId: 'codex-principal', confidence: 'high', evidence: ['db:agent_runs sample n=500'] },
];

const sampleContextFiles = {
  transcriptPath: 'data/agent-context/r1/transcript.md',
  recapPath: 'data/agent-context/r1/recap.md',
  protocolsPath: 'data/agent-context/r1/protocols.md',
  omittedMessages: 12,
  recentMessages: 17,
  totalMessages: 29,
  artifactCount: 0,
  fixtureCount: 0,
  largeMessageThresholdChars: 6000,
};

const samplePermissionEdit = {
  agentId: 'claude-architecture',
  mode: 'edit',
  target: 'C:/Users/Matt/Documents/development/fireside',
  reason: 'edit transcript.ts',
  capabilities: ['read', 'edit-existing', 'create-file'],
  targetExists: true,
  targetKind: 'directory',
  providerProfile: 'acceptEdits',
  source: 'task',
};

const samplePermissionYolo = {
  agentId: 'claude-architecture',
  mode: 'full-auto',
  target: 'C:/Users/Matt/Documents/development/fireside',
  reason: 'YOLO',
  capabilities: ['read', 'edit-existing', 'create-file', 'run-command'],
  targetExists: true,
  targetKind: 'directory',
  providerProfile: 'bypassPermissions',
  source: 'yolo',
};

const sampleWorkLane = {
  id: 'c1',
  title: 'Map prompt assembly surfaces',
  detail: 'audit transcript.ts',
  status: 'open',
  planId: null,
  phaseId: 'p1',
  expectedTouches: ['server/src/transcript.ts'],
  parallelism: 'parallel-safe',
  conflictGroup: null,
  workRole: 'research',
  ownerAgentId: 'claude-architecture',
};

const sampleYoloDiscussion = { round: 2, maxRounds: 5, repliesUsed: 1, maxRepliesPerAgent: 5, mode: 'yolo', totalRepliesUsed: 7, maxTotalReplies: 100 };

function probe(label, opts) {
  const r = buildTurnPromptResult(opts);
  console.log(label.padEnd(60), 'chars=', String(r.prompt.length).padStart(6), 'tokens=', String(r.stats.estimatedPromptTokens).padStart(5), 'detail=', r.stats.detailLevel);
  return r;
}

const bare = probe('1. Bare (no task/perm/collab/contextfiles)', baseOpts);
const t = probe('2. + active mission (full mission control)', { ...baseOpts, task: sampleTask });
const tc = probe('3. + collab ledger (2 items)', { ...baseOpts, task: sampleTask, collaboration: sampleCollab });
const tcf = probe('4. + context-files block', { ...baseOpts, task: sampleTask, collaboration: sampleCollab, contextFiles: sampleContextFiles });
const tcfp = probe('5. + edit permission grant', { ...baseOpts, task: sampleTask, collaboration: sampleCollab, contextFiles: sampleContextFiles, permission: samplePermissionEdit });
const yolo = probe('6. + YOLO perm + work lane + discussion', { ...baseOpts, task: sampleTask, collaboration: sampleCollab, contextFiles: sampleContextFiles, permission: samplePermissionYolo, workLane: sampleWorkLane, discussion: sampleYoloDiscussion });

console.log('\n=== ABSOLUTE OVERHEAD (no transcript history at all) ===');
console.log('Bare shell ............', bare.prompt.length, 'chars =', bare.stats.estimatedPromptTokens, 'tokens');
console.log('Mission added ..........', t.prompt.length - bare.prompt.length, 'chars (+', t.stats.estimatedPromptTokens - bare.stats.estimatedPromptTokens, 'tokens)');
console.log('Collab ledger added ....', tc.prompt.length - t.prompt.length, 'chars');
console.log('Context-files block ....', tcf.prompt.length - tc.prompt.length, 'chars');
console.log('Edit permission ........', tcfp.prompt.length - tcf.prompt.length, 'chars');
console.log('YOLO + work lane added .', yolo.prompt.length - tcf.prompt.length, 'chars (vs prior ctx)');

console.log('\n=== BARE PROMPT (the always-on shell every turn pays for) ===\n');
console.log(bare.prompt);
console.log('\n=== TYPICAL YOLO PROMPT ===\n');
console.log(yolo.prompt);
