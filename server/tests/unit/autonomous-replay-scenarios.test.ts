import { describe, expect, it } from 'vitest';
import { replayAgentReplyEffects, replayProviderOutput } from '../../src/simulation/run-replay.js';
import { codexSpec } from '../../src/agents/codex.js';

describe('autonomous replay scenarios', () => {
  it('classifies hidden-only checklist progress as mission state without visible chat', () => {
    const effects = replayAgentReplyEffects({
      agentId: 'codex',
      text: [
        '/mission-task',
        'action: update',
        'id: item-1',
        'status: done',
        'note: verified in replay',
        '/end-mission-task',
      ].join('\n'),
    });

    expect(effects).toMatchObject({
      visibleText: '',
      missionTasks: 1,
      missionReceipts: 0,
      permissionRequested: false,
    });
  });

  it('detects a permission request buried after visible prose', () => {
    const effects = replayAgentReplyEffects({
      agentId: 'claude',
      text: [
        'I need one scoped operation before continuing.',
        '',
        '/permission-request',
        'mode: bash',
        'target: C:/work/project',
        'reason: run the verification command',
      ].join('\n'),
    });

    expect(effects).toMatchObject({
      visibleText: 'I need one scoped operation before continuing.',
      permissionRequested: true,
    });
  });

  it('turns malformed provider output into a replay failure instead of throwing', () => {
    const replay = replayProviderOutput({
      provider: 'codex',
      spec: codexSpec,
      stdout: '',
      stderr: 'fatal: no rollout found',
    });

    expect(replay).toMatchObject({
      ok: false,
      error: expect.stringContaining('no JSONL events on stdout'),
    });
  });
});
