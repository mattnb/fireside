// client/app/mission-event-router.ts
// Routes inbound FiresideWs events into MissionStore mutations and the
// App-side callbacks that handle scroll, follow-up loads, and modal state.
//
// MissionStore is injected directly so all "shared domain state" mutations
// (rooms, messages, runs, runActions, tasks, permissionRequests, collaboration,
// taskControl, yoloStatus) happen through a single owner. App-private signals
// and helper methods come in via MissionEventContext, which is built once in
// App's constructor; the router never holds a reference to App.

import { Injectable, Signal, inject } from '@angular/core';

import {
  AgentRun,
  AgentRunAction,
  CollaborationItem,
  FiresideWsEvent,
  Message,
  PermissionRequest,
  Room,
  Task,
  TaskControl,
  YoloStatus,
} from './api.types';
import type { DraftRoomAgent } from './room-agent-types';
import { MissionStore } from './mission-store';
import { ACTIVE_TASK_STATUSES } from './task-constants';

export interface MissionEventContext {
  // App-private signals the router reads.
  readonly openRunDetailId: Signal<string | null>;
  readonly activeTask: Signal<Task | null>;
  readonly editingAgents: Signal<boolean>;

  // App-private signal the router writes to.
  setEditRoomAgentRows(rows: DraftRoomAgent[]): void;

  // App-private callbacks. The router owns dispatch; App owns side effects.
  isChatNearBottom(): boolean;
  scheduleChatScrollToBottom(): void;
  loadStateSnapshot(): void;
  loadAutonomyDiagnostics(roomId: string): void;
  loadArtifacts(roomId: string): void;
  loadTaskControl(roomId: string, taskId: string): void;
  loadCollaboration(roomId: string, taskId: string): void;
  openRunDetail(runId: string, refresh?: boolean): void;
  handleRoomDeleted(roomId: string): void;
  draftRowsFromRoom(room: Room): DraftRoomAgent[];
  isActivityRunUpdate(run: AgentRun): boolean;
  isActivityRunAction(action: AgentRunAction): boolean;
  isAutonomyDiagnosticAction(action: AgentRunAction): boolean;
}

@Injectable({ providedIn: 'root' })
export class MissionEventRouter {
  private readonly store = inject(MissionStore);

