import { describe, expect, it } from 'vitest';
import { runAgentReplySignalPipeline } from '../../src/pipelines/reply/run-agent-reply-signal-pipeline.js';

// Phase 2 (2026-05-09) removed all `extract-*` steps. The pipeline now
// only sanitizes leaked tool envelopes and slash-block-shaped payloads
// out of the visible chat surface so they don't reach the user as raw
// text. MCP is the canonical and only mission/collab/permission tool
// entry point — these tests pin the chat-cleanup contract that survived
// the migration.

describe('runAgentReplySignalPipeline', () => {
  it('preserves prose when no slash-block-shaped payload is present', () => {
    const result = runAgentReplySignalPipeline({
      agentId: 'codex',
      text: 'Audit complete. No mission state changed.',
    });

    expect(result.visibleText).toBe('Audit complete. No mission state changed.');
  });

  it('strips a hallucinated <!--FIRESIDE:...--> envelope from visible chat', () => {
    // Regression for the malformed envelope agents emit when they confuse
    // the deprecated `<!-- fireside-tool -->` shape with the canonical
    // slash-block fallback. Pre-Phase-2 the envelope was normalized into
    // a slash-block form so extractors could route it; post-Phase-2 the
    // entire envelope is stripped because there's no extractor to feed.
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
      ].join('\n'),
    });

    expect(result.visibleText).toBe('Closing the lane.');
    expect(result.visibleText).not.toContain('<!--FIRESIDE:');
    expect(result.visibleText).not.toContain('/end-mission-task');
  });

  it('strips plain `/<name> ... /end-<name>` slash blocks an agent might emit directly', () => {
    // If an agent regresses to slash-block syntax (despite prompts now
    // teaching MCP exclusively), the block would have appeared verbatim
    // in chat after Phase 2 removed extractors. The defensive sanitizer
    // hides it.
    const result = runAgentReplySignalPipeline({
      agentId: 'codex',
      text: [
        'Audit complete.',
        '/mission-task',
        'action: update',
        'id: task-1',
        'status: done',
        '/end-mission-task',
        'Continuing on the next item.',
      ].join('\n'),
    });

    expect(result.visibleText).not.toContain('/mission-task');
    expect(result.visibleText).not.toContain('/end-mission-task');
    expect(result.visibleText).toContain('Audit complete.');
    expect(result.visibleText).toContain('Continuing on the next item.');
  });

  it('strips both envelope and slash-block forms in the same reply', () => {
    const result = runAgentReplySignalPipeline({
      agentId: 'claude',
      text: [
        'Lane 7 finished.',
        '<!--FIRESIDE:mission-task v=1',
        'action: update',
        'id: lane-7',
        'status: done',
        '/end-mission-task-->',
        '/collab-note',
        'kind: decision',
        'title: Keep routing modular',
        '/end-collab-note',
        'Tests are green.',
      ].join('\n'),
    });

    expect(result.visibleText).not.toContain('<!--FIRESIDE:');
    expect(result.visibleText).not.toContain('/collab-note');
    expect(result.visibleText).not.toContain('/end-mission-task');
    expect(result.visibleText).toContain('Lane 7 finished.');
    expect(result.visibleText).toContain('Tests are green.');
  });

  it('still strips canonical <!-- fireside-tool ... --> envelopes', () => {
    const result = runAgentReplySignalPipeline({
      agentId: 'codex',
      text: [
        'Standby.',
        '<!-- fireside-tool',
        'name: mission.receipt.submit',
        'args: { "status": "continuing" }',
        '/end-fireside-tool -->',
      ].join('\n'),
    });

    expect(result.visibleText).toBe('Standby.');
    expect(result.visibleText).not.toContain('<!-- fireside-tool');
  });
});
