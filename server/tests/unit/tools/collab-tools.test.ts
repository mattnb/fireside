import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/db.js';
import { createTask } from '../../../src/repos/tasks.js';
import {
  getCollaborationItem,
  listCollaborationItems,
} from '../../../src/repos/collaboration.js';
import {
  ensureMissionTaskToolsRegistered,
  routeCollaborationNotes,
} from '../../../src/tools/adapters/hidden-command-adapter.js';
import { executeToolCall } from '../../../src/tools/execute-tool-call.js';
import { defaultToolRegistry } from '../../../src/tools/registry.js';
import type { ParsedCollaborationNote } from '../../../src/collaboration-notes.js';

describe('collab.note.add via hidden-command adapter', () => {
  it('persists a note, writes one applied audit row, and emits activity-created', async () => {
    ensureMissionTaskToolsRegistered();
    const { db, missionId } = seedRoomWithMission();

    const outcome = await routeCollaborationNotes(
      {
        db,
        roomId: 'room-1',
        taskId: missionId,
        runId: 'run-1',
        agentId: 'codex',
        recordRunAction: () => undefined,
      },
      [note('proposal', 'use tool ledger', 'shipped via tool engine')],
    );

    expect(outcome.applied).toBe(1);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]).toMatchObject({
      toolName: 'collab.note.add',
      status: 'applied',
    });
    expect(outcome.toolCalls[0]!.result?.effects[0]).toMatchObject({
      kind: 'activity-created',
      targetType: 'collab-note',
    });

    const items = listCollaborationItems(db, 'room-1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'proposal',
      status: 'open',
      title: 'use tool ledger',
      body: 'shipped via tool engine',
    });

    const auditRows = db
      .prepare('SELECT tool_name, status, source FROM agent_tool_calls WHERE run_id = ?')
      .all('run-1') as { tool_name: string; status: string; source: string }[];
    expect(auditRows).toEqual([
      { tool_name: 'collab.note.add', status: 'applied', source: 'hidden-command' },
    ]);
    db.close();
  });

  it('collapses an exact-duplicate retry into one applied row plus one duplicate row', async () => {
    ensureMissionTaskToolsRegistered();
    const { db, missionId } = seedRoomWithMission();

    await routeCollaborationNotes(
      ctx(db, missionId),
      [note('decision', 'go with single bundle', 'fewer rebases')],
    );
    const second = await routeCollaborationNotes(
      ctx(db, missionId),
      [note('decision', 'go with single bundle', 'fewer rebases')],
    );

    expect(second.toolCalls[0]?.status).toBe('duplicate');
    const items = listCollaborationItems(db, 'room-1');
    expect(items).toHaveLength(1);

    const auditRows = db
      .prepare('SELECT status FROM agent_tool_calls WHERE run_id = ? ORDER BY created_at ASC')
      .all('run-1') as { status: string }[];
    expect(auditRows.map((r) => r.status)).toEqual(['applied', 'duplicate']);
    db.close();
  });

  it('denies under a plan-mode permission grant', async () => {
    ensureMissionTaskToolsRegistered();
    const { db, missionId } = seedRoomWithMission();
    const planGrant = {
      mode: 'plan' as const,
      source: 'task' as const,
      target: 'C:/work/project',
      reason: 'plan-mode test grant',
      requestedMode: 'plan',
      capabilities: ['read'] as ['read'],
      targetExists: null,
      targetKind: 'directory' as const,
      targetResolvedPath: '',
      targetCheckedAt: 0,
      providerProfile: '',
    };

    const outcome = await routeCollaborationNotes(
      { ...ctx(db, missionId), permission: planGrant },
      [note('challenge', 'this approach is risky', 'cite ADR-3')],
    );

    expect(outcome.toolCalls[0]?.status).toBe('permission_denied');
    expect(outcome.applied).toBe(0);
    expect(listCollaborationItems(db, 'room-1')).toHaveLength(0);
    db.close();
  });
});

describe('collab.note.update via direct tool call', () => {
  it('updates an existing note and emits activity-created', async () => {
    ensureMissionTaskToolsRegistered();
    const { db, missionId } = seedRoomWithMission();
    const adder = await routeCollaborationNotes(
      ctx(db, missionId),
      [note('proposal', 'land it', 'looks good to me')],
    );
    const newId = (adder.toolCalls[0]?.result?.data as { id?: string } | undefined)?.id;
    expect(newId).toBeTruthy();

    const outcome = await executeToolCall({
      db,
      registry: defaultToolRegistry,
      call: {
        id: 'mcp-call-1',
        tool: 'collab.note.update',
        idempotencyKey: 'mcp:test:collab-update:1',
        args: { id: newId!, status: 'accepted', body: 'merged in main' },
        source: 'mcp',
        roomId: 'room-1',
        missionId,
        runId: 'run-1',
        messageId: null,
        agentId: 'codex',
        createdAt: Date.now(),
      },
      statePermissions: ['collab:write'],
    });

    expect(outcome).toMatchObject({ status: 'applied', toolName: 'collab.note.update' });
    const reloaded = getCollaborationItem(db, newId!);
    expect(reloaded).toMatchObject({ status: 'accepted', body: 'merged in main' });
    db.close();
  });

  it('rejects collab.note.update for a missing note id', async () => {
    ensureMissionTaskToolsRegistered();
    const { db, missionId } = seedRoomWithMission();
    const outcome = await executeToolCall({
      db,
      registry: defaultToolRegistry,
      call: {
        id: 'mcp-call-2',
        tool: 'collab.note.update',
        idempotencyKey: 'mcp:test:collab-update-missing',
        args: { id: 'note-does-not-exist', status: 'accepted' },
        source: 'mcp',
        roomId: 'room-1',
        missionId,
        runId: 'run-1',
        messageId: null,
        agentId: 'codex',
        createdAt: Date.now(),
      },
      statePermissions: ['collab:write'],
    });

    expect(outcome).toMatchObject({ status: 'rejected' });
    expect(outcome.summary).toMatch(/note-does-not-exist not found/);
    db.close();
  });
});

function seedRoomWithMission() {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO rooms (id, name, created_at, agents_json, yolo_agents_json)
     VALUES ('room-1', 'room', 1, '[]', '[]')`,
  ).run();
  const mission = createTask(db, {
    roomId: 'room-1',
    title: 'collab test mission',
    capabilityProfile: 'edit',
  });
  db.prepare(
    `INSERT INTO agent_runs (
      id, room_id, task_id, trigger_message_id, agent_id, status, permission_mode,
      prompt_chars, estimated_prompt_tokens, live_messages, context_artifacts, started_at
    ) VALUES ('run-1', 'room-1', ?, 'trigger-msg', 'codex', 'completed', 'edit',
      0, 0, 0, 0, 1)`,
  ).run(mission.id);
  return { db, missionId: mission.id };
}

function ctx(db: ReturnType<typeof openDatabase>, missionId: string) {
  return {
    db,
    roomId: 'room-1',
    taskId: missionId,
    runId: 'run-1',
    agentId: 'codex',
    recordRunAction: () => undefined,
  };
}

function note(
  kind: ParsedCollaborationNote['kind'],
  title: string,
  body: string,
): ParsedCollaborationNote {
  return {
    kind,
    status: kind === 'decision' ? 'accepted' : 'open',
    confidence: '',
    title,
    target: '',
    body,
    evidence: [],
  };
}
