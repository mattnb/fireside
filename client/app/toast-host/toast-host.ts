// client/app/toast-host/toast-host.ts
// Renders the live toast stack. Mounted once at App root; reads from
// ToastService and routes click events back to it. Uses Emulated
// encapsulation so its layout/animation rules are component-private.

import { Component, inject } from '@angular/core';

import { ToastService } from '../toast.service';

@Component({
  selector: 'fs-toast-host',
  standalone: true,
  templateUrl: './toast-host.html',
  styleUrl: './toast-host.css',
})
export class ToastHost {
  protected readonly toastService = inject(ToastService);
}
