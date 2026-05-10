// server/src/notifications/notification-fanout.ts
//
// Subscribes to broker events and persists `notifications` rows for things a
// human might want to react to.
//
// What we surface:
//   - approval-needed  : task.proposalStatus enters 'proposed'
//   - verifier-needed  : task.proposalStatus enters 'verifying' AND no
//                         verifier agent is assigned (humans must verify)
//   - task-done        : task.proposalStatus enters 'done'
//   - task-rejected    : task.proposalStatus enters 'rejected'
//   - run-failed       : agent run finishes with status='failed'
//   - permission-requested : agent run enters status='permission-requested'
//
// Dedupe keys keep us idempotent: a single task transition emits at most
// one notification per (kind × taskId) pair, even if `taskUpdated` fires
// multiple times during a transient state.

import type { Database } from 'better-sqlite3';
import type { Broker } from '../broker.js';
import type { AgentRunSummary } from './../repos/agent-runs.js';
import type { Task } from '../repos/tasks.js';
import {
  createNotification,
  type Notification,
  type NotificationKind,
  type NotificationSeverity,
} from '../repos/notifications.js';

interface FanoutDeps {
  db: Database;
  broker: Broker;
  /** Hook so an external observer (ws-server) can broadcast new rows. */
  onCreated?: (notification: Notification) => void;
}

interface MakeNotificationInput {
  kind: NotificationKind;
  severity: NotificationSeverity;
  summary: string;
  detail?: string;
  roomId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  permissionRequestId?: string | null;
  agentId?: string;
  dedupeKey: string;
  payload?: Record<string, unknown>;
}

export class NotificationFanout {
  private readonly listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  /** Track per-task last-seen proposal status so we only fire on transitions
   *  rather than every taskUpdated event. */
  private readonly lastProposalStatusByTask = new Map<string, string>();
  private readonly lastRunStatusByRun = new Map<string, string>();

  constructor(private readonly deps: FanoutDeps) {}

  start(): void {
    const onTaskUpdated = (task: Task) => this.handleTaskUpdated(task);
    const onAgentRunUpdated = (run: AgentRunSummary) => this.handleAgentRunUpdated(run);
    this.deps.broker.on('taskUpdated', onTaskUpdated);
    this.deps.broker.on('agentRunUpdated', onAgentRunUpdated);
    this.listeners.push(
      { event: 'taskUpdated', handler: onTaskUpdated },
      { event: 'agentRunUpdated', handler: onAgentRunUpdated },
    );
  }

  stop(): void {
    for (const { event, handler } of this.listeners) {
      this.deps.broker.off(event, handler);
    }
    this.listeners.length = 0;
    this.lastProposalStatusByTask.clear();
    this.lastRunStatusByRun.clear();
  }

  private make(input: MakeNotificationInput): Notification | null {
    const created = createNotification(this.deps.db, {
      kind: input.kind,
      severity: input.severity,
      summary: input.summary,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.roomId !== undefined ? { roomId: input.roomId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.permissionRequestId !== undefined
        ? { permissionRequestId: input.permissionRequestId }
        : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      dedupeKey: input.dedupeKey,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    });
    if (created && this.deps.onCreated) this.deps.onCreated(created);
    return created;
  }

  private handleTaskUpdated(task: Task): void {
    const previous = this.lastProposalStatusByTask.get(task.id);
    const next = task.proposalStatus;
    this.lastProposalStatusByTask.set(task.id, next);
    if (previous === next) return;
    if (next === 'proposed') {
      this.make({
        kind: 'approval-needed',
        severity: 'warn',
        summary: `Approval needed: ${task.title}`,
        detail: 'A proposal is awaiting human approval.',
        roomId: task.roomId,
        taskId: task.id,
        agentId: task.proposedByAgentId ?? '',
        dedupeKey: `approval-needed:${task.id}`,
      });
      return;
    }
    if (next === 'verifying' && !task.verifierAgentId) {
      this.make({
        kind: 'verifier-needed',
        severity: 'info',
        summary: `Verification needed: ${task.title}`,
        detail: 'No verifier agent is assigned; humans must verify.',
        roomId: task.roomId,
        taskId: task.id,
        dedupeKey: `verifier-needed:${task.id}`,
      });
      return;
    }
    if (next === 'done') {
      this.make({
        kind: 'task-done',
        severity: 'info',
        summary: `Task done: ${task.title}`,
        detail: 'Every acceptance criterion has both doer and verifier passes.',
        roomId: task.roomId,
        taskId: task.id,
        dedupeKey: `task-done:${task.id}`,
      });
      return;
    }
    if (next === 'rejected') {
      this.make({
        kind: 'task-rejected',
        severity: 'warn',
        summary: `Proposal rejected: ${task.title}`,
        roomId: task.roomId,
        taskId: task.id,
        dedupeKey: `task-rejected:${task.id}`,
      });
    }
  }

  private handleAgentRunUpdated(run: AgentRunSummary): void {
    const previous = this.lastRunStatusByRun.get(run.id);
    const next = run.status;
    this.lastRunStatusByRun.set(run.id, next);
    if (previous === next) return;
    if (next === 'failed') {
      const detail = run.error
        ? run.error.length > 600
          ? `${run.error.slice(0, 599)}…`
          : run.error
        : '';
      this.make({
        kind: 'run-failed',
        severity: 'critical',
        summary: `${run.agentId} run failed`,
        detail,
        roomId: run.roomId,
        taskId: run.taskId,
        runId: run.id,
        agentId: run.agentId,
        dedupeKey: `run-failed:${run.id}`,
      });
      return;
    }
    if (next === 'permission-requested') {
      this.make({
        kind: 'permission-requested',
        severity: 'warn',
        summary: `${run.agentId} requested permission`,
        detail: 'An agent is paused waiting for a human decision.',
        roomId: run.roomId,
        taskId: run.taskId,
        runId: run.id,
        agentId: run.agentId,
        dedupeKey: `permission-requested:${run.id}`,
      });
    }
  }
}
