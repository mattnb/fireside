// client/app/topbar/topbar.ts
// Workspace top bar: channel name on the left and either a project-
// dashboard chip (when no room is selected) or the chat/mission/briefings
// tab strip (when a room is selected). Pure presentational — App owns
// `selectedTab` and tab-switching action.

import { Component, input, output } from '@angular/core';

export type TopbarTab<TId extends string = string> = {
  id: TId;
  label: string;
};

@Component({
  selector: 'fs-topbar',
  standalone: true,
  templateUrl: './topbar.html',
  styleUrl: './topbar.css',
})
export class Topbar<TabId extends string = string> {
  readonly channelName = input<string>('');
  readonly hashShown = input<boolean>(false);
  readonly showProjectDashboardChip = input<boolean>(false);
  readonly tabs = input<TopbarTab<TabId>[]>([]);
  readonly selectedTab = input<TabId | null>(null);

  readonly tabSelected = output<TabId>();
}
