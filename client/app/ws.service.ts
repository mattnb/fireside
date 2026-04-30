import { Injectable, NgZone, inject } from '@angular/core';
import { Observable, Subject, timer } from 'rxjs';

import { FiresideWsEvent, YoloPermissionProfile } from './api.types';

@Injectable({ providedIn: 'root' })
export class FiresideWs {
  private readonly zone = inject(NgZone);
  private readonly events = new Subject<FiresideWsEvent>();
  private socket: WebSocket | null = null;
  private subscribedRoomId: string | null = null;

  readonly stream$: Observable<FiresideWsEvent> = this.events.asObservable();

  connect(): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(`${protocol}//${location.host}/ws`);

    this.socket.addEventListener('open', () => {
      if (this.subscribedRoomId) this.subscribe(this.subscribedRoomId);
    });

    this.socket.addEventListener('message', (event) => {
      const parsed = this.parseEvent(event.data);
      if (!parsed) return;
      this.zone.run(() => this.events.next(parsed));
    });

    this.socket.addEventListener('close', () => {
      this.socket = null;
      timer(1000).subscribe(() => this.connect());
    });
  }

  subscribe(roomId: string): void {
    this.subscribedRoomId = roomId;
    this.send({ type: 'subscribe', roomId });
  }

  postMessage(roomId: string, authorId: string, text: string): void {
    this.send({ type: 'postMessage', roomId, authorId, text });
  }

  startYolo(roomId: string, authorId: string, profile: YoloPermissionProfile): void {
    this.send({ type: 'startYolo', roomId, authorId, profile });
  }

  cancelYolo(roomId: string, authorId: string): void {
    this.send({ type: 'cancelYolo', roomId, authorId });
  }

  stopRuns(roomId: string, authorId: string): void {
    this.send({ type: 'stopRuns', roomId, authorId });
  }

  addYoloTurns(roomId: string, authorId: string, turns: number): void {
    this.send({ type: 'addYoloTurns', roomId, authorId, turns });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private parseEvent(data: unknown): FiresideWsEvent | null {
    if (typeof data !== 'string') return null;
    try {
      return JSON.parse(data) as FiresideWsEvent;
    } catch {
      return null;
    }
  }
}
