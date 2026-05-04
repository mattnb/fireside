// client/app/chat-pane/chat-pane.ts
// Chat surface shell: composes message-list (timeline rendering) and
// composer (input + mention autocomplete). Owns the live binding from the
// composer's text model to the per-room DraftService entry, the send action
// (post via WS, then clear the draft), and the mention-suggestions closure.
// Exposes `isNearBottom()` and `scrollToBottom()` for the parent so it can
// keep the conversation pinned to the latest message when streamed events
// arrive.

import { ChangeDetectionStrategy, Component, computed, inject, input, output, viewChild } from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import { DraftService } from '../draft.service';
import { MissionStore } from '../mission-store';
import { FiresideWs } from '../ws.service';
import { Composer } from '../composer/composer';
import { MessageList } from '../message-list/message-list';
import type { ChatTimelineItem, MentionSuggestion } from '../chat-types';
import type { AgentRun, PermissionRequest } from '../api.types';

@Component({
  selector: 'fs-chat-pane',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MessageList, Composer],
  templateUrl: './chat-pane.html',
  styleUrl: './chat-pane.css',
})
export class ChatPane {
  private readonly drafts = inject(DraftService);
  private readonly store = inject(MissionStore);
  private readonly ws = inject(FiresideWs);
  private readonly display = inject(AgentDisplayService);

  readonly timeline = input<ChatTimelineItem[]>([]);
  readonly composerPlaceholder = input<string>('message the room');
  readonly isRoomWorking = input<boolean>(false);
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
  readonly stopRequested = output<void>();
  readonly attachRequested = output<HTMLTextAreaElement>();

  readonly composerText = computed(() => this.drafts.draftFor(this.store.selectedRoomId()));

  readonly findMentionSuggestions = (query: string): MentionSuggestion[] =>
    this.display.mentionSuggestionsForRoom(this.store.selectedRoom(), query);

  private readonly messageList = viewChild<MessageList>('messageList');

  isNearBottom(): boolean {
    return this.messageList()?.isNearBottom() ?? true;
  }

  scrollToBottom(): void {
    this.messageList()?.scrollToBottom();
  }

  onComposerTextChange(text: string): void {
    const roomId = this.store.selectedRoomId();
    if (!roomId) return;
    this.drafts.setDraft(roomId, text);
  }

  onMessageSent(): void {
    const roomId = this.store.selectedRoomId();
    if (!roomId) return;
    const text = this.composerText().trim();
    if (!text) return;
    this.ws.postMessage(roomId, this.authorName(), text);
    this.drafts.clearDraft(roomId);
  }
}
