// server/tests/unit/export.test.ts
//
// Coverage for the markdown export modules + HTTP routes.

import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { Broker } from '../../src/broker.js';
import { buildHttpServer, type HttpServer } from '../../src/http-server.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import { createTaskPhase } from '../../src/repos/task-phases.js';
import { createTaskPlan } from '../../src/repos/task-plans.js';
import { createTaskChecklistItem } from '../../src/repos/task-checklist.js';
import {
  createAcceptanceCriterion,
  recordDoerCheck,
  recordVerifierCheck,
} from '../../src/repos/acceptance-criteria.js';
import {
  createClarifyingQuestion,
  answerQuestion,
} from '../../src/repos/clarifying-questions.js';
import { addMessage } from '../../src/repos/messages.js';
import { exportMissionMarkdown } from '../../src/export/mission-export.js';
import { exportTranscriptMarkdown } from '../../src/export/transcript-export.js';

describe('exportMissionMarkdown', () => {
  it('returns null for unknown task id', () => {
    const db = openDatabase(':memory:');
    expect(exportMissionMarkdown(db, 'does-not-exist')).toBeNull();
  });

  it('produces a markdown document with the canonical sections', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'launch-lane', agents: ['claude', 'codex'] });
    const task = createTask(db, {
      roomId: room.id,
      title: 'Wire MCP gates',
      goal: 'Make proposal/approve/verify gates real.',
      summary: 'Phase 2 work for gap #2.',
    });
    const phase = createTaskPhase(db, {
      taskId: task.id,
      title: 'PR 1',
      gate: 'tsc clean',
      status: 'active',
    });
    createTaskPlan(db, {
      taskId: task.id,
      title: 'Backend plan',
      body: 'Tables, applicators, MCP tools.',
      status: 'active',
    });
    createTaskChecklistItem(db, {
      taskId: task.id,
      phaseId: phase.id,
      title: 'Add notifications schema',
      ownerAgentId: 'claude',
    });
    const ac = createAcceptanceCriterion(db, {
      taskId: task.id,
      title: 'tests pass',
      doerAgentId: 'claude',
    });
    recordDoerCheck(db, ac.id, {
      status: 'pass',
      evidence: 'vitest 891/891',
      byAgentId: 'claude',
    });
    recordVerifierCheck(db, ac.id, {
      status: 'pass',
      evidence: 're-ran suite locally',
      byAgentId: 'codex',
    });
    const q = createClarifyingQuestion(db, {
      taskId: task.id,
      askedByAgentId: 'claude',
      question: 'one PR or two?',
    });
    answerQuestion(db, q.id, { answer: 'one PR — atomic', answeredBy: 'human' });

    const result = exportMissionMarkdown(db, task.id);
    expect(result).not.toBeNull();
    const md = result!.markdown;
    expect(md).toContain('# Wire MCP gates');
    expect(md).toContain('## Goal');
    expect(md).toContain('Make proposal/approve/verify gates real.');
    expect(md).toContain('## Summary');
    expect(md).toContain('Phase 2 work for gap #2.');
    expect(md).toContain('## Acceptance criteria');
    expect(md).toContain('tests pass');
    expect(md).toContain('vitest 891/891');
    expect(md).toContain('re-ran suite locally');
    expect(md).toContain('## Clarifying questions');
    expect(md).toContain('one PR or two?');
    expect(md).toContain('one PR — atomic');
    expect(md).toContain('## Plans');
    expect(md).toContain('Backend plan');
    expect(md).toContain('## Phases & checklist');
    expect(md).toContain('PR 1');
    expect(md).toContain('Add notifications schema');
    expect(md).toContain('_(owner: claude)_');
    expect(md.endsWith('\n')).toBe(true);
    expect(result!.filename).toMatch(/\.md$/);
    expect(result!.filename).toContain('wire-mcp-gates');
  });

  it('renders a placeholder for skipped sections when data is missing', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    const task = createTask(db, { roomId: room.id, title: 'minimal' });
    const result = exportMissionMarkdown(db, task.id);
    expect(result).not.toBeNull();
    const md = result!.markdown;
    expect(md).toContain('# minimal');
    // No goal/AC/clarifying section headers.
    expect(md).not.toContain('## Goal');
    expect(md).not.toContain('## Acceptance criteria');
    expect(md).not.toContain('## Clarifying questions');
  });
});

describe('exportTranscriptMarkdown', () => {
  it('returns null for unknown room', () => {
    const db = openDatabase(':memory:');
    expect(exportTranscriptMarkdown(db, 'nope')).toBeNull();
  });

  it('renders agent + human + system messages with timestamps', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'general', agents: ['claude'] });
    addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: 'kick off the work',
    });
    addMessage(db, {
      roomId: room.id,
      authorId: 'claude',
      authorKind: 'agent',
      text: 'on it.',
    });
    addMessage(db, {
      roomId: room.id,
      authorId: 'system',
      authorKind: 'system',
      text: 'run completed',
    });

    const result = exportTranscriptMarkdown(db, room.id);
    expect(result).not.toBeNull();
    const md = result!.markdown;
    expect(md).toContain('# general — transcript');
    expect(md).toContain('**Messages:** 3');
    expect(md).toContain('human _(human)_');
    expect(md).toContain('claude _(agent)_');
    expect(md).toContain('_[');
    expect(md).toContain('system:_ run completed');
    expect(md).toContain('kick off the work');
    expect(md).toContain('on it.');
  });
});

describe('export HTTP routes', () => {
  let app: HttpServer | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function buildApp() {
    const db = openDatabase(':memory:');
    const broker = new Broker({
      db,
      getSpec: () => undefined,
      runAgent: async () => ({ text: '', sessionId: null, raw: { stdout: '', stderr: '' } }),
    });
    app = buildHttpServer({ db, broker, uiDir: process.cwd() });
    return { db, app };
  }

  it('returns the mission export with attachment Content-Disposition', async () => {
    const { db, app } = buildApp();
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    const task = createTask(db, { roomId: room.id, title: 'T1' });
    const res = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/export.md` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(String(res.headers['content-disposition'] ?? '')).toContain('attachment');
    expect(String(res.headers['content-disposition'] ?? '')).toContain('.md');
    expect(res.body).toContain('# T1');
  });

  it('returns 404 for unknown task export', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/tasks/missing/export.md' });
    expect(res.statusCode).toBe(404);
  });

  it('returns the transcript export with attachment Content-Disposition', async () => {
    const { db, app } = buildApp();
    const room = createRoom(db, { name: 'general', agents: ['claude'] });
    addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: 'hello',
    });
    const res = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/transcript.md` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(String(res.headers['content-disposition'] ?? '')).toContain('attachment');
    expect(res.body).toContain('# general — transcript');
    expect(res.body).toContain('hello');
  });

  it('respects the limit query param on transcript export', async () => {
    const { db, app } = buildApp();
    const room = createRoom(db, { name: 'r', agents: ['claude'] });
    for (let i = 0; i < 5; i += 1) {
      addMessage(db, {
        roomId: room.id,
        authorId: 'human',
        authorKind: 'human',
        text: `m${i}`,
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/transcript.md?limit=2`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('**Messages:** 2');
  });
});
