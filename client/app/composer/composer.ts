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
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  model,
  OnDestroy,
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
  changeDetection: ChangeDetectionStrategy.OnPush,
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
    // Sync the textarea's DOM value to the text() signal when they diverge —
    // covers initial mount and external mutations like room-switch draft
    // swaps. During typing, input.value is already current and this no-ops,
    // so we never overwrite what the user just typed.
    //
    // Height-fit is scheduled into rAF (after layout) every time text
    // changes, AND a ResizeObserver re-fits whenever the textarea's
    // available width changes — chat data resolving, window resize,
    // sidebar collapse, anything that shifts the surrounding layout.
    // Without the width observer, a long stored draft renders against
    // the chat-pane's pre-load minimum width and ends up much taller
    // than the final layout requires.
    effect(() => {
      const value = this.text();
      const ref = this.textareaRef();
      if (!ref) return;
      const el = ref.nativeElement;
      if (el.value !== value) el.value = value;
      this.scheduleHeightFit(el);
      this.ensureWidthObserver(el);
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
  private heightFitFrame: number | null = null;
  private widthObserver: ResizeObserver | null = null;
  private lastObservedWidth = 0;

  ngOnDestroy(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.heightFitFrame !== null) {
      cancelAnimationFrame(this.heightFitFrame);
      this.heightFitFrame = null;
    }
    if (this.widthObserver) {
      this.widthObserver.disconnect();
      this.widthObserver = null;
    }
  }

  private scheduleHeightFit(el: HTMLTextAreaElement): void {
    if (this.heightFitFrame !== null) return;
    this.heightFitFrame = requestAnimationFrame(() => {
      this.heightFitFrame = null;
      this.adjustHeight(el);
    });
  }

  private ensureWidthObserver(el: HTMLTextAreaElement): void {
    if (this.widthObserver) return;
    this.widthObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = entry.contentRect.width;
      // Filter out height-only changes — adjustHeight itself mutates the
      // textarea's height and would otherwise feed straight back into us.
      if (width === this.lastObservedWidth) return;
      this.lastObservedWidth = width;
      this.scheduleHeightFit(el);
    });
    this.widthObserver.observe(el);
  }

  onInput(input: HTMLTextAreaElement): void {
    this.text.set(input.value);
    this.refreshAutocomplete(input);
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
    // Reuse the memoized `suggestions` computed instead of calling
    // findSuggestions a second time — token.set above already invalidated
    // its cache, so this read drives a single recompute.
    const count = this.suggestions().length;
    if (this.selectedIndex() >= count) this.selectedIndex.set(0);
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
