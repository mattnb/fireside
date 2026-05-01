import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { normalizeLineEndings, stripBom } from './windows/encoding.js';
import { killTree } from './windows/tree-kill.js';

const MAX_WORKSPACE_KEY_LENGTH = 96;
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const WINDOWS_RESERVED_BASENAME =
  /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

export interface WorkspaceRef {
  missionId: string;
  taskId?: string | null;
}

export interface WorkspaceKeys {
  missionKey: string;
  taskKey: string | null;
}

export interface Workspace {
  root: string;
  path: string;
  missionKey: string;
  taskKey: string | null;
}

export interface WorkspaceHook {
  command: string;
  timeoutMs?: number | null;
  env?: Record<string, string>;
}

export type WorkspaceHookDefinition = string | WorkspaceHook;

export interface WorkspaceHookResult {
  command: string;
  cwd: string;
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

export interface EnsureWorkspaceOptions {
  onCreate?: WorkspaceHookDefinition;
}

export interface EnsureWorkspaceResult {
  workspace: Workspace;
  created: boolean;
  hook?: WorkspaceHookResult;
}

export interface CleanupWorkspaceOptions {
  beforeCleanup?: WorkspaceHookDefinition;
  removeOnHookFailure?: boolean;
}

export interface CleanupWorkspaceResult {
  workspace: Workspace;
  existed: boolean;
  removed: boolean;
  hook?: WorkspaceHookResult;
  skippedReason?: 'missing' | 'hookFailed';
}

interface NormalizedWorkspaceHook {
  command: string;
  timeoutMs: number | null;
  env?: Record<string, string>;
}

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 8);
}

function trimUnsafeEdges(input: string): string {
  return input.replace(/^[._\s-]+|[._\s-]+$/g, '');
}

function compactWorkspaceKey(raw: string, key: string): string {
  if (key.length <= MAX_WORKSPACE_KEY_LENGTH) return key;
  const suffix = hashKey(raw);
  const prefixLength = MAX_WORKSPACE_KEY_LENGTH - suffix.length - 1;
  const prefix = trimUnsafeEdges(key.slice(0, prefixLength));
  return `${prefix || 'workspace'}-${suffix}`;
}

export function sanitizeWorkspaceKey(raw: string, fallback = 'workspace'): string {
  const normalized = raw
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  let key = normalized
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-');
  key = trimUnsafeEdges(key);

  if (!key) {
    return sanitizeWorkspaceKey(fallback === raw ? 'workspace' : fallback, 'workspace');
  }

  if (WINDOWS_RESERVED_BASENAME.test(key)) {
    key = `${key.replace(/\./g, '-')}-workspace`;
  }

  return compactWorkspaceKey(raw, key);
}

export function workspaceKeys(ref: WorkspaceRef): WorkspaceKeys {
  return {
    missionKey: sanitizeWorkspaceKey(ref.missionId, 'mission'),
    taskKey: ref.taskId == null ? null : sanitizeWorkspaceKey(ref.taskId, 'task'),
  };
}

export function resolveWorkspaceRoot(root: string): string {
  if (!root.trim()) {
    throw new WorkspacePathError('workspace root is required');
  }
  return path.resolve(root);
}

export function assertPathInsideRoot(root: string, candidate: string): string {
  const resolvedRoot = resolveWorkspaceRoot(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new WorkspacePathError(
      `workspace path escapes root: ${resolvedCandidate} is not under ${resolvedRoot}`,
    );
  }
  return resolvedCandidate;
}

export function getWorkspace(root: string, ref: WorkspaceRef): Workspace {
  const resolvedRoot = resolveWorkspaceRoot(root);
  const keys = workspaceKeys(ref);
  const segments = keys.taskKey === null ? [keys.missionKey] : [keys.missionKey, keys.taskKey];
  const workspacePath = assertPathInsideRoot(resolvedRoot, path.join(resolvedRoot, ...segments));
  return {
    root: resolvedRoot,
    path: workspacePath,
    missionKey: keys.missionKey,
    taskKey: keys.taskKey,
  };
}

export function getWorkspacePath(root: string, ref: WorkspaceRef): string {
  return getWorkspace(root, ref).path;
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function validateExistingDirectory(target: string): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) {
    throw new WorkspacePathError(`workspace path cannot be a symlink: ${target}`);
  }
  if (!info.isDirectory()) {
    throw new WorkspacePathError(`workspace path is not a directory: ${target}`);
  }
}

