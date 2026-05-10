// server/tests/unit/audit-stream.test.ts
//
// Coverage for the unified audit-stream builder. Verifies that events from
// every source land in the merged feed, that filters and limits work, and
// that the merge order is deterministic.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { createAgentRun } from '../../src/repos/agent-runs.js';
import { addMessage } from '../../src/repos/messages.js';
import { createAgentRunAction } from '../../src/repos/run-actions.js';
import { createMissionCommandEvent } from '../../src/repos/mission-command-events.js';
import { createRoutingDecision } from '../../src/repos/routing-decisions.js';
import { addPermissionRequest } from '../../src/repos/permission-requests.js';
import {
  buildAuditStream,
  AUDIT_EVENT_KINDS,
} from '../../src/activity-stream/audit-stream.js';

describe('buildAuditStream', () => {
  let db: ReturnType<typeof openDatabase>;
  let roomId: string;
  let taskId: string;
  let runId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    roomId = createRoom(db, { name: 'r', agents: ['claude', 'codex'] }).id;
    taskId = createTask(db, { roomId, title: 't' }).id;
    const triggerMessage = addMessage(db, {
      roomId,
      authorId: 'human',
      authorKind: 'human',
      text: 'go',
    });
    const run = createAgentRun(db, {
      roomId,
      taskId,
      agentId: 'claude',
      triggerMessageId: triggerMessage.id,
      promptChars: 0,
      estimatedPromptTokens: 0,
      liveMessages: 0,
      contextArtifacts: 0,
      promptText: '',
      permissionMode: 'plan',
    });
    runId = run.id;
  });

  it('returns events from every source kind it supports', () => {
    createAgentRunAction(db, {
      roomId,
      taskId,
      runId,
      agentId: 'claude',
      kind: 'prompt',
      status: 'info',
      label: 'prompt built',
    });
    createMissionCommandEvent(db, {
      roomId,
      taskId,
      runId,
      agentId: 'claude',
      commandKind: 'mission-task',
      action: 'update',
      status: 'applied',
      summary: 'task updated',
    });
    createRoutingDecision(db, {
      roomId,
      taskId,
      runId,
      authorId: 'human',
      kind: 'human-message',
      action: 'dispatch',
      reason: 'addressed claude',
      responders: ['claude'],
    });
    addPermissionRequest(db, {
      roomId,
      agentId: 'claude',
      mode: 'edit',
      target: 'src/foo.ts',
      reason: 'apply patch',
    });

    const events = buildAuditStream(db, roomId);
    const kinds = new Set(events.map((event) => event.kind));
    expect(kinds.has('run-action')).toBe(true);
    expect(kinds.has('mission-command')).toBe(true);
    expect(kinds.has('routing-decision')).toBe(true);
    expect(kinds.has('permission-request')).toBe(true);
  });

  it('orders events newest-first deterministically', () => {
    createAgentRunAction(db, {
      roomId,
      runId,
      agentId: 'claude',
      kind: 'prompt',
      status: 'info',
      label: 'first',
    });
    // ~5ms gap to ensure created_at differs
    const start = Date.now();
    while (Date.now() - start < 5) {
      // tight loop
    }
    createAgentRunAction(db, {
      roomId,
      runId,
      agentId: 'claude',
      kind: 'prompt',
      status: 'info',
      label: 'second',
    });

    const events = buildAuditStream(db, roomId, { kinds: ['run-action'] });
    expect(events).toHaveLength(2);
    expect(events[0]!.summary).toBe('second');
    expect(events[1]!.summary).toBe('first');
  });

  it('respects the kinds filter', () => {
    createAgentRunAction(db, {
      roomId,
      runId,
      agentId: 'claude',
      kind: 'prompt',
      status: 'info',
      label: 'a',
    });
    createMissionCommandEvent(db, {
      roomId,
      runId,
      agentId: 'claude',
      commandKind: 'mission-task',
      action: 'update',
      status: 'applied',
    });

    const events = buildAuditStream(db, roomId, { kinds: ['run-action'] });
    expect(events.every((event) => event.kind === 'run-action')).toBe(true);
  });

  it('respects the agentId filter', () => {
    createAgentRunAction(db, {
      roomId,
      runId,
      agentId: 'claude',
      kind: 'prompt',
      status: 'info',
      label: 'claude',
    });
    createAgentRunAction(db, {
      roomId,
      runId,
      agentId: 'codex',
      kind: 'prompt',
      status: 'info',
      label: 'codex',
    });

    const events = buildAuditStream(db, roomId, { agentId: 'codex' });
    expect(events.every((event) => event.agentId === 'codex')).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('respects the taskId filter', () => {
    const taskA = createTask(db, { roomId, title: 'A' });
    const taskB = createTask(db, { roomId, title: 'B' });
    createAgentRunAction(db, {
      roomId,
      taskId: taskA.id,
      runId,
      agentId: 'claude',
      kind: 'prompt',
      status: 'info',
      label: 'A action',
    });
    createAgentRunAction(db, {
      roomId,
      taskId: taskB.id,
      runId,
      agentId: 'claude',
      kind: 'prompt',
      status: 'info',
      label: 'B action',
    });

    const events = buildAuditStream(db, roomId, {
      kinds: ['run-action'],
      taskId: taskB.id,
    });
    expect(events.every((event) => event.taskId === taskB.id)).toBe(true);
  });

  it('honors the overall limit', () => {
    for (let i = 0; i < 8; i += 1) {
      createAgentRunAction(db, {
        roomId,
        runId,
        agentId: 'claude',
        kind: 'prompt',
        status: 'info',
        label: `n${i}`,
      });
    }
    const events = buildAuditStream(db, roomId, { limit: 3 });
    expect(events).toHaveLength(3);
  });

  it('exposes every supported kind via AUDIT_EVENT_KINDS', () => {
    expect(AUDIT_EVENT_KINDS).toContain('run-action');
    expect(AUDIT_EVENT_KINDS).toContain('mission-command');
    expect(AUDIT_EVENT_KINDS).toContain('routing-decision');
    expect(AUDIT_EVENT_KINDS).toContain('tool-call');
    expect(AUDIT_EVENT_KINDS).toContain('permission-request');
    expect(AUDIT_EVENT_KINDS).toContain('turn-outcome');
  });
});
