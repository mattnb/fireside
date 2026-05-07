import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { addMessage } from '../../src/repos/messages.js';
import {
  attachAgentJobRun,
  cancelAgentJob,
  completeAgentJob,
  createAgentJob,
  createAgentJobIfAvailable,
  leaseAgentJob,
  listActiveAgentJobsForRoom,
  recoverInterruptedAgentJobs,
  renewAgentJobLease,
} from '../../src/repos/agent-jobs.js';
import { createAgentRun } from '../../src/repos/agent-runs.js';

describe('agent jobs repo', () => {
  it('leases, attaches, renews, and completes a durable job', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'jobs', agents: ['codex'] });
    const trigger = addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: '@codex work',
    });
    const job = createAgentJob(db, {
      roomId: room.id,
      agentId: 'codex',
      triggerMessageId: trigger.id,
      workPacketJson: '{"task":"demo"}',
      permissionJson: '{"mode":"edit"}',
    });

    expect(job).toMatchObject({ status: 'queued', runId: null });
    const leased = leaseAgentJob(db, job.id, {
      leaseOwner: 'test-worker',
      leaseMs: 10_000,
      now: 1_000,
    });
    expect(leased).toMatchObject({
      status: 'leased',
      leaseOwner: 'test-worker',
      leaseExpiresAt: 11_000,
    });

    const run = createAgentRun(db, {
      agentJobId: job.id,
      roomId: room.id,
      triggerMessageId: trigger.id,
      agentId: 'codex',
      permissionMode: 'edit',
      promptChars: 100,
      estimatedPromptTokens: 25,
      liveMessages: 1,
      contextArtifacts: 0,
    });
    expect(
      attachAgentJobRun(db, job.id, run.id, {
        leaseOwner: 'test-worker',
        leaseMs: 10_000,
        now: 2_000,
      }),
    ).toMatchObject({ status: 'running', runId: run.id, leaseExpiresAt: 12_000 });
    expect(
      renewAgentJobLease(db, job.id, {
        leaseOwner: 'test-worker',
        leaseMs: 20_000,
        now: 3_000,
      }),
    ).toMatchObject({ leaseExpiresAt: 23_000 });

    expect(listActiveAgentJobsForRoom(db, room.id).map((item) => item.id)).toEqual([job.id]);
    expect(completeAgentJob(db, job.id, 4_000)).toMatchObject({
      status: 'completed',
      completedAt: 4_000,
    });
    expect(listActiveAgentJobsForRoom(db, room.id)).toEqual([]);
    db.close();
  });

  it('returns the existing active job for the same room, agent, and trigger', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'jobs', agents: ['codex'] });
    const trigger = addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: '@codex work',
    });

    const first = createAgentJobIfAvailable(db, {
      roomId: room.id,
      agentId: 'codex',
      triggerMessageId: trigger.id,
      workPacketJson: '{"task":"first"}',
    });
    const second = createAgentJobIfAvailable(db, {
      roomId: room.id,
      agentId: 'codex',
      triggerMessageId: trigger.id,
      workPacketJson: '{"task":"second"}',
    });

    expect(first.created).toBe(true);
    expect(second).toMatchObject({
      created: false,
      job: { id: first.job.id, workPacketJson: '{"task":"first"}' },
    });
    expect(listActiveAgentJobsForRoom(db, room.id).map((item) => item.id)).toEqual([
      first.job.id,
    ]);

    completeAgentJob(db, first.job.id, 4_000);
    const afterTerminal = createAgentJobIfAvailable(db, {
      roomId: room.id,
      agentId: 'codex',
      triggerMessageId: trigger.id,
      workPacketJson: '{"task":"after"}',
    });

    expect(afterTerminal.created).toBe(true);
    expect(afterTerminal.job.id).not.toBe(first.job.id);
    db.close();
  });

  it('recovers interrupted leased and running jobs as canceled', () => {
    const db = openDatabase(':memory:');
    const room = createRoom(db, { name: 'jobs', agents: ['claude', 'codex'] });
    const trigger = addMessage(db, {
      roomId: room.id,
      authorId: 'human',
      authorKind: 'human',
      text: 'work',
    });
    const leased = createAgentJob(db, {
      roomId: room.id,
      agentId: 'claude',
      triggerMessageId: trigger.id,
    });
    const running = createAgentJob(db, {
      roomId: room.id,
      agentId: 'codex',
      triggerMessageId: trigger.id,
    });
    leaseAgentJob(db, leased.id, { leaseOwner: 'old', leaseMs: 10_000 });
    leaseAgentJob(db, running.id, { leaseOwner: 'old', leaseMs: 10_000 });
    const run = createAgentRun(db, {
      agentJobId: running.id,
      roomId: room.id,
      triggerMessageId: trigger.id,
      agentId: 'codex',
      permissionMode: 'plan',
      promptChars: 100,
      estimatedPromptTokens: 25,
      liveMessages: 1,
      contextArtifacts: 0,
    });
    attachAgentJobRun(db, running.id, run.id, { leaseOwner: 'old', leaseMs: 10_000 });

    const recovered = recoverInterruptedAgentJobs(db, 20_000);

    expect(recovered).toHaveLength(2);
    expect(recovered.map((job) => job.status)).toEqual(['canceled', 'canceled']);
    expect(recovered.map((job) => job.error)).toEqual([
      'Fireside restarted before this durable agent job completed.',
      'Fireside restarted before this durable agent job completed.',
    ]);
    expect(cancelAgentJob(db, leased.id, 'manual', 21_000)).toMatchObject({
      status: 'canceled',
      error: 'manual',
    });
    db.close();
  });
});
