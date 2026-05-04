// client/app/message-list/message-list.ts
// Renders the chat timeline (permission requests, mission activity rows,
// message bubbles) and owns the inline edit/retract flow for the user's
// own queued messages. While a human-authored message is `deliveryStatus:
// 'queued'`, its author can rewrite or pull it back before it ships to
// agents — that state and its associated API calls live here, where the
// inline edit form is rendered.

import { DatePipe } from '@angular/common';
import {
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { FiresideApi } from '../api.service';
import { MissionStore } from '../mission-store';
import type { ChatTimelineItem } from '../chat-types';
import type { AgentRun, Message, PermissionRequest } from '../api.types';

@Component({
  selector: 'fs-message-list',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './message-list.html',
  styleUrl: './message-list.css',
})
export class MessageList {
  protected readonly display = inject(AgentDisplayService);
  private readonly api = inject(FiresideApi);
  private readonly store = inject(MissionStore);

  readonly items = input<ChatTimelineItem[]>([]);
  readonly authorName = input<string>('human');

  readonly permissionRequestLabel = input<(request: PermissionRequest) => string>(
    () => '',
  );
  readonly capabilityText = input<(caps: string[] | undefined) => string>(() => 'none');
  readonly targetStatusText = input<(item: PermissionRequest | AgentRun) => string>(
    () => 'unknown',
  );

  readonly permissionDecided = output<{
    request: PermissionRequest;
    decision: 'approved' | 'denied';
  }>();

  protected readonly editingId = signal<string | null>(null);
  protected readonly editError = signal('');

  private readonly listRef = viewChild<ElementRef<HTMLOListElement>>('messagesList');

  constructor() {
    // Auto-cancel the inline edit form if the message being edited disappears
    // from the store — covers retraction by another client, room switch, or
    // any other path that drops the message. The router used to coordinate
    // this; with the state local, an effect is more direct.
    effect(() => {
      const id = this.editingId();
      if (!id) return;
      const stillExists = this.store.messages().some((message) => message.id === id);
      if (!stillExists) {
        this.editingId.set(null);
        this.editError.set('');
      }
    });
  }

  /**
   * True when the user is scrolled within 120px of the bottom of the
   * conversation (i.e. should auto-stick to incoming messages).
   */
  isNearBottom(): boolean {
    const list = this.listRef()?.nativeElement;
    if (!list) return true;
    return list.scrollHeight - list.clientHeight - list.scrollTop < 120;
  }

  /** Forces the list to its bottom on the next animation frame. */
  scrollToBottom(): void {
    const list = this.listRef()?.nativeElement;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }

  protected canManageQueuedMessage(message: Message): boolean {
    return (
      message.authorKind === 'human' &&
      message.deliveryStatus === 'queued' &&
      message.authorId === this.authorName()
    );
  }

  protected isEditingQueuedMessage(message: Message): boolean {
    return this.editingId() === message.id;
  }

  protected beginEdit(message: Message): void {
    if (!this.canManageQueuedMessage(message)) return;
    this.editingId.set(message.id);
    this.editError.set('');
  }

  protected cancelEdit(): void {
    this.editingId.set(null);
    this.editError.set('');
  }

  protected saveEdit(message: Message, input: HTMLInputElement): void {
    if (!this.canManageQueuedMessage(message)) return;
    const text = input.value.trim();
    if (!text) {
      this.editError.set('message text required');
      return;
    }
    this.api.messages
      .update(message.roomId, message.id, { authorId: this.authorName(), text })
      .subscribe({
        next: (updated) => {
          this.store.messages.update((messages) => upsertMessage(messages, updated));
          this.cancelEdit();
        },
        error: (err: unknown) => {
          this.editError.set(apiErrorText(err, 'failed to edit queued message'));
        },
      });
  }

  protected retractQueuedMessage(message: Message): void {
    if (!this.canManageQueuedMessage(message)) return;
    this.api.messages.retract(message.roomId, message.id, this.authorName()).subscribe({
      next: (update) => {
        this.store.messages.update((messages) =>
          messages.filter((candidate) => candidate.id !== update.messageId),
        );
        // The effect above will also cancel the edit when the message
        // disappears, but cancel here too to clear any error eagerly.
        if (this.editingId() === update.messageId) this.cancelEdit();
      },
      error: (err: unknown) => {
        this.editError.set(apiErrorText(err, 'failed to retract queued message'));
      },
    });
  }
}

function upsertMessage(messages: Message[], message: Message): Message[] {
  return [message, ...messages.filter((existing) => existing.id !== message.id)];
}

function apiErrorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const wrapped = (err as { error?: unknown }).error;
    if (typeof wrapped === 'string') return wrapped;
    if (typeof wrapped === 'object' && wrapped !== null && 'error' in wrapped) {
      const message = (wrapped as { error?: unknown }).error;
      if (typeof message === 'string') return message;
    }
  }
  return fallback;
}