  route(event: FiresideWsEvent, ctx: MissionEventContext): void {
    const roomId = this.store.selectedRoomId();
    if (event.type === 'messageAppended' && event.message.roomId === roomId) {
      const shouldStickToBottom = ctx.isChatNearBottom();
      this.store.messages.update((messages) => [...messages, event.message]);
      if (shouldStickToBottom) ctx.scheduleChatScrollToBottom();
    }
    if (event.type === 'messageUpdated' && event.message.roomId === roomId) {
      this.store.messages.update((messages) => upsert(messages, event.message));
    }
    if (event.type === 'messageRetracted' && event.update.roomId === roomId) {
      this.store.messages.update((messages) =>
        messages.filter((message) => message.id !== event.update.messageId),
      );
      // message-list owns the inline edit form and self-cancels via an
      // effect when the edited message disappears from the store.
    }
    if (event.type === 'messageDeliveryUpdated' && event.update.roomId === roomId) {
      this.store.messages.update((messages) =>
        messages.map((message) =>
          message.id === event.update.messageId
            ? { ...message, deliveryStatus: event.update.deliveryStatus }
            : message,
        ),
      );
    }
    if (event.type === 'messageReadReceiptUpdated' && event.update.roomId === roomId) {
      this.store.messages.update((messages) =>
        messages.map((message) =>
          message.id === event.update.messageId
            ? { ...message, seenBy: event.update.seenBy }
            : message,
        ),
      );
    }
    if (event.type === 'permissionRequestCreated' && event.request.roomId === roomId) {
      this.store.permissionRequests.update((requests) => upsert(requests, event.request));
      ctx.scheduleChatScrollToBottom();
    }
    if (event.type === 'permissionRequestUpdated' && event.request.roomId === roomId) {
      this.store.permissionRequests.update((requests) => upsert(requests, event.request));
    }
    if (event.type === 'taskUpdated' && event.task.roomId === roomId) {
      ctx.loadStateSnapshot();
      ctx.loadAutonomyDiagnostics(roomId);
      this.store.tasks.update((tasks) => upsert(tasks, event.task));
      if (ACTIVE_TASK_STATUSES.includes(event.task.status)) {
        ctx.loadTaskControl(roomId, event.task.id);
        ctx.loadCollaboration(roomId, event.task.id);
      } else if (event.task.id === this.store.taskControl()?.task.id) {
        const activeTask = ctx.activeTask();
        if (activeTask) {
          ctx.loadTaskControl(roomId, activeTask.id);
          ctx.loadCollaboration(roomId, activeTask.id);
        } else {
          this.store.taskControl.set(null);
          this.store.collaboration.set([]);
        }
      }
    }
    if (event.type === 'agentRunUpdated' && event.run.roomId === roomId) {
      ctx.loadStateSnapshot();
      ctx.loadAutonomyDiagnostics(roomId);
      const shouldStickToBottom = ctx.isChatNearBottom();
      this.store.runs.update((runs) => upsert(runs, event.run));
      if (event.run.id === ctx.openRunDetailId()) ctx.openRunDetail(event.run.id, true);
      if (shouldStickToBottom && ctx.isActivityRunUpdate(event.run)) {
        ctx.scheduleChatScrollToBottom();
      }
    }
    if (event.type === 'agentRunActionCreated' && event.action.roomId === roomId) {
      ctx.loadStateSnapshot();
      if (ctx.isAutonomyDiagnosticAction(event.action)) ctx.loadAutonomyDiagnostics(roomId);
      const shouldStickToBottom = ctx.isChatNearBottom();
      this.store.runActions.update((actions) => upsert(actions, event.action));
      if (event.action.runId === ctx.openRunDetailId())
        ctx.openRunDetail(event.action.runId, true);
      if (shouldStickToBottom && ctx.isActivityRunAction(event.action)) {
        ctx.scheduleChatScrollToBottom();
      }
    }
    if (event.type === 'artifactsUpdated' && event.roomId === roomId) {
      ctx.loadArtifacts(roomId);
    }
    if (event.type === 'collaborationItemCreated' && event.item.roomId === roomId) {
      if (event.item.taskId === ctx.activeTask()?.id) {
        this.store.collaboration.update((items) => upsert(items, event.item));
      }
    }
    if (event.type === 'yoloStatusUpdated' && event.status.roomId === roomId) {
      this.store.yoloStatus.set(event.status);
    }
    if (event.type === 'roomUpdated') {
      ctx.loadStateSnapshot();
      this.store.rooms.update((rooms) => upsert(rooms, event.room));
      // mission-toolbar's roomAgents() effect picks up roster changes
      // automatically and re-syncs the action popover targets.
      if (event.room.id === roomId && ctx.editingAgents()) {
        ctx.setEditRoomAgentRows(ctx.draftRowsFromRoom(event.room));
      }
    }
    if (event.type === 'roomDeleted') {
      ctx.loadStateSnapshot();
      ctx.handleRoomDeleted(event.roomId);
    }
    if (event.type === 'projectUpdated') {
      this.store.projects.update((projects) => upsert(projects, event.project));
      // If the currently-selected project was just archived, drop the
      // selection so the user lands cleanly on the empty/welcome state.
      if (
        event.project.archivedAt !== null &&
        this.store.selectedProjectId() === event.project.id
      ) {
        this.store.selectedProjectId.set(null);
        this.store.selectedRoomId.set(null);
      }
    }
    if (event.type === 'projectDeleted') {
      this.store.projects.update((projects) =>
        projects.filter((project) => project.id !== event.projectId),
      );
      if (this.store.selectedProjectId() === event.projectId) {
        this.store.selectedProjectId.set(null);
        this.store.selectedRoomId.set(null);
      }
    }
  }
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return [item, ...items.filter((existing) => existing.id !== item.id)];
}

// Re-export the domain types the App needs to type its context. Keeps the
// router a one-stop import on the App side.
export type {
  Message,
  PermissionRequest,
  Task,
  AgentRun,
  AgentRunAction,
  CollaborationItem,
  Room,
  TaskControl,
  YoloStatus,
};
