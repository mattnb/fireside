import { describe, expect, it } from 'vitest';
import {
  canDispatchWorkItem,
  createGitHubIssueAdapter,
  createLinearIssueAdapter,
  githubIssueToWorkItem,
  isEligibleBlocker,
  isTerminalWorkItemState,
  linearIssueToWorkItem,
  markdownTaskFileAdapter,
  matchesWorkItemState,
  normalizeWorkItemPriority,
  normalizeWorkItemState,
  parseMarkdownTaskFile,
  selectDispatchableWorkItems,
  sortWorkItemsForDispatch,
  validateGitHubIssue,
  validateLinearIssue,
  type WorkItem,
} from '../../src/work-intake.js';

describe('work intake normalization', () => {
  it('normalizes external state and priority vocabulary', () => {
    expect(normalizeWorkItemState('in progress')).toBe('in_progress');
    expect(normalizeWorkItemState('closed')).toBe('done');
    expect(normalizeWorkItemState('not planned')).toBe('canceled');
    expect(normalizeWorkItemPriority('P0')).toBe('urgent');
    expect(normalizeWorkItemPriority(4)).toBe('low');
    expect(isTerminalWorkItemState('done')).toBe(true);
  });

  it('matches active, terminal, and dispatchable items', () => {
    const done = item({ id: 'done', state: 'done' });
    const ready = item({ id: 'ready', state: 'ready' });

    expect(matchesWorkItemState(done, 'terminal')).toBe(true);
    expect(matchesWorkItemState(done, 'active')).toBe(false);
    expect(matchesWorkItemState(ready, 'active')).toBe(true);
    expect(matchesWorkItemState(ready, 'dispatchable', [ready])).toBe(true);
  });
});

describe('work intake blocker gating', () => {
  it('keeps blocked work out of dispatch until blockers are terminal', () => {
    const blocker = item({ id: 'FS-1', identifier: 'FS-1', state: 'in_progress' });
    const blocked = item({ id: 'FS-2', identifier: 'FS-2', blockedBy: ['FS-1'] });

    expect(isEligibleBlocker(blocker, blocked)).toBe(true);
    expect(canDispatchWorkItem(blocked, [blocker, blocked])).toBe(false);

    const completedBlocker = item({ id: 'FS-1', identifier: 'FS-1', state: 'done' });
    expect(isEligibleBlocker(completedBlocker, blocked)).toBe(false);
    expect(canDispatchWorkItem(blocked, [completedBlocker, blocked])).toBe(true);
  });

  it('treats missing blockers and explicit blocked state as not dispatchable', () => {
    expect(canDispatchWorkItem(item({ blockedBy: ['missing'] }), [])).toBe(false);
    expect(canDispatchWorkItem(item({ state: 'blocked' }), [])).toBe(false);
  });
});

describe('work intake dispatch ordering', () => {
  it('sorts by priority, then created time, then id', () => {
    const items = [
      item({ id: 'c', priority: 'medium', createdAt: Date.parse('2026-04-03T00:00:00Z') }),
      item({ id: 'b', priority: 'high', createdAt: Date.parse('2026-04-02T00:00:00Z') }),
      item({ id: 'a', priority: 'high', createdAt: Date.parse('2026-04-02T00:00:00Z') }),
      item({ id: 'd', priority: 'urgent', createdAt: Date.parse('2026-04-04T00:00:00Z') }),
    ];

    expect(sortWorkItemsForDispatch(items).map((workItem) => workItem.id)).toEqual([
      'd',
      'a',
      'b',
      'c',
    ]);
  });

  it('filters to dispatchable work before sorting', () => {
    const doneBlocker = item({ id: 'FS-1', identifier: 'FS-1', state: 'done' });
    const ready = item({
      id: 'FS-2',
      identifier: 'FS-2',
      priority: 'high',
      blockedBy: ['FS-1'],
    });
    const terminal = item({ id: 'FS-3', identifier: 'FS-3', state: 'done', priority: 'urgent' });
    const blocked = item({ id: 'FS-4', identifier: 'FS-4', state: 'blocked', priority: 'urgent' });

    expect(selectDispatchableWorkItems([terminal, blocked, ready, doneBlocker])).toEqual([ready]);
  });
});

