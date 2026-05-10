import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';

import { FiresideApi } from '../api.service';
import { FiresideWs } from '../ws.service';
import { formatRelativeAgo } from '../formatters';
import type { Notification, NotificationKind } from '../api.types';

const PREF_STORAGE_KEY = 'fireside.notifications.muted';

const KIND_LABEL: Record<NotificationKind, string> = {
  'permission-requested': 'permission',
  'approval-needed': 'approval',
  'verifier-needed': 'verify',
  'task-done': 'done',
  'task-rejected': 'rejected',
  'run-failed': 'run failed',
};

const ALL_KINDS: readonly NotificationKind[] = [
  'permission-requested',
  'approval-needed',
  'verifier-needed',
  'task-done',
  'task-rejected',
  'run-failed',
];

export interface BellNavigation {
  notification: Notification;
}

@Component({
  selector: 'fs-notification-bell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './notification-bell.html',
  styleUrl: './notification-bell.css',
})
export class NotificationBell implements OnInit, OnDestroy {
  private readonly api = inject(FiresideApi);
  private readonly ws = inject(FiresideWs);
  private wsSub: { unsubscribe(): void } | null = null;

  readonly notifications = signal<Notification[]>([]);
  readonly serverUnread = signal(0);
  readonly open = signal(false);
  readonly showSettings = signal(false);
  readonly mutedKinds = signal<Set<NotificationKind>>(new Set(this.loadMutedKinds()));

  protected readonly kindLabel = KIND_LABEL;
  protected readonly allKinds = ALL_KINDS;

  readonly navigated = output<BellNavigation>();

  /** Visible notifications respect the per-kind mute filter. */
  readonly visibleNotifications = computed<Notification[]>(() => {
    const muted = this.mutedKinds();
    return this.notifications().filter((n) => !muted.has(n.kind));
  });

  readonly visibleUnread = computed(
    () =>
      this.visibleNotifications().filter((n) => n.readAt === null && n.dismissedAt === null).length,
  );

  ngOnInit(): void {
    this.refresh();
    this.wsSub = this.ws.stream$.subscribe((event) => {
      if (event.type === 'notificationCreated') {
        this.notifications.update((list) => [event.notification, ...list].slice(0, 200));
        this.serverUnread.update((n) => n + 1);
      }
    });
  }

  ngOnDestroy(): void {
    this.wsSub?.unsubscribe();
  }

  refresh(): void {
    this.api.notifications.list({ limit: 100 }).subscribe({
      next: (response) => {
        this.notifications.set(response.notifications);
        this.serverUnread.set(response.unread);
      },
      error: () => {
        // ignore — will retry on next open or WS push
      },
    });
  }

  toggle(): void {
    if (this.open()) {
      this.close();
    } else {
      this.open.set(true);
      this.showSettings.set(false);
      this.refresh();
    }
  }

  close(): void {
    this.open.set(false);
    this.showSettings.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open()) this.close();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.open()) return;
    const target = event.target as HTMLElement | null;
    // Close if click is outside the bell.
    if (target && !target.closest('fs-notification-bell')) this.close();
  }

  toggleSettings(event: Event): void {
    event.stopPropagation();
    this.showSettings.update((v) => !v);
  }

  toggleMuteKind(kind: NotificationKind, event: Event): void {
    event.stopPropagation();
    this.mutedKinds.update((set) => {
      const next = new Set(set);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      this.persistMutedKinds(next);
      return next;
    });
  }

  isMuted(kind: NotificationKind): boolean {
    return this.mutedKinds().has(kind);
  }

  markRead(notification: Notification, event: Event): void {
    event.stopPropagation();
    if (notification.readAt !== null) return;
    this.api.notifications.markRead(notification.id).subscribe({
      next: (updated) => this.replaceNotification(updated),
    });
  }

  dismiss(notification: Notification, event: Event): void {
    event.stopPropagation();
    this.api.notifications.dismiss(notification.id).subscribe({
      next: (updated) => {
        if (updated.dismissedAt !== null) {
          this.notifications.update((list) => list.filter((n) => n.id !== updated.id));
        } else {
          this.replaceNotification(updated);
        }
      },
    });
  }

  markAllRead(event: Event): void {
    event.stopPropagation();
    this.api.notifications.markAllRead().subscribe({
      next: () => this.refresh(),
    });
  }

  navigate(notification: Notification): void {
    if (notification.readAt === null) {
      this.api.notifications.markRead(notification.id).subscribe({
        next: (updated) => this.replaceNotification(updated),
      });
    }
    this.navigated.emit({ notification });
    this.close();
  }

  formatRelative(timestamp: number): string {
    return formatRelativeAgo(timestamp, Date.now());
  }

  protected isUnread(notification: Notification): boolean {
    return notification.readAt === null && notification.dismissedAt === null;
  }

  private replaceNotification(next: Notification): void {
    this.notifications.update((list) => list.map((n) => (n.id === next.id ? next : n)));
  }

  private loadMutedKinds(): NotificationKind[] {
    try {
      const raw = localStorage.getItem(PREF_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((value): value is NotificationKind =>
        typeof value === 'string' && ALL_KINDS.includes(value as NotificationKind),
      );
    } catch {
      return [];
    }
  }

  private persistMutedKinds(set: Set<NotificationKind>): void {
    try {
      localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify([...set]));
    } catch {
      // ignore
    }
  }
}
