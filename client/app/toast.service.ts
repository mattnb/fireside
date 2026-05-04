// client/app/toast.service.ts
// App-wide toast notification system. Components inject the service and call
// push() to display a transient banner with optional action button (e.g.
// "Undo"). Auto-dismiss is per-toast; clicking an action runs the callback
// and dismisses immediately. Stack ordering: newest on top.

import { Injectable, signal } from '@angular/core';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  action?: ToastAction;
  durationMs: number;
}

const DEFAULT_DURATION_MS = 6000;

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly internal = signal<Toast[]>([]);
  readonly toasts = this.internal.asReadonly();

  private nextId = 1;
  private readonly timers = new Map<number, number>();

  push(input: { message: string; action?: ToastAction; durationMs?: number }): number {
    const id = this.nextId++;
    const toast: Toast = {
      id,
      message: input.message,
      durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
      ...(input.action ? { action: input.action } : {}),
    };
    this.internal.update((current) => [toast, ...current]);
    this.timers.set(
      id,
      window.setTimeout(() => this.dismiss(id), toast.durationMs),
    );
    return id;
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.timers.delete(id);
    }
    this.internal.update((current) => current.filter((toast) => toast.id !== id));
  }

  invokeAction(id: number): void {
    const toast = this.internal().find((candidate) => candidate.id === id);
    if (!toast?.action) return;
    toast.action.run();
    this.dismiss(id);
  }
}
