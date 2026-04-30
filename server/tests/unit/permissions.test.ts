import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  extractPermissionRequest,
  parsePermissionRequest,
  permissionTargetDirectory,
} from '../../src/permissions.js';

describe('parsePermissionRequest', () => {
  it('parses the strict permission request block', () => {
    expect(
      parsePermissionRequest(
        [
          '/permission-request',
          'mode: edit',
          'target: foobar.txt',
          'reason: I need to write the agreed recap.',
        ].join('\n'),
      ),
    ).toMatchObject({
      mode: 'edit',
      requestedMode: 'edit',
      target: 'foobar.txt',
      reason: 'I need to write the agreed recap.',
      capabilities: expect.arrayContaining(['read', 'edit-existing', 'create-file']),
    });
  });

  it('extracts a permission request embedded in surrounding chat text', () => {
    expect(
      extractPermissionRequest(
        [
          'Understood - one at a time. Here is the first:',
          '',
          '/permission-request',
          'mode: edit',
          'target: C:\\workspaces\\licensing\\docs\\runbooks\\admin-deploy.md',
          'reason: Author the canonical source-of-truth runbook.',
        ].join('\n'),
      ),
    ).toMatchObject({
      request: {
        mode: 'edit',
        requestedMode: 'edit',
        target:
          'C:\\workspaces\\licensing\\docs\\runbooks\\admin-deploy.md',
        reason: 'Author the canonical source-of-truth runbook.',
        capabilities: expect.arrayContaining(['read', 'edit-existing', 'create-file']),
      },
      visibleText: 'Understood - one at a time. Here is the first:',
    });
  });

  it('normalizes write/create aliases from embedded agent requests to edit permission', () => {
    expect(
      extractPermissionRequest(
        [
          'Blocked. The approved permission was edit, but this is a new file.',
          '',
          'Re-requesting with the right mode:',
          '',
          '/permission-request',
          'mode: write',
          'target: C:\\workspaces\\licensing\\docs\\runbooks\\admin-deploy.md',
          'reason: Create the canonical source-of-truth runbook.',
        ].join('\n'),
      ),
    ).toMatchObject({
      request: {
        mode: 'edit',
        requestedMode: 'write',
        target:
          'C:\\workspaces\\licensing\\docs\\runbooks\\admin-deploy.md',
        reason: 'Create the canonical source-of-truth runbook.',
        capabilities: expect.arrayContaining(['read', 'edit-existing', 'create-file']),
      },
      visibleText:
        'Blocked. The approved permission was edit, but this is a new file.\n\nRe-requesting with the right mode:',
    });

    expect(
      parsePermissionRequest(
        '/permission-request\nmode: create\ntarget: docs/new.md\nreason: Create a new file.',
      ),
    ).toMatchObject({
      mode: 'edit',
      requestedMode: 'create',
      target: 'docs/new.md',
      reason: 'Create a new file.',
      capabilities: expect.arrayContaining(['read', 'edit-existing', 'create-file']),
    });
  });

  it('normalizes embedded bash requests into scoped command permission', () => {
    const result = extractPermissionRequest(
      [
        'Per sequencing, requesting the next scope now.',
        '',
        '/permission-request',
        'mode: bash',
        'target: C:\\workspaces\\licensing',
        'reason: Stage and commit the tightened runbook. Exact commands: git -C "C:\\workspaces\\licensing" add docs/runbooks/admin-deploy.md then git -C "C:\\workspaces\\licensing" commit -m "docs(licensing): add wm-license-contract/v1 admin-deploy runbook". No push.',
      ].join('\n'),
      'claude',
    );

    expect(result).toMatchObject({
      request: {
        mode: 'full-auto',
        requestedMode: 'bash',
        target: 'C:\\workspaces\\licensing',
        capabilities: expect.arrayContaining(['read', 'run-command', 'git-commit']),
        providerProfile: expect.stringContaining('allowed Bash(git *)'),
      },
      visibleText: 'Per sequencing, requesting the next scope now.',
    });
    expect(result?.request.capabilities).not.toContain('git-push');
  });

  it('stops the extracted request block before trailing visible text', () => {
    expect(
      extractPermissionRequest(
        [
          'First I need this:',
          '/permission-request',
          'mode: edit',
          'target: docs/admin-deploy.md',
          'reason: Write the runbook.',
          'I will wait for approval before continuing.',
        ].join('\n'),
      ),
    ).toMatchObject({
      request: {
        mode: 'edit',
        requestedMode: 'edit',
        target: 'docs/admin-deploy.md',
        reason: 'Write the runbook.',
        capabilities: expect.arrayContaining(['read', 'edit-existing', 'create-file']),
      },
      visibleText: 'First I need this:\nI will wait for approval before continuing.',
    });
  });

  it('ignores ordinary chat', () => {
    expect(parsePermissionRequest('I can do that after you approve.')).toBeNull();
  });

  it('rejects malformed request blocks', () => {
    expect(parsePermissionRequest('/permission-request\nmode: root\ntarget: x\nreason: y')).toBeNull();
    expect(parsePermissionRequest('/permission-request\nmode: edit\ntarget: x')).toBeNull();
  });

  it('extracts a directory from an approved file target', () => {
    const dir = permissionTargetDirectory(
      'C:\\workspaces\\crucible\\docs\\strategy.md',
    );
    expect(dir).toBe(
      'C:\\workspaces\\crucible\\docs',
    );
  });

  it('resolves relative path targets from the current process directory', () => {
    expect(permissionTargetDirectory('docs/strategy.md')).toBe(
      path.resolve(process.cwd(), 'docs'),
    );
  });
});
