import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_WORKFLOW_AGENT_CONFIG,
  DEFAULT_WORKFLOW_PROMPT_BUDGET_CHARS,
  WorkflowProfileError,
  discoverWorkflowProfilePath,
  loadWorkflowProfile,
  parseWorkflowProfileMarkdown,
  workflowProfileCandidatePaths,
} from '../../src/workflow-profile.js';

function tempRepo(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'fireside-workflow-profile-'));
}

describe('parseWorkflowProfileMarkdown', () => {
  it('parses a body-only workflow profile with typed defaults', () => {
    const repoPath = tempRepo();
    const body = 'Coordinate this mission with short, parallel updates.\n';

    const profile = parseWorkflowProfileMarkdown(body, { repoPath });

    expect(profile.body).toBe(body);
    expect(profile.promptTemplate).toBe(body);
    expect(profile.promptBudgetChars).toBe(DEFAULT_WORKFLOW_PROMPT_BUDGET_CHARS);
    expect(profile.agent).toEqual(DEFAULT_WORKFLOW_AGENT_CONFIG);
    expect(profile.workspace.root).toBe(path.resolve(repoPath));
    expect(profile.hooks).toEqual({
      afterCreate: [],
      beforeRun: [],
      afterRun: [],
      beforeRemove: [],
    });
    expect(profile.permissions).toEqual({
      mode: 'plan',
      capabilities: ['read'],
      web: false,
    });
  });

  it('parses front matter overrides and keeps the markdown body separate', () => {
    const repoPath = tempRepo();

    const profile = parseWorkflowProfileMarkdown(
      [
        '---',
        'agent:',
        '  maxTurns: 12',
        '  maxConcurrentAgents: 4',
        '  maxRetryBackoffMs: 1500',
        'promptBudgetChars: 24000',
        'workspace:',
        '  root: ./missions',
        'hooks:',
        '  afterCreate: npm install',
        '  beforeRun:',
        '    - npm test',
        '    - npm run lint',
        '  afterRun: "node scripts/report.js"',
        '  beforeRemove:',
        '    - git status --short',
        'permissions:',
        '  mode: edit',
        '  filesystemScope: cwd',
        '  target: ./src',
        '  web: true',
        '  capabilities: [read, edit-existing, create-file, network]',
        '  providerProfile: codex workspace-write',
        'promptTemplate: |',
        '  Mission: {{mission}}',
        '  Repo: {{workspace.root}}',
        '---',
        '# Profile notes',
        'Use the hooks around each agent run.',
      ].join('\n'),
      { repoPath },
    );

    expect(profile.agent).toEqual({
      maxTurns: 12,
      maxConcurrentAgents: 4,
      maxRetryBackoffMs: 1500,
    });
    expect(profile.promptBudgetChars).toBe(24_000);
    expect(profile.workspace.root).toBe(path.resolve(repoPath, 'missions'));
    expect(profile.hooks).toEqual({
      afterCreate: ['npm install'],
      beforeRun: ['npm test', 'npm run lint'],
      afterRun: ['node scripts/report.js'],
      beforeRemove: ['git status --short'],
    });
    expect(profile.permissions).toEqual({
      mode: 'edit',
      capabilities: ['read', 'edit-existing', 'create-file', 'network'],
      web: true,
      filesystemScope: 'cwd',
      target: './src',
      providerProfile: 'codex workspace-write',
    });
    expect(profile.promptTemplate).toBe('Mission: {{mission}}\nRepo: {{workspace.root}}');
    expect(profile.body).toBe('# Profile notes\nUse the hooks around each agent run.');
  });

  it('expands environment variables and home-relative paths for profile paths', () => {
    const repoPath = tempRepo();
    const homePath = path.join(repoPath, 'home');
    const envRoot = path.join(repoPath, 'env-root');
    const env = {
      ...process.env,
      HOME: homePath,
      USERPROFILE: homePath,
      WF_ROOT: envRoot,
    };

    const envProfile = parseWorkflowProfileMarkdown(
      ['---', 'workspace:', '  root: ${WF_ROOT}/mission', '---', 'body'].join('\n'),
      { repoPath, env },
    );
    const homeProfile = parseWorkflowProfileMarkdown(
      ['---', 'workspace:', '  root: ~/mission', '---', 'body'].join('\n'),
      { repoPath, env },
    );

    expect(envProfile.workspace.root).toBe(path.resolve(envRoot, 'mission'));
    expect(homeProfile.workspace.root).toBe(path.resolve(homePath, 'mission'));
  });

  it('rejects non-map-ish front matter', () => {
    expect(() =>
      parseWorkflowProfileMarkdown(['---', '- not a map', '---', 'body'].join('\n')),
    ).toThrow(WorkflowProfileError);
  });

  it('rejects malformed scalars and invalid typed scalar values', () => {
    expect(() =>
      parseWorkflowProfileMarkdown(
        ['---', 'promptTemplate: "unterminated', '---', 'body'].join('\n'),
      ),
    ).toThrow(WorkflowProfileError);

    expect(() =>
      parseWorkflowProfileMarkdown(['---', 'agent:', '  maxTurns: many', '---', 'body'].join('\n')),
    ).toThrow(/maxTurns/);
  });
});

describe('workflow profile discovery', () => {
  it('uses explicit file, .fireside, FIRESIDE_WORKFLOW, then WORKFLOW precedence', () => {
    const repoPath = tempRepo();
    const firesideDir = path.join(repoPath, '.fireside');
    mkdirSync(firesideDir);
    const explicitPath = path.join(repoPath, 'explicit.md');
    const firesidePath = path.join(firesideDir, 'workflow.md');
    const firesideWorkflowPath = path.join(repoPath, 'FIRESIDE_WORKFLOW.md');
    const workflowPath = path.join(repoPath, 'WORKFLOW.md');

    writeFileSync(explicitPath, 'explicit body', 'utf8');
    writeFileSync(firesidePath, 'fireside body', 'utf8');
    writeFileSync(firesideWorkflowPath, 'fireside workflow body', 'utf8');
    writeFileSync(workflowPath, 'workflow body', 'utf8');

    expect(workflowProfileCandidatePaths({ repoPath, explicitFilePath: 'explicit.md' })).toEqual([
      explicitPath,
      firesidePath,
      firesideWorkflowPath,
      workflowPath,
    ]);
    expect(discoverWorkflowProfilePath({ repoPath })).toBe(firesidePath);
    expect(loadWorkflowProfile({ repoPath })?.body).toBe('fireside body');
    expect(discoverWorkflowProfilePath({ repoPath, explicitFilePath: 'explicit.md' })).toBe(
      explicitPath,
    );
    expect(loadWorkflowProfile({ repoPath, explicitFilePath: 'explicit.md' })?.body).toBe(
      'explicit body',
    );
  });
});