async function ensureDirectory(target: string): Promise<boolean> {
  try {
    await validateExistingDirectory(target);
    return false;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  try {
    await mkdir(target);
    return true;
  } catch (err) {
    if (!isNotFound(err) && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      await validateExistingDirectory(target);
      return false;
    }
    throw err;
  }
}

async function ensureWorkspaceDirectories(workspace: Workspace): Promise<boolean> {
  await mkdir(workspace.root, { recursive: true });
  const segments =
    workspace.taskKey === null
      ? [workspace.missionKey]
      : [workspace.missionKey, workspace.taskKey];
  let current = workspace.root;
  let created = false;
  for (const segment of segments) {
    current = assertPathInsideRoot(workspace.root, path.join(current, segment));
    created = (await ensureDirectory(current)) || created;
  }
  return created;
}

async function workspaceExists(workspace: Workspace): Promise<boolean> {
  const segments =
    workspace.taskKey === null
      ? [workspace.missionKey]
      : [workspace.missionKey, workspace.taskKey];
  let current = workspace.root;
  for (const segment of segments) {
    current = assertPathInsideRoot(workspace.root, path.join(current, segment));
    try {
      await validateExistingDirectory(current);
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
  return true;
}

function normalizeHook(hook: WorkspaceHookDefinition): NormalizedWorkspaceHook {
  if (typeof hook === 'string') {
    return {
      command: hook.trim(),
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    };
  }
  return {
    command: hook.command.trim(),
    timeoutMs: hook.timeoutMs === undefined ? DEFAULT_HOOK_TIMEOUT_MS : hook.timeoutMs,
    ...(hook.env === undefined ? {} : { env: hook.env }),
  };
}

function hookFailureResult(
  command: string,
  cwd: string,
  startedAt: number,
  error: string,
): WorkspaceHookResult {
  return {
    command,
    cwd,
    ok: false,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: Date.now() - startedAt,
    error,
  };
}

function normalizeHookOutput(output: string): string {
  return normalizeLineEndings(stripBom(output));
}

export async function runWorkspaceHook(
  workspacePath: string,
  hook: WorkspaceHookDefinition,
): Promise<WorkspaceHookResult> {
  const cwd = path.resolve(workspacePath);
  const startedAt = Date.now();
  const normalized = normalizeHook(hook);

  if (!normalized.command) {
    return hookFailureResult(normalized.command, cwd, startedAt, 'workspace hook command is empty');
  }
  if (
    normalized.timeoutMs !== null &&
    (!Number.isFinite(normalized.timeoutMs) || normalized.timeoutMs <= 0)
  ) {
    return hookFailureResult(
      normalized.command,
      cwd,
      startedAt,
      'workspace hook timeout must be a positive number or null',
    );
  }

  try {
    await validateExistingDirectory(cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return hookFailureResult(normalized.command, cwd, startedAt, message);
  }

  return new Promise<WorkspaceHookResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const child = spawn(normalized.command, {
      cwd,
      env: normalized.env ? { ...process.env, ...normalized.env } : process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const settle = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      error?: string,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const result: WorkspaceHookResult = {
        command: normalized.command,
        cwd,
        ok: !timedOut && error === undefined && exitCode === 0,
        exitCode,
        signal,
        stdout: normalizeHookOutput(stdout),
        stderr: normalizeHookOutput(stderr),
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(error === undefined ? {} : { error }),
      };
      resolve(result);
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });

    child.on('error', (err) => {
      settle(null, null, err.message);
    });
    child.on('close', (code, signal) => {
      settle(code, signal);
    });

    if (normalized.timeoutMs !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          void killTree(child.pid, 'SIGKILL').catch(() => {
            child.kill('SIGKILL');
          });
        } else {
          child.kill('SIGKILL');
        }
      }, normalized.timeoutMs);
    }
  });
}

export async function ensureWorkspace(
  root: string,
  ref: WorkspaceRef,
  options: EnsureWorkspaceOptions = {},
): Promise<EnsureWorkspaceResult> {
  const workspace = getWorkspace(root, ref);
  const created = await ensureWorkspaceDirectories(workspace);
  const hook =
    created && options.onCreate ? await runWorkspaceHook(workspace.path, options.onCreate) : null;

  return {
    workspace,
    created,
    ...(hook === null ? {} : { hook }),
  };
}

export async function cleanupWorkspace(
  root: string,
  ref: WorkspaceRef,
  options: CleanupWorkspaceOptions = {},
): Promise<CleanupWorkspaceResult> {
  const workspace = getWorkspace(root, ref);
  const existed = await workspaceExists(workspace);
  if (!existed) {
    return {
      workspace,
      existed: false,
      removed: false,
      skippedReason: 'missing',
    };
  }

  const hook = options.beforeCleanup
    ? await runWorkspaceHook(workspace.path, options.beforeCleanup)
    : null;
  if (hook && !hook.ok && !options.removeOnHookFailure) {
    return {
      workspace,
      existed: true,
      removed: false,
      hook,
      skippedReason: 'hookFailed',
    };
  }

  await rm(workspace.path, { recursive: true, force: true });
  return {
    workspace,
    existed: true,
    removed: true,
    ...(hook === null ? {} : { hook }),
  };
}
