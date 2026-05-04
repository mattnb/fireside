import { describe, expect, it } from 'vitest';
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
});
