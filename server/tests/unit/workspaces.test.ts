import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPathInsideRoot,
  cleanupWorkspace,
  ensureWorkspace,
  getWorkspace,
  getWorkspacePath,
  runWorkspaceHook,
  sanitizeWorkspaceKey,
  WorkspacePathError,
} from '../../src/workspaces.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fireside-workspaces-test-'));
  tempDirs.push(dir);
  return dir;
}

function quoteArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('sanitizeWorkspaceKey', () => {
  it('turns arbitrary mission and task labels into safe path segments', () => {
    expect(sanitizeWorkspaceKey(' Mission: Alpha/../Task? ')).toBe('Mission-Alpha-..-Task');
    expect(sanitizeWorkspaceKey('../')).toBe('workspace');
    expect(sanitizeWorkspaceKey('!!!', 'fallback key')).toBe('fallback-key');
    expect(sanitizeWorkspaceKey('CON.txt')).toBe('CON-txt-workspace');
  });

  it('keeps long keys bounded while retaining a stable hash suffix', () => {
    const key = sanitizeWorkspaceKey('a'.repeat(140));
    expect(key).toHaveLength(96);
    expect(key).toMatch(/^a+-[a-f0-9]{8}$/);
  });
});

describe('workspace path computation', () => {
  it('computes nested per-mission and per-task paths under the root', async () => {
    const root = path.join(await makeTempDir(), 'root');
    const workspace = getWorkspace(root, {
      missionId: 'mission/../../outside',
      taskId: 'task\\..\\x',
    });

    expect(workspace.missionKey).toBe('mission-..-..-outside');
    expect(workspace.taskKey).toBe('task-..-x');
    expect(workspace.path).toBe(path.join(path.resolve(root), workspace.missionKey, 'task-..-x'));
    expect(getWorkspacePath(root, { missionId: 'mission/../../outside', taskId: 'task\\..\\x' }))
      .toBe(workspace.path);
  });

  it('rejects candidate paths that escape the configured root', async () => {
    const root = path.join(await makeTempDir(), 'root');
    const outside = path.resolve(root, '..', 'outside');

    expect(() => assertPathInsideRoot(root, outside)).toThrow(WorkspacePathError);
    expect(() => assertPathInsideRoot(root, root)).toThrow(WorkspacePathError);
  });
});

describe('workspace lifecycle', () => {
  it('creates a workspace once and reuses it on later ensures', async () => {
    const root = path.join(await makeTempDir(), 'root');
    const ref = { missionId: 'mission 1', taskId: 'task 1' };

    const first = await ensureWorkspace(root, ref);
    const second = await ensureWorkspace(root, ref);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.workspace.path).toBe(first.workspace.path);
    expect(await pathExists(first.workspace.path)).toBe(true);
  });

  it('runs onCreate hooks only when the workspace is first created', async () => {
    const tempDir = await makeTempDir();
    const root = path.join(tempDir, 'root');
    const script = path.join(tempDir, 'hook-ok.cjs');
    await writeFile(
      script,
      "require('node:fs').writeFileSync('created.txt', process.cwd(), 'utf8');",
      'utf8',
    );
    const command = `${quoteArg(process.execPath)} ${quoteArg(script)}`;

    const first = await ensureWorkspace(root, { missionId: 'm', taskId: 't' }, { onCreate: command });
    const second = await ensureWorkspace(root, { missionId: 'm', taskId: 't' }, { onCreate: command });

    expect(first.hook?.ok).toBe(true);
    expect(second.hook).toBeUndefined();
    expect(await readFile(path.join(first.workspace.path, 'created.txt'), 'utf8')).toBe(
      first.workspace.path,
    );
  });

  it('removes workspace directories and reports missing cleanup as a no-op', async () => {
    const root = path.join(await makeTempDir(), 'root');
    const ref = { missionId: 'mission cleanup', taskId: 'task cleanup' };
    const ensured = await ensureWorkspace(root, ref);
    await writeFile(path.join(ensured.workspace.path, 'payload.txt'), 'payload', 'utf8');

    const removed = await cleanupWorkspace(root, ref);
    const missing = await cleanupWorkspace(root, ref);

    expect(removed.existed).toBe(true);
    expect(removed.removed).toBe(true);
    expect(await pathExists(ensured.workspace.path)).toBe(false);
    expect(missing.existed).toBe(false);
    expect(missing.removed).toBe(false);
    expect(missing.skippedReason).toBe('missing');
  });

  it('does not remove a workspace when a beforeCleanup hook fails by default', async () => {
    const tempDir = await makeTempDir();
    const root = path.join(tempDir, 'root');
    const ref = { missionId: 'mission hook cleanup', taskId: 'task hook cleanup' };
    const script = path.join(tempDir, 'hook-fail.cjs');
    await writeFile(script, 'process.stderr.write("cleanup blocked"); process.exit(7);', 'utf8');
    const command = `${quoteArg(process.execPath)} ${quoteArg(script)}`;
    const ensured = await ensureWorkspace(root, ref);

    const result = await cleanupWorkspace(root, ref, { beforeCleanup: command });

    expect(result.removed).toBe(false);
    expect(result.skippedReason).toBe('hookFailed');
    expect(result.hook?.ok).toBe(false);
    expect(result.hook?.exitCode).toBe(7);
    expect(result.hook?.stderr).toBe('cleanup blocked');
    expect(await pathExists(ensured.workspace.path)).toBe(true);
  });
});

describe('runWorkspaceHook', () => {
  it('returns structured success and failure results', async () => {
    const tempDir = await makeTempDir();
    const workspace = (await ensureWorkspace(path.join(tempDir, 'root'), { missionId: 'm' }))
      .workspace;
    const okScript = path.join(tempDir, 'hook-success.cjs');
    const failScript = path.join(tempDir, 'hook-failure.cjs');
    await writeFile(okScript, 'process.stdout.write(process.cwd());', 'utf8');
    await writeFile(failScript, 'process.stderr.write("bad hook"); process.exit(9);', 'utf8');

    const ok = await runWorkspaceHook(workspace.path, `${quoteArg(process.execPath)} ${quoteArg(okScript)}`);
    const fail = await runWorkspaceHook(
      workspace.path,
      `${quoteArg(process.execPath)} ${quoteArg(failScript)}`,
    );

    expect(ok.ok).toBe(true);
    expect(ok.exitCode).toBe(0);
    expect(ok.cwd).toBe(workspace.path);
    expect(ok.stdout).toBe(workspace.path);
    expect(fail.ok).toBe(false);
    expect(fail.exitCode).toBe(9);
    expect(fail.stderr).toBe('bad hook');
  });

  it('times out long-running hooks', async () => {
    const tempDir = await makeTempDir();
    const workspace = (await ensureWorkspace(path.join(tempDir, 'root'), { missionId: 'm' }))
      .workspace;
    const script = path.join(tempDir, 'hook-slow.cjs');
    await writeFile(script, 'setInterval(() => {}, 1000);', 'utf8');

    const result = await runWorkspaceHook(workspace.path, {
      command: `${quoteArg(process.execPath)} ${quoteArg(script)}`,
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });
});
