import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { Broker } from '../../src/broker.js';
import { buildHttpServer, type HttpServer } from '../../src/http-server.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { addMessage } from '../../src/repos/messages.js';
import { createCollaborationItem } from '../../src/repos/collaboration.js';

describe('mission control HTTP endpoints', () => {
  let app: HttpServer | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('creates mission-control records and returns the task control snapshot', async () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'mission', agents: ['codex'] });
    const task = createTask(db, { roomId: room.id, title: 'Ship mission control' });
    const broker = new Broker({
      db,
      getSpec: () => undefined,
      runAgent: async () => ({ text: '', sessionId: null, raw: { stdout: '', stderr: '' } }),
    });
    app = buildHttpServer({ db, broker, uiDir: process.cwd() });

    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Crucible' },
    });
    expect(projectResponse.statusCode).toBe(200);
    const project = projectResponse.json<{ id: string; name: string }>();
    expect(project.name).toBe('Crucible');

    const missionResponse = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { name: 'UX lane', projectId: project.id, agents: ['codex'], yoloAgents: ['codex'] },
    });
    expect(missionResponse.statusCode).toBe(200);
    expect(missionResponse.json<{ projectId: string }>().projectId).toBe(project.id);

    const phaseResponse = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/tasks/${task.id}/phases`,
      payload: { title: 'Implementation', status: 'active', gate: 'Tests pass' },
    });
    expect(phaseResponse.statusCode).toBe(200);
    const phase = phaseResponse.json<{ id: string }>();

    const checklistResponse = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/tasks/${task.id}/checklist`,
      payload: { title: 'Wire context', phaseId: phase.id },
    });
    expect(checklistResponse.statusCode).toBe(200);

    const planResponse = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/tasks/${task.id}/plans`,
      payload: {
        title: 'Backend plan',
        body: 'Add tables, routes, and prompt context.',
        status: 'active',
      },
    });
    expect(planResponse.statusCode).toBe(200);

    const controlResponse = await app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/tasks/${task.id}/control`,
    });
    expect(controlResponse.statusCode).toBe(200);
    expect(controlResponse.json()).toMatchObject({
      task: { id: task.id },
      currentPhase: { title: 'Implementation', gate: 'Tests pass' },
      openChecklistItems: [{ title: 'Wire context' }],
      activePlan: { title: 'Backend plan' },
    });

    addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: 'capture this mission state',
    });
    const briefingResponse = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/briefings`,
      payload: { createdBy: 'human' },
    });
    expect(briefingResponse.statusCode).toBe(200);
    const briefing = briefingResponse.json<{
      id: string;
      roomId: string;
      taskId: string;
      messageCount: number;
      payload: {
        task: { id: string };
        phases: Array<{ title: string }>;
        checklistItems: Array<{ title: string }>;
        plans: Array<{ title: string }>;
        messages: Array<{ text: string }>;
      };
    }>();
    expect(briefing.roomId).toBe(room.id);
    expect(briefing.taskId).toBe(task.id);
    expect(briefing.messageCount).toBe(1);
    expect(briefing.payload).toMatchObject({
      task: { id: task.id },
      phases: [{ title: 'Implementation' }],
      checklistItems: [{ title: 'Wire context' }],
      plans: [{ title: 'Backend plan' }],
      messages: [{ text: 'capture this mission state' }],
    });

    const listResponse = await app.inject({ method: 'GET', url: '/api/briefings' });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<Array<{ id: string }>>()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: briefing.id })]),
    );

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/briefings/${briefing.id}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json<{ payload: { task: { id: string } } }>().payload.task.id).toBe(
      task.id,
    );

    const nextMissionResponse = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/tasks`,
      payload: { title: 'Next mission', goal: 'Reuse the same team.' },
    });
    expect(nextMissionResponse.statusCode).toBe(200);
    const nextMission = nextMissionResponse.json<{ id: string }>();

    let tasksResponse = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/tasks` });
    expect(tasksResponse.statusCode).toBe(200);
    expect(tasksResponse.json<Array<{ id: string; status: string }>>()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: task.id, status: 'paused' }),
        expect.objectContaining({ id: nextMission.id, status: 'active' }),
      ]),
    );

    const resumeResponse = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room.id}/tasks/${task.id}`,
      payload: { status: 'active' },
    });
    expect(resumeResponse.statusCode).toBe(200);
    tasksResponse = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/tasks` });
    expect(tasksResponse.json<Array<{ id: string; status: string }>>()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: task.id, status: 'active' }),
        expect.objectContaining({ id: nextMission.id, status: 'paused' }),
      ]),
    );

    createCollaborationItem(db, {
      roomId: room.id,
      taskId: task.id,
      agentId: 'codex',
      kind: 'decision',
      status: 'accepted',
      title: 'current mission note',
      body: 'This belongs to the resumed mission.',
    });
    createCollaborationItem(db, {
      roomId: room.id,
      taskId: nextMission.id,
      agentId: 'codex',
      kind: 'decision',
      status: 'accepted',
      title: 'paused mission note',
      body: 'This belongs to the paused mission.',
    });

    const collaborationResponse = await app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/collaboration?taskId=${task.id}`,
    });
    expect(collaborationResponse.statusCode).toBe(200);
    expect(collaborationResponse.json<Array<{ taskId: string; title: string }>>()).toEqual([
      expect.objectContaining({ taskId: task.id, title: 'current mission note' }),
    ]);
    db.close();
  });
});
