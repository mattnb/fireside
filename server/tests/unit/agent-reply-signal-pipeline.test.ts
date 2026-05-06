import { describe, expect, it } from 'vitest';
import { runAgentReplySignalPipeline } from '../../src/pipelines/reply/run-agent-reply-signal-pipeline.js';

describe('runAgentReplySignalPipeline', () => {
  it('extracts hidden mission and collaboration signals while preserving visible text', () => {
    const result = runAgentReplySignalPipeline({
      agentId: 'codex',
      text: [
        'Audit complete.',
        '/mission-task',
        'action: update',
        'id: task-1',
        'status: done',
        'note: Evidence captured.',
        '/end-mission-task',
        '/collab-note',
        'kind: decision',
        'title: Keep routing modular',
        'body: The team agreed to isolate parsing from side effects.',
        '/end-collab-note',
      ].join('\n'),
    });

    expect(result.missionTasks.updates).toHaveLength(1);
    expect(result.missionTasks.updates[0]).toMatchObject({
      id: 'task-1',
      status: 'done',
    });
    expect(result.collaboration.notes).toHaveLength(1);
    expect(result.collaboration.notes[0]).toMatchObject({
      title: 'Keep routing modular',
      kind: 'decision',
    });
    expect(result.visibleText).toBe('Audit complete.');
  });

  it('extracts permission requests before collaboration notes', () => {
    const result = runAgentReplySignalPipeline({
      agentId: 'claude',
      text: [
        'I need edit access.',
        '/permission-request',
        'mode: edit',
        'target: README.md',
        'reason: Update the usage notes.',
        '',
        '/collab-note',
        'kind: proposal',
        'title: Docs follow-up',
        'body: Update documentation after approval.',
        '/end-collab-note',
      ].join('\n'),
    });

    expect(result.permission?.request).toMatchObject({
      mode: 'edit',
      target: 'README.md',
    });
    expect(result.collaboration.notes).toHaveLength(1);
    expect(result.visibleText).toBe('I need edit access.');
    expect(result.textAfterMissionReceipts).toContain('/permission-request');
  });
});