describe('markdown work intake adapter', () => {
  it('parses simple markdown task files into normalized work items', () => {
    const parsed = parseMarkdownTaskFile(
      [
        '- [ ] [FS-10] Build intake model priority:P1 state:ready branch:feat/intake #server',
        '  Keep this independent from broker persistence.',
        '- [x] FS-9: Prior dependency priority:P2 created:2026-04-20T00:00:00Z #infra',
        '- [ ] Follow-on validation id:FS-11 blocked-by:FS-9 url:https://example.test/issues/11',
      ].join('\n'),
      { sourceName: 'tasks.md', path: 'docs/tasks.md' },
    );

    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      id: 'markdown:tasks.md:FS-10',
      identifier: 'FS-10',
      title: 'Build intake model',
      description: 'Keep this independent from broker persistence.',
      priority: 'high',
      state: 'ready',
      branchName: 'feat/intake',
      labels: ['server'],
      source: { kind: 'markdown', name: 'tasks.md', externalId: 'docs/tasks.md:1' },
    });
    expect(parsed[1]).toMatchObject({
      identifier: 'FS-9',
      state: 'done',
      createdAt: Date.parse('2026-04-20T00:00:00Z'),
    });
    expect(parsed[2]).toMatchObject({
      identifier: 'FS-11',
      blockedBy: ['FS-9'],
      url: 'https://example.test/issues/11',
    });
  });

  it('validates markdown adapter input before parsing', () => {
    expect(markdownTaskFileAdapter.validate({ content: '- [ ] Task' })).toEqual({
      ok: true,
      errors: [],
    });
    expect(markdownTaskFileAdapter.validate({ content: 42 }).ok).toBe(false);
    expect(() => markdownTaskFileAdapter.collect({ content: '- [ ] Task id:FS-1' })).not.toThrow();
  });
});

describe('GitHub work intake adapter', () => {
  it('normalizes GitHub issues without performing network work', () => {
    const adapter = createGitHubIssueAdapter({ owner: 'wildmason', repo: 'fireside' });
    const collected = adapter.collect({
      id: 123456,
      number: 42,
      title: 'Wire external intake',
      body: 'Normalize issue tracker work.',
      state: 'open',
      html_url: 'https://github.com/wildmason/fireside/issues/42',
      labels: ['priority:P0', { name: 'blocked' }, { name: 'server' }],
      created_at: '2026-04-21T00:00:00Z',
    });

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      id: 'github:wildmason/fireside#42',
      identifier: 'wildmason/fireside#42',
      title: 'Wire external intake',
      priority: 'urgent',
      state: 'blocked',
      source: { kind: 'github', name: 'wildmason/fireside', externalId: '123456' },
      createdAt: Date.parse('2026-04-21T00:00:00Z'),
    });
  });

  it('validates required GitHub issue fields', () => {
    expect(validateGitHubIssue({ id: 1, number: 1, title: 'ok' })).toEqual({
      ok: true,
      errors: [],
    });
    expect(validateGitHubIssue({ id: 1, title: 'missing number' }).errors).toContain(
      'number must be a finite number',
    );
    expect(() => githubIssueToWorkItem({ id: 1, number: Number.NaN, title: '' })).toThrow(
      'Invalid GitHub issue',
    );
  });
});

describe('Linear work intake adapter', () => {
  it('normalizes Linear issues and blocker references', () => {
    const adapter = createLinearIssueAdapter({ workspace: 'wildmason' });
    const [workItem] = adapter.collect({
      id: 'linear-id-1',
      identifier: 'FIR-18',
      title: 'Import Linear work',
      description: 'Stub only.',
      priority: 2,
      state: { name: 'In Progress', type: 'started' },
      branchName: 'matt/fir-18-import-linear-work',
      url: 'https://linear.app/wildmason/issue/FIR-18/import-linear-work',
      labels: [{ name: 'server' }],
      blockedBy: [{ identifier: 'FIR-17' }, 'FIR-16'],
      createdAt: '2026-04-22T00:00:00Z',
    });

    expect(workItem).toMatchObject({
      id: 'linear:linear-id-1',
      identifier: 'FIR-18',
      priority: 'high',
      state: 'in_progress',
      branchName: 'matt/fir-18-import-linear-work',
      blockedBy: ['FIR-17', 'FIR-16'],
      source: { kind: 'linear', name: 'wildmason', externalId: 'linear-id-1' },
    });
  });

  it('validates required Linear issue fields', () => {
    expect(validateLinearIssue({ id: 'id', identifier: 'FIR-1', title: 'ok' })).toEqual({
      ok: true,
      errors: [],
    });
    expect(validateLinearIssue({ id: 'id', title: 'missing identifier' }).errors).toContain(
      'identifier must be a non-empty string',
    );
    expect(() => linearIssueToWorkItem({ id: '', identifier: '', title: '' })).toThrow(
      'Invalid Linear issue',
    );
  });
});

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  const id = overrides.id ?? 'FS-1';
  return {
    id,
    identifier: overrides.identifier ?? id,
    title: overrides.title ?? id,
    description: overrides.description ?? '',
    priority: overrides.priority ?? 'medium',
    state: overrides.state ?? 'ready',
    branchName: overrides.branchName ?? '',
    url: overrides.url ?? '',
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    source: overrides.source ?? { kind: 'markdown', name: 'test', externalId: id },
    createdAt: overrides.createdAt ?? 0,
    metadata: overrides.metadata ?? {},
  };
}
