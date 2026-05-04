import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db.js';
import { addMessage } from '../../src/repos/messages.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { prepareAgentTurnContext } from '../../src/orchestration/agent-turn-context.js';

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
      resumeCliSessions: false,
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
      resumeCliSessions: false,
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
});
