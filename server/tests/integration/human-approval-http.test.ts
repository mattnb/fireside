// server/tests/integration/human-approval-http.test.ts
//
// Loopback HTTP routes humans use to drive the proposal gate:
//   POST /api/tasks/:id/approve
//   POST /api/tasks/:id/reject
//   POST /api/tasks/:id/request-changes
//   POST /api/clarifying-questions/:id/answer

import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { Broker } from '../../src/broker.js';
import { buildHttpServer } from '../../src/http-server.js';
import { createRoom } from '../../src/repos/rooms.js';
import { createTask, getTask } from '../../src/repos/tasks.js';
import {
  createClarifyingQuestion,
  getClarifyingQuestion,
} from '../../src/repos/clarifying-questions.js';
import type { Database } from 'better-sqlite3';

interface Harness {
  app: ReturnType<typeof buildHttpServer>;
  db: Database;
}

function makeHarness(): Harness {
  const db = openDatabase(':memory:');
  const broker = new Broker({
    db,
    getSpec: () => undefined,
    runAgent: async () => ({ text: '', sessionId: '', raw: { stdout: '', stderr: '' } }),
  });
  const app = buildHttpServer({
    db,
    broker,
    uiDir: 'C:/tmp/ui-not-real',
    mcpApiKey: null,
  });
  return { app, db };
}

function seedTask(db: Database, overrides: { proposalStatus?: 'proposed' | 'elaborating' | 'draft' | 'approved' } = {}): { taskId: string; roomId: string } {
  const room = createRoom(db, { name: 'r', agents: ['claude', 'codex'] });
  const task = createTask(db, {
    roomId: room.id,
    title: 't',
    proposalStatus: overrides.proposalStatus ?? 'proposed',
  });
  return { taskId: task.id, roomId: room.id };
}

describe('POST /api/tasks/:id/approve', () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) {
      await harness.app.close();
      harness.db.close();
      harness = null;
    }
  });

  it('flips proposal_status to approved with byAgentId=human', async () => {
    harness = makeHarness();
    const { taskId } = seedTask(harness.db);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/approve`,
      remoteAddress: '127.0.0.1',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ proposalStatus: 'approved' });
    expect(getTask(harness.db, taskId)?.proposalStatus).toBe('approved');
  });

  it('returns 404 for unknown task', async () => {
    harness = makeHarness();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/tasks/no-such/approve',
      remoteAddress: '127.0.0.1',
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 409 when the transition is illegal (e.g. draft → approved)', async () => {
    harness = makeHarness();
    const { taskId } = seedTask(harness.db, { proposalStatus: 'draft' });
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/approve`,
      remoteAddress: '127.0.0.1',
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: expect.stringMatching(/illegal/i) });
  });
});

describe('POST /api/tasks/:id/reject', () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) {
      await harness.app.close();
      harness.db.close();
      harness = null;
    }
  });

  it('rejects with a reason', async () => {
    harness = makeHarness();
    const { taskId } = seedTask(harness.db);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/reject`,
      remoteAddress: '127.0.0.1',
      payload: { reason: 'scope too broad' },
    });

    expect(response.statusCode).toBe(200);
    expect(getTask(harness.db, taskId)?.proposalStatus).toBe('rejected');
  });

  it('returns 400 without a reason', async () => {
    harness = makeHarness();
    const { taskId } = seedTask(harness.db);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/reject`,
      remoteAddress: '127.0.0.1',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/tasks/:id/request-changes', () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) {
      await harness.app.close();
      harness.db.close();
      harness = null;
    }
  });

  it('returns the task to elaborating', async () => {
    harness = makeHarness();
    const { taskId } = seedTask(harness.db);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/request-changes`,
      remoteAddress: '127.0.0.1',
      payload: { reason: 'add an AC for the cache layer' },
    });

    expect(response.statusCode).toBe(200);
    expect(getTask(harness.db, taskId)?.proposalStatus).toBe('elaborating');
  });
});

describe('POST /api/clarifying-questions/:id/answer', () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) {
      await harness.app.close();
      harness.db.close();
      harness = null;
    }
  });

  it('stamps the answer with answeredBy=human', async () => {
    harness = makeHarness();
    const { taskId } = seedTask(harness.db, { proposalStatus: 'elaborating' });
    const q = createClarifyingQuestion(harness.db, {
      taskId,
      askedByAgentId: 'claude',
      question: 'why?',
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/clarifying-questions/${q.id}/answer`,
      remoteAddress: '127.0.0.1',
      payload: { answer: 'because the data flows that way' },
    });

    expect(response.statusCode).toBe(200);
    const updated = getClarifyingQuestion(harness.db, q.id);
    expect(updated?.answer).toBe('because the data flows that way');
    expect(updated?.answeredBy).toBe('human');
  });

  it('returns 400 for an empty answer', async () => {
    harness = makeHarness();
    const { taskId } = seedTask(harness.db, { proposalStatus: 'elaborating' });
    const q = createClarifyingQuestion(harness.db, {
      taskId,
      askedByAgentId: 'claude',
      question: 'why?',
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/clarifying-questions/${q.id}/answer`,
      remoteAddress: '127.0.0.1',
      payload: { answer: '' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for unknown question', async () => {
    harness = makeHarness();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/clarifying-questions/no-such/answer',
      remoteAddress: '127.0.0.1',
      payload: { answer: 'whatever' },
    });
    expect(response.statusCode).toBe(404);
  });
});
