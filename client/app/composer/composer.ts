// client/app/composer/composer.ts
// Chat composer: text input, attachment button, send/stop, plus the @mention
// autocomplete menu. Owns the mention state machine internally — token
// detection, keyboard nav, suggestion application, and timeout-based menu
// close — so the parent only has to provide a `findSuggestions(query)`
// callback that knows how to enumerate matching agents for the current room.
//
// The text value is a two-way `model<string>` — the parent owns the source
// of truth (typically a draft signal scoped to the current room), and every
// keystroke / mention-applied edit pushes back so persistence + cross-mount
// recall happens at the parent's layer.

import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { AgentDisplayService } from '../agent-display.service';
import type { ComposerMentionToken, MentionSuggestion } from '../chat-types';

const COMPOSER_MAX_HEIGHT_PX = 200;

@Component({
  selector: 'fs-composer',
  standalone: true,
  templateUrl: './composer.html',
  styleUrl: './composer.css',
})
export class Composer implements OnDestroy {
  protected readonly display = inject(AgentDisplayService);

  readonly text = model<string>('');
  readonly placeholder = input<string>('message the room');
  readonly isWorking = input<boolean>(false);
  readonly findSuggestions = input<(query: string) => MentionSuggestion[]>(() => []);

  readonly messageSent = output<void>();
  readonly stopRequested = output<void>();
  readonly attachRequested = output<HTMLTextAreaElement>();

  private readonly textareaRef = viewChild<ElementRef<HTMLTextAreaElement>>('messageInput');

  constructor() {
    // Re-fit the textarea to its content whenever text changes — covers
    // typing, mention insertion, and external mutations like room-switch
    // draft swaps. queueMicrotask waits for the [value] binding to flush
    // before we measure scrollHeight.
    effect(() => {
      this.text();
      const ref = this.textareaRef();
      if (!ref) return;
      queueMicrotask(() => this.adjustHeight(ref.nativeElement));
    });
  }

  readonly token = signal<ComposerMentionToken | null>(null);
  readonly selectedIndex = signal(0);
  readonly suggestions = computed<MentionSuggestion[]>(() => {
    const token = this.token();
    if (!token) return [];
    return this.findSuggestions()(token.query);
  });

  private closeTimer: number | null = null;

  ngOnDestroy(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  onInput(input: HTMLTextAreaElement): void {
    this.text.set(input.value);
    this.refreshAutocomplete(input);
    this.adjustHeight(input);
  }

  submit(input: HTMLTextAreaElement): void {
    if (!input.value.trim()) return;
    this.messageSent.emit();
    this.closeAutocomplete();
  }

  refreshAutocomplete(input: HTMLTextAreaElement): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    const token = this.detectMentionToken(input);
    this.token.set(token);
    const count = token ? this.findSuggestions()(token.query).length : 0;
    if (this.selectedIndex() >= count) this.selectedIndex.set(0);
  }

  onKeyup(event: KeyboardEvent, input: HTMLTextAreaElement): void {
    if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
    this.refreshAutocomplete(input);
  }

  onKeydown(event: KeyboardEvent, input: HTMLTextAreaElement): void {
    const list = this.suggestions();

    // Mention menu open: arrows / Tab / Enter drive the menu.
    if (list.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.selectedIndex.update((index) => (index + 1) % list.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.selectedIndex.update((index) => (index - 1 + list.length) % list.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        this.applySuggestion(input, list[this.selectedIndex()] ?? list[0]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeAutocomplete();
        return;
      }
    }

    // No menu: Enter sends, Shift+Enter inserts a newline (Discord pattern).
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.submit(input);
      return;
    }

    if (event.key === 'Escape') this.closeAutocomplete();
  }

  applySuggestion(input: HTMLTextAreaElement, suggestion: MentionSuggestion): void {
    const token = this.token();
    if (!token) return;
    const before = input.value.slice(0, token.start);
    const after = input.value.slice(token.end);
    const suffix = after && /^\s/.test(after) ? '' : ' ';
    const insert = `@${suggestion.handle}${suffix}`;
    const next = `${before}${insert}${after}`;
    input.value = next;
    this.text.set(next);
    const cursor = before.length + insert.length;
    this.closeAutocomplete();
    input.focus();
    input.setSelectionRange(cursor, cursor);
    this.adjustHeight(input);
  }

  private adjustHeight(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    const next = Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
    textarea.style.height = `${next}px`;
  }

  closeAutocomplete(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.token.set(null);
    this.selectedIndex.set(0);
  }

  closeAutocompleteSoon(): void {
    if (this.closeTimer !== null) window.clearTimeout(this.closeTimer);
    this.closeTimer = window.setTimeout(() => {
      this.closeAutocomplete();
    }, 120);
  }

  private detectMentionToken(input: HTMLTextAreaElement): ComposerMentionToken | null {
    const cursor = input.selectionStart ?? input.value.length;
    const selectionEnd = input.selectionEnd ?? cursor;
    if (selectionEnd !== cursor) return null;
    const beforeCursor = input.value.slice(0, cursor);
    const prefixMatch = beforeCursor.match(/(?:^|\s)@([A-Za-z0-9-]*)$/);
    if (!prefixMatch) return null;
    const prefix = prefixMatch[1] ?? '';
    const suffix = input.value.slice(cursor).match(/^[A-Za-z0-9-]*/)?.[0] ?? '';
    const start = cursor - prefix.length - 1;
    const end = cursor + suffix.length;
    return { query: `${prefix}${suffix}`.toLowerCase(), start, end };
  }
}
