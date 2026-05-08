import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { buildPermissionGrant } from '../../src/permissions.js';
import { listPermissionRequests } from '../../src/repos/permission-requests.js';
import { getTask } from '../../src/repos/tasks.js';
import { routePermissionRequest } from '../../src/tools/adapters/hidden-command-adapter.js';
import { executeToolCall } from '../../src/tools/execute-tool-call.js';
import { permissionRequestTool } from '../../src/tools/handlers/permission-tools.js';
import { createToolRegistry } from '../../src/tools/registry.js';

describe('permission.request tool routing', () => {
  it('routes a hidden /permission-request through the tool engine and creates a pending request', async () => {
    const { db, mission } = seedPermissionDb('run-happy');
    const currentGrant = buildPermissionGrant({
      agentId: 'codex',
      source: 'task',
      mode: 'plan',
      target: 'C:/work/project',
      reason: 'plan-mode run can request elevation',
    });
    const requested = buildPermissionGrant({
      agentId: 'codex',
      mode: 'edit',
      target: 'docs/admin-deploy.md',
      reason: 'Write the canonical admin deploy runbook.',
    });

    const outcome = await routePermissionRequest(
      {
        db,
        roomId: 'room-1',
        mission,
        runId: 'run-happy',
        agentId: 'codex',
        permission: currentGrant,
      },
      requested,
    );

    expect(outcome.toolCall).toMatchObject({
      toolName: 'permission.request',
      status: 'applied',
    });
    expect(outcome.toolCall.result?.effects).toMatchObject([
      {
        kind: 'permission-requested',
        targetType: 'permission-request',
      },
    ]);
    expect(outcome.request).toMatchObject({
      agentId: 'codex',
      mode: 'edit',
      target: 'docs/admin-deploy.md',
      status: 'pending',
    });
    expect(auditRows(db)).toMatchObject([
      {
        tool_name: 'permission.request',
        source: 'hidden-command',
        status: 'applied',
      },
    ]);
    db.close();
  });

  it('deduplicates a retried hidden /permission-request without creating another request row', async () => {
    const { db, mission } = seedPermissionDb('run-duplicate');
    const requested = buildPermissionGrant({
      agentId: 'codex',
      mode: 'edit',
      target: 'docs/admin-deploy.md',
      reason: 'Write the canonical admin deploy runbook.',
    });

    const first = await routePermissionRequest(
      {
        db,
        roomId: 'room-1',
        mission,
        runId: 'run-duplicate',
        agentId: 'codex',
        permission: null,
        now: () => 1000,
      },
      requested,
    );
    const second = await routePermissionRequest(
      {
        db,
        roomId: 'room-1',
        mission,
        runId: 'run-duplicate',
        agentId: 'codex',
        permission: null,
        now: () => 1001,
      },
      requested,
    );

    expect(first.toolCall.status).toBe('applied');
    expect(second.toolCall).toMatchObject({
      status: 'duplicate',
      duplicateOfCallId: first.toolCall.callId,
    });
    expect(second.request?.id).toBe(first.request?.id);
    expect(listPermissionRequests(db, 'room-1')).toHaveLength(1);
    expect(auditRows(db).map((row) => row.status)).toEqual(['applied', 'duplicate']);
    db.close();
  });

  it('records permission_denied when the caller lacks permission:request', async () => {
    const { db } = seedPermissionDb('run-denied');
    const registry = createToolRegistry();
    registry.register(permissionRequestTool);

    const outcome = await executeToolCall({
      db,
      registry,
      call: {
        id: 'denied-permission-request',
        tool: 'permission.request',
        idempotencyKey: 'run-denied:permission.request:docs-admin-deploy-md:abc123',
        args: {
          mode: 'edit',
          target: 'docs/admin-deploy.md',
          reason: 'Write the canonical admin deploy runbook.',
        },
        source: 'replay',
        roomId: 'room-1',
        missionId: 'mission-1',
        runId: 'run-denied',
        messageId: null,
        agentId: 'codex',
        createdAt: 1,
      },
      statePermissions: ['mission:read'],
      now: () => 2,
    });

    expect(outcome).toMatchObject({
      status: 'permission_denied',
      error: 'Missing state permission: permission:request',
    });
    expect(listPermissionRequests(db, 'room-1')).toHaveLength(0);
    expect(auditRows(db)).toMatchObject([
      {
        tool_name: 'permission.request',
        status: 'permission_denied',
        applied_at: null,
      },
    ]);
    db.close();
  });
});

function seedPermissionDb(runId: string) {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO rooms (id, name, created_at, agents_json, yolo_agents_json)
     VALUES ('room-1', 'room', 1, '[]', '[]')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (
      id, room_id, title, goal, repo_path, acceptance_criteria, agents_json, status,
      capability_profile, summary, created_at, updated_at
    ) VALUES ('mission-1', 'room-1', 'permission mission', '', '', '', '[]', 'active',
      'plan', '', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_runs (
      id, room_id, task_id, trigger_message_id, agent_id, status, permission_mode,
      prompt_chars, estimated_prompt_tokens, live_messages, context_artifacts, started_at
    ) VALUES (?, 'room-1', 'mission-1', 'trigger-msg', 'codex', 'completed', 'plan',
      0, 0, 0, 0, 1)`,
  ).run(runId);
  const refreshed = getTask(db, 'mission-1');
  if (!refreshed) throw new Error('mission seed failed');
  return { db, mission: refreshed };
}

function auditRows(db: ReturnType<typeof openDatabase>): AgentToolCallAuditRow[] {
  return db
    .prepare('SELECT * FROM agent_tool_calls ORDER BY created_at ASC, id ASC')
    .all() as AgentToolCallAuditRow[];
}

interface AgentToolCallAuditRow {
  tool_name: string;
  source: string;
  status: string;
  applied_at: number | null;
}
