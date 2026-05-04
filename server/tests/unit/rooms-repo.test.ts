// server/tests/unit/rooms-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import {
  createRoom,
  deleteRoom,
  getRoom,
  listRooms,
  setRoomLeadAgent,
  setRoomAgents,
} from '../../src/repos/rooms.js';
import { addMessage, listMessages } from '../../src/repos/messages.js';
import {
  addPermissionRequest,
  listPermissionRequests,
} from '../../src/repos/permission-requests.js';
import { createAgentRun, listAgentRuns } from '../../src/repos/agent-runs.js';
import { getCliSessionId, upsertCliSessionId } from '../../src/repos/sessions.js';
import { createTask, listTasks, updateTask } from '../../src/repos/tasks.js';
import { createProject, listProjects } from '../../src/repos/projects.js';
import { validateRoomParticipantNames } from '../../src/agents/profiles.js';

describe('rooms repo', () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('creates and retrieves a room', () => {
    const room = createRoom(db, { name: 'general', agents: ['claude', 'codex'] });
    expect(room.id).toMatch(/.+/);
    expect(room.name).toBe('general');
    expect(room.agents).toEqual(['claude', 'codex']);
    expect(room.createdAt).toBeGreaterThan(0);

    const fetched = getRoom(db, room.id);
    expect(fetched).toEqual(room);
  });

  it('returns null when room not found', () => {
    expect(getRoom(db, 'nonexistent')).toBeNull();
  });

  it('lists rooms in creation order', () => {
    createRoom(db, { name: 'a', agents: [] });
    createRoom(db, { name: 'b', agents: [] });
    const rooms = listRooms(db);
    expect(rooms.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('assigns rooms to projects and defaults existing callers to General', () => {
    const project = createProject(db, { name: 'Crucible' });
    const scoped = createRoom(db, {
      name: 'ux audit',
      projectId: project.id,
      agents: ['claude'],
    });
    const fallback = createRoom(db, { name: 'general lane', agents: [] });

    expect(scoped.projectId).toBe(project.id);
    expect(getRoom(db, scoped.id)?.projectId).toBe(project.id);
    expect(fallback.projectId).toBe('general');
    expect(listProjects(db).map((item) => item.name)).toEqual(
      expect.arrayContaining(['General', 'Crucible']),
    );
  });

  it('updates room agents', () => {
    const room = createRoom(db, { name: 'general', agents: ['claude'] });
    setRoomAgents(db, room.id, ['claude', 'codex', 'gemini']);
    expect(getRoom(db, room.id)!.agents).toEqual(['claude', 'codex', 'gemini']);
  });

  it('stores multiple instances from the same provider with personas', () => {
    const room = createRoom(db, {
      name: 'specialists',
      agentProfiles: [
        {
          id: 'claude-security',
          providerId: 'claude',
          displayName: 'Claude Security',
          personaId: 'security-engineer',
          personaName: 'Security Engineer',
          personaSummary: '',
        },
        {
          id: 'claude-reliability',
          providerId: 'claude',
          displayName: 'Claude Reliability',
          personaId: 'reliability-engineer',
          personaName: 'Reliability Engineer',
          personaSummary: '',
        },
      ],
      yoloAgents: ['claude-reliability'],
    });

    expect(room.agents).toEqual(['claude-security', 'claude-reliability']);
    expect(room.yoloAgents).toEqual(['claude-reliability']);
    expect(room.agentProfiles.map((profile) => profile.providerId)).toEqual(['claude', 'claude']);
    expect(getRoom(db, room.id)?.agentProfiles.map((profile) => profile.personaId)).toEqual([
      'security-engineer',
      'reliability-engineer',
    ]);
  });

  it('persists and clears a room team lead', () => {
    const room = createRoom(db, {
      name: 'lead room',
      agents: ['claude', 'codex'],
      leadAgentId: 'codex',
    });

    expect(room.leadAgentId).toBe('codex');
    expect(getRoom(db, room.id)?.leadAgentId).toBe('codex');

    setRoomAgents(db, room.id, ['claude']);
    expect(getRoom(db, room.id)?.leadAgentId).toBeNull();

    expect(setRoomLeadAgent(db, room.id, 'claude')?.leadAgentId).toBe('claude');
    expect(setRoomLeadAgent(db, room.id, 'codex')?.leadAgentId).toBeNull();
  });

  it('deduplicates room display names without collapsing provider instances', () => {
    const room = createRoom(db, {
      name: 'named specialists',
      agentProfiles: [
        {
          id: 'claude-a',
          providerId: 'claude',
          displayName: 'Claude',
          personaId: 'generalist',
          personaName: 'Generalist',
          personaSummary: '',
        },
        {
          id: 'claude-b',
          providerId: 'claude',
          displayName: 'Claude',
          personaId: 'generalist',
          personaName: 'Generalist',
          personaSummary: '',
        },
      ],
    });

    expect(room.agents).toEqual(['claude-a', 'claude-b']);
    expect(room.agentProfiles.map((profile) => profile.displayName)).toEqual([
      'Claude',
      'Claude Jr.',
    ]);
  });

  it('flags participant name and handle conflicts against the human', () => {
    const errors = validateRoomParticipantNames({
      humanName: 'Matt',
      agentProfiles: [
        {
          id: 'claude-project-manager',
          providerId: 'claude',
          displayName: 'Matt',
        },
      ],
    });

    expect(errors).toContain('agent "Matt" name "Matt" conflicts with human "Matt"');
    expect(errors).toContain('agent "Matt" handle @matt conflicts with human "Matt"');
  });

  it('preserves explicit provider overrides when the agent id has a different provider prefix', () => {
    const room = createRoom(db, {
      name: 'provider overrides',
      agentProfiles: [
        {
          id: 'gemini-qa-lead',
          providerId: 'codex',
          displayName: 'Holly',
          personaId: 'qa-lead',
          personaName: 'QA Lead',
          personaSummary: '',
        },
        {
          id: 'gemini-quality-assurance',
          providerId: 'codex',
          displayName: 'Biggs',
          personaId: 'quality-assurance-engineer',
          personaName: 'Quality Assurance Engineer',
          personaSummary: '',
        },
      ],
    });

    expect(room.agentProfiles.map((profile) => profile.providerId)).toEqual([
      'codex',
      'codex',
    ]);
    expect(getRoom(db, room.id)?.agentProfiles.map((profile) => profile.providerId)).toEqual([
      'codex',
      'codex',
    ]);
  });

  it('deduplicates exact legacy agent ids without collapsing provider instances', () => {
    const room = createRoom(db, { name: 'legacy duplicates', agents: ['claude'] });
    db.prepare(`UPDATE rooms SET agents_json = ?, yolo_agents_json = ? WHERE id = ?`).run(
      JSON.stringify(['claude', 'codex', 'claude', 'codex', 'claude-security']),
      JSON.stringify(['claude', 'claude', 'codex', 'claude-security', 'codex']),
      room.id,
    );

    const fetched = getRoom(db, room.id)!;
    expect(fetched.agents).toEqual(['claude', 'codex', 'claude-security']);
    expect(fetched.yoloAgents).toEqual(['claude', 'codex', 'claude-security']);
    expect(fetched.agentProfiles.map((profile) => profile.id)).toEqual([
      'claude',
      'codex',
      'claude-security',
    ]);
  });

  it('setRoomAgents removes sessions for agents that are no longer in the room', () => {
    const room = createRoom(db, { name: 'general', agents: ['claude', 'codex'] });
    upsertCliSessionId(db, room.id, 'claude', 'session-claude');
    upsertCliSessionId(db, room.id, 'codex', 'session-codex');

    setRoomAgents(db, room.id, ['claude']); // removed codex

    expect(getRoom(db, room.id)!.agents).toEqual(['claude']);
    expect(getCliSessionId(db, room.id, 'claude')).toBe('session-claude');
    expect(getCliSessionId(db, room.id, 'codex')).toBeNull();
  });

  it('setRoomAgents preserves sessions for agents that remain in the room', () => {
    const room = createRoom(db, { name: 'general', agents: ['claude', 'codex'] });
    upsertCliSessionId(db, room.id, 'claude', 'session-claude');

    setRoomAgents(db, room.id, ['claude', 'gemini']); // claude stays, gemini added

    expect(getCliSessionId(db, room.id, 'claude')).toBe('session-claude');
    expect(getCliSessionId(db, room.id, 'gemini')).toBeNull();
  });

  it('setRoomAgents removes sessions when an existing agent changes provider', () => {
    const room = createRoom(db, {
      name: 'provider switch',
      agentProfiles: [
        {
          id: 'gemini-qa-lead',
          providerId: 'gemini',
          displayName: 'Holly',
          personaId: 'qa-lead',
          personaName: 'QA Lead',
          personaSummary: '',
        },
      ],
    });
    upsertCliSessionId(db, room.id, 'gemini-qa-lead', 'old-gemini-session', 'gemini');

    setRoomAgents(
      db,
      room.id,
      ['gemini-qa-lead'],
      ['gemini-qa-lead'],
      [
        {
          id: 'gemini-qa-lead',
          providerId: 'codex',
          displayName: 'Holly',
          personaId: 'qa-lead',
          personaName: 'QA Lead',
          personaSummary: '',
        },
      ],
    );

    expect(getRoom(db, room.id)?.agentProfiles[0]?.providerId).toBe('codex');
    expect(getCliSessionId(db, room.id, 'gemini-qa-lead')).toBeNull();
  });

  it('deleteRoom removes the room and cascades messages', () => {
    const room = createRoom(db, { name: 'x', agents: ['claude'] });
    addMessage(db, { roomId: room.id, authorId: 'human', authorKind: 'human', text: 'hi' });
    const task = createTask(db, {
      roomId: room.id,
      title: 'test mission',
      capabilityProfile: 'edit',
    });
    createAgentRun(db, {
      roomId: room.id,
      taskId: task.id,
      triggerMessageId: 'msg-1',
      agentId: 'claude',
      permissionMode: 'edit',
      promptChars: 100,
      estimatedPromptTokens: 25,
      liveMessages: 1,
      contextArtifacts: 0,
    });
    addPermissionRequest(db, {
      roomId: room.id,
      agentId: 'claude',
      mode: 'edit',
      target: 'foo.txt',
      reason: 'test',
    });
    upsertCliSessionId(db, room.id, 'claude', 'session-abc');

    expect(deleteRoom(db, room.id)).toBe(true);

    expect(getRoom(db, room.id)).toBeNull();
    expect(listMessages(db, room.id)).toEqual([]);
    expect(listPermissionRequests(db, room.id)).toEqual([]);
    expect(listTasks(db, room.id)).toEqual([]);
    expect(listAgentRuns(db, room.id)).toEqual([]);
    expect(getCliSessionId(db, room.id, 'claude')).toBeNull();
  });

  it('keeps one active task per room and stores capability profiles', () => {
    const room = createRoom(db, { name: 'tasks', agents: ['claude'] });
    const first = createTask(db, {
      roomId: room.id,
      title: 'first',
      capabilityProfile: 'edit',
    });
    const second = createTask(db, {
      roomId: room.id,
      title: 'second',
      capabilityProfile: 'full-auto',
    });

    let tasks = listTasks(db, room.id);
    expect(tasks.find((task) => task.id === first.id)!.status).toBe('paused');
    expect(tasks.find((task) => task.id === second.id)!).toMatchObject({
      status: 'active',
      capabilityProfile: 'full-auto',
    });

    updateTask(db, first.id, { status: 'active', capabilityProfile: 'plan' });
    tasks = listTasks(db, room.id);
    expect(tasks.find((task) => task.id === first.id)!).toMatchObject({
      status: 'active',
      capabilityProfile: 'plan',
    });
    expect(tasks.find((task) => task.id === second.id)!.status).toBe('paused');
  });

  it('deleteRoom returns false for unknown id', () => {
    expect(deleteRoom(db, 'nonexistent')).toBe(false);
  });

  it('deleteRoom does not affect other rooms', () => {
    const a = createRoom(db, { name: 'a', agents: [] });
    const b = createRoom(db, { name: 'b', agents: [] });
    addMessage(db, { roomId: a.id, authorId: 'm', authorKind: 'human', text: 'in a' });
    addMessage(db, { roomId: b.id, authorId: 'm', authorKind: 'human', text: 'in b' });

    expect(deleteRoom(db, a.id)).toBe(true);
    expect(getRoom(db, b.id)).not.toBeNull();
    expect(listMessages(db, b.id)).toHaveLength(1);
  });
});
