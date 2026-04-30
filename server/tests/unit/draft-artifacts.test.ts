import { describe, expect, it } from 'vitest';
import { extractDraftArtifacts } from '../../src/draft-artifacts.js';

describe('extractDraftArtifacts', () => {
  it('strips hidden draft blocks and keeps recoverable content', () => {
    const result = extractDraftArtifacts(
      [
        'I need write permission before applying this.',
        '/draft-artifact',
        'name: admin-deploy.md',
        'target: docs/runbooks/admin-deploy.md',
        'content:',
        '# Admin Deploy',
        '',
        'Concrete runbook body.',
        '/end-draft-artifact',
        'Requesting permission next.',
      ].join('\n'),
    );

    expect(result.visibleText).toBe(
      'I need write permission before applying this.\nRequesting permission next.',
    );
    expect(result.drafts).toEqual([
      {
        name: 'admin-deploy.md',
        target: 'docs/runbooks/admin-deploy.md',
        content: '# Admin Deploy\n\nConcrete runbook body.',
      },
    ]);
  });
});
