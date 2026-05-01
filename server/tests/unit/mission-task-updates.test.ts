import { describe, expect, it } from 'vitest';
import { extractMissionTaskUpdates } from '../../src/mission-task-updates.js';

describe('mission task update extraction', () => {
  it('normalizes completion-oriented status aliases to done', () => {
    const extracted = extractMissionTaskUpdates(`Task accepted.

/mission-task
action: update
title: Merge full strategy-doc audit
status: accepted
note: Audit merge accepted by both agents.
/end-mission-task`);

    expect(extracted.visibleText).toBe('Task accepted.');
    expect(extracted.updates).toMatchObject([
      {
        action: 'update',
        title: 'Merge full strategy-doc audit',
        status: 'done',
        note: 'Audit merge accepted by both agents.',
        noteKind: 'completion',
      },
    ]);
  });

  it('extracts embedded task blocks when agents accidentally use the collab-note end marker', () => {
    const extracted =
      extractMissionTaskUpdates(`Configure-mode Project Memory audit + revert surface is landed.

/mission-task
action: update
id: ujw-xyLEmsP3h6
status: done
note: ConfigureMemory component landed with full audit list + per-entry inline-reason revert flow.
/end-collab-note

/mission-task
action: update
id: iJTA_-77NbKWmM
status: done
note: Coarse Configure-mode slice satisfied by child work.
/end-collab-note

/mission-task
action: update
id: 0u9NJS0yzJl70o
status: in_progress
owner: claude
note: Picking up next.
/end-collab-note`);

    expect(extracted.visibleText).toBe(
      'Configure-mode Project Memory audit + revert surface is landed.',
    );
    expect(extracted.updates).toMatchObject([
      {
        id: 'ujw-xyLEmsP3h6',
        status: 'done',
        noteKind: 'completion',
      },
      {
        id: 'iJTA_-77NbKWmM',
        status: 'done',
        noteKind: 'completion',
      },
      {
        id: '0u9NJS0yzJl70o',
        status: 'open',
        ownerAgentId: 'claude',
        note: 'Picking up next.',
      },
    ]);
  });

  it('accepts accidental @ end markers', () => {
    const extracted = extractMissionTaskUpdates(`Task closed.

/mission-task
action: update
id: Gu3ICTLUNKStqb
status: done
note: Closed as non-blocking/superseded for mission acceptance.
@end-mission-task`);

    expect(extracted.visibleText).toBe('Task closed.');
    expect(extracted.updates).toMatchObject([
      {
        id: 'Gu3ICTLUNKStqb',
        status: 'done',
        note: 'Closed as non-blocking/superseded for mission acceptance.',
        noteKind: 'completion',
      },
    ]);
  });

  it('extracts parallel work scope contracts from task blocks', () => {
    const extracted = extractMissionTaskUpdates(`Planned parallel work.

/mission-task
action: create
title: Build board filters
status: open
expected_touches: client/app/app.html, client/app/app.ts, client/app/app.css
parallelism: coordinate
conflict_group: mission-board-ui
work_role: implement
note: UI slice can run beside backend tests but should coordinate with board markup edits.
/end-mission-task`);

    expect(extracted.updates).toMatchObject([
      {
        action: 'create',
        title: 'Build board filters',
        expectedTouches: ['client/app/app.html', 'client/app/app.ts', 'client/app/app.css'],
        parallelism: 'coordinate',
        conflictGroup: 'mission-board-ui',
        workRole: 'implement',
      },
    ]);
  });
});
