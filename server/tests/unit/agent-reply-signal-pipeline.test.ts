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

  // Regression for the hallucinated `<!--FIRESIDE:<name> v=N ... /end-<name>-->`
  // envelope agents emit when they confuse the deprecated `<!-- fireside-tool -->`
  // shape with the canonical slash-block fallback. Before the normalizer step
  // landed, the envelope's `<!--FIRESIDE:` prefix carried word chars that
  // `hiddenBlockRegex` rejects, so every extractor missed the payload and the
  // entire envelope leaked into visible chat (see 118 historical leaks in
  // data/fireside.sqlite at the time of the fix).
  it('normalizes a hallucinated <!--FIRESIDE:...--> envelope and routes the payload through extractors', () => {
    const result = runAgentReplySignalPipeline({
      agentId: 'claude',
      text: [
        'Closing the lane.',
        '<!--FIRESIDE:mission-task v=1',
        'action: update',
        'id: lane-7',
        'status: done',
        'note: Verified end-to-end.',
        '/end-mission-task-->',
        '<!--FIRESIDE:collab-note v=1',
        'kind: decision',
        'summary: Lane 7 accepted at HEAD.',
        '/end-collab-note-->',
      ].join('\n'),
    });

    expect(result.missionTasks.updates).toHaveLength(1);
    expect(result.missionTasks.updates[0]).toMatchObject({
      id: 'lane-7',
      status: 'done',
    });
    expect(result.collaboration.notes).toHaveLength(1);
    expect(result.collaboration.notes[0]).toMatchObject({
      kind: 'decision',
      title: 'Lane 7 accepted at HEAD.',
    });
    expect(result.visibleText).toBe('Closing the lane.');
    expect(result.visibleText).not.toContain('<!--FIRESIDE:');
    expect(result.visibleText).not.toContain('-->');
    expect(result.visibleText).not.toContain('/end-mission-task');
    expect(result.visibleText).not.toContain('/end-collab-note');
  });
});
