// client/app/draft.service.ts
// Persistent composer-draft store. Owns the in-memory map of roomId → text
// and the localStorage I/O boundary that survives page reloads. Components
// inject this service to read drafts (composer text binding, sidebar dot)
// or write them (composer text input, send/clear).
//
// Persistence is debounced so per-keystroke writes don't thrash localStorage.
// Hydration runs synchronously at construction so any composer mount picks
// up the existing draft on first render — no flash of empty input.

import { Injectable, Signal, computed, effect, signal } from '@angular/core';

const STORAGE_KEY = 'fireside.drafts.v1';
const PERSIST_DEBOUNCE_MS = 250;

@Injectable({ providedIn: 'root' })
export class DraftService {
  private readonly drafts = signal<Record<string, string>>(this.hydrate());
  readonly all = this.drafts.asReadonly();

  private persistTimer: number | null = null;

  constructor() {
    effect(() => {
      const snapshot = this.drafts();
      this.schedulePersist(snapshot);
    });
  }

  hasDraft(roomId: string | null | undefined): boolean {
    if (!roomId) return false;
    const text = this.drafts()[roomId];
    return !!text && text.trim().length > 0;
  }

  draftFor(roomId: string | null | undefined): string {
    if (!roomId) return '';
    return this.drafts()[roomId] ?? '';
  }

  draftSignalFor(roomId: Signal<string | null>): Signal<string> {
    return computed(() => this.draftFor(roomId()));
  }

  setDraft(roomId: string, text: string): void {
    this.drafts.update((current) => {
      if (!text) {
        if (!(roomId in current)) return current;
        const next = { ...current };
        delete next[roomId];
        return next;
      }
      if (current[roomId] === text) return current;
      return { ...current, [roomId]: text };
    });
  }

  clearDraft(roomId: string): void {
    this.drafts.update((current) => {
      if (!(roomId in current)) return current;
      const next = { ...current };
      delete next[roomId];
      return next;
    });
  }

  private hydrate(): Record<string, string> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 0) out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  private schedulePersist(snapshot: Record<string, string>): void {
    if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // localStorage full or disabled — best-effort persistence
      }
    }, PERSIST_DEBOUNCE_MS);
  }
}
