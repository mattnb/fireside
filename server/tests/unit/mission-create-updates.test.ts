import { describe, expect, it } from 'vitest';
import { extractMissionCreateUpdates } from '../../src/mission-create-updates.js';

describe('mission create extraction', () => {
  it('extracts hidden mission creation blocks without exposing protocol text', () => {
    const extracted = extractMissionCreateUpdates(`I'll turn this into a mission.

/mission-create
title: Analyze the strategy doc
goal: Convert the shared document into an actionable mission plan.
repo_path: C:/work/project
acceptance: Plan, phases, checklist, owners, and dependencies are populated.
agents: claude, codex
capability_profile: edit
summary: Initial mission scaffold from chat context.
/end-mission-create

Mission scaffolded.`);

    expect(extracted.visibleText).toContain("I'll turn this into a mission.");
    expect(extracted.visibleText).toContain('Mission scaffolded.');
    expect(extracted.visibleText).not.toContain('/mission-create');
    expect(extracted.updates).toEqual([
      {
        title: 'Analyze the strategy doc',
        goal: 'Convert the shared document into an actionable mission plan.',
        repoPath: 'C:/work/project',
        acceptanceCriteria: 'Plan, phases, checklist, owners, and dependencies are populated.',
        agents: ['claude', 'codex'],
        capabilityProfile: 'edit',
        summary: 'Initial mission scaffold from chat context.',
      },
    ]);
  });

  it('ignores invalid blocks without a title', () => {
    const extracted = extractMissionCreateUpdates(`/mission-create
goal: Missing a title.
/end-mission-create`);

    expect(extracted.visibleText).toBe('');
    expect(extracted.updates).toEqual([]);
  });

  it('accepts accidental @ end markers', () => {
    const extracted = extractMissionCreateUpdates(`Scaffolding.

/mission-create
title: Build operator visibility
goal: Populate Mission Control from chat.
@end-mission-create`);

    expect(extracted.visibleText).toBe('Scaffolding.');
    expect(extracted.updates).toMatchObject([
      {
        title: 'Build operator visibility',
        goal: 'Populate Mission Control from chat.',
      },
    ]);
  });
});
