import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import * as cp from 'node:child_process';
import { pickFile, pickFolder } from '../../src/folder-picker.js';

interface ExecFileResult {
  err?: NodeJS.ErrnoException | null;
  stdout?: string;
  stderr?: string;
}

interface RecordedCall {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv } & Record<string, unknown>;
}

const mockedExecFile = cp.execFile as unknown as ReturnType<typeof vi.fn>;

function queueExecFile(results: ExecFileResult[]): { calls: RecordedCall[] } {
  const recorded: RecordedCall[] = [];
  let i = 0;
  mockedExecFile.mockImplementation((command, args, options, cb) => {
    const callback = typeof options === 'function' ? options : cb;
    const opts = typeof options === 'function' ? {} : (options ?? {});
    recorded.push({ command, args, options: opts });
    const res = results[i++] ?? {};
    process.nextTick(() => {
      callback(res.err ?? null, res.stdout ?? '', res.stderr ?? '');
    });
    return { stdin: { end: () => {} } } as unknown as ReturnType<typeof cp.execFile>;
  });
  return { calls: recorded };
}

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  mockedExecFile.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

describe('pickFolder / pickFile — macOS branch', () => {
  beforeEach(() => setPlatform('darwin'));

  it('pickFolder shells out to osascript with a "choose folder" script', async () => {
    const { calls } = queueExecFile([{ stdout: '/Users/me/projects\n' }]);
    const result = await pickFolder();
    expect(result).toBe('/Users/me/projects');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('osascript');
    expect(calls[0]!.args[0]).toBe('-e');
    expect(calls[0]!.args[1]).toContain('choose folder');
  });

  it('pickFile shells out to osascript with a "choose file" script', async () => {
    const { calls } = queueExecFile([{ stdout: '/Users/me/file.txt\n' }]);
    const result = await pickFile();
    expect(result).toBe('/Users/me/file.txt');
    expect(calls[0]!.command).toBe('osascript');
    expect(calls[0]!.args[1]).toContain('choose file');
  });

  it('returns null when the AppleScript output is empty (user cancelled)', async () => {
    queueExecFile([{ stdout: '' }]);
    expect(await pickFolder()).toBeNull();
  });

  it('forwards initialPath via FIRESIDE_FOLDER_PICKER_INITIAL env var', async () => {
    const { calls } = queueExecFile([{ stdout: '' }]);
    await pickFolder({ initialPath: '/tmp/start' });
    expect(calls[0]!.options.env?.FIRESIDE_FOLDER_PICKER_INITIAL).toBe('/tmp/start');
  });

  it('forwards initialPath via FIRESIDE_FILE_PICKER_INITIAL env var for pickFile', async () => {
    const { calls } = queueExecFile([{ stdout: '' }]);
    await pickFile({ initialPath: '/tmp/seed.txt' });
    expect(calls[0]!.options.env?.FIRESIDE_FILE_PICKER_INITIAL).toBe('/tmp/seed.txt');
  });

  it('rejects when osascript fails for a real reason', async () => {
    queueExecFile([{ err: new Error('boom'), stderr: 'osascript exploded' }]);
    await expect(pickFolder()).rejects.toThrow(/osascript exploded/);
  });
});

describe('pickFolder / pickFile — Linux branch', () => {
  beforeEach(() => setPlatform('linux'));

  it('pickFolder calls zenity first with --directory', async () => {
    const { calls } = queueExecFile([{ stdout: '/home/me/projects\n' }]);
    const result = await pickFolder();
    expect(result).toBe('/home/me/projects');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('zenity');
    expect(calls[0]!.args).toContain('--directory');
  });

  it('falls back to kdialog when zenity is not installed', async () => {
    const enoent = Object.assign(new Error('not found'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException;
    const { calls } = queueExecFile([{ err: enoent }, { stdout: '/home/me/from-kdialog\n' }]);
    const result = await pickFolder();
    expect(result).toBe('/home/me/from-kdialog');
    expect(calls.map((c) => c.command)).toEqual(['zenity', 'kdialog']);
  });

  it('returns null when the user cancels zenity (non-zero exit, empty stderr)', async () => {
    queueExecFile([{ err: new Error('cancel'), stderr: '' }]);
    expect(await pickFolder()).toBeNull();
  });

  it('surfaces a real zenity error (non-empty stderr)', async () => {
    queueExecFile([{ err: new Error('boom'), stderr: 'zenity: display error' }]);
    await expect(pickFolder()).rejects.toThrow(/display error/);
  });

  it('throws a helpful error when no picker tool is installed', async () => {
    const enoent1 = Object.assign(new Error('zenity nf'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException;
    const enoent2 = Object.assign(new Error('kdialog nf'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException;
    queueExecFile([{ err: enoent1 }, { err: enoent2 }]);
    await expect(pickFolder()).rejects.toThrow(/zenity.*kdialog/);
  });

  it('pickFile calls zenity without --directory', async () => {
    const { calls } = queueExecFile([{ stdout: '/home/me/x.txt\n' }]);
    await pickFile();
    expect(calls[0]!.command).toBe('zenity');
    expect(calls[0]!.args).toContain('--file-selection');
    expect(calls[0]!.args).not.toContain('--directory');
  });
});

describe('pickFolder / pickFile — Windows branch (regression)', () => {
  beforeEach(() => setPlatform('win32'));

  it('pickFolder shells out to powershell.exe with a FolderBrowserDialog script', async () => {
    const { calls } = queueExecFile([{ stdout: 'C:\\Users\\Matt\\projects\n' }]);
    const result = await pickFolder();
    expect(result).toBe('C:\\Users\\Matt\\projects');
    expect(calls[0]!.command).toBe('powershell.exe');
    const script = calls[0]!.args[calls[0]!.args.length - 1];
    expect(script).toContain('FolderBrowserDialog');
  });

  it('pickFile shells out to powershell.exe with an OpenFileDialog script', async () => {
    const { calls } = queueExecFile([{ stdout: 'C:\\path\\file.txt\n' }]);
    const result = await pickFile();
    expect(result).toBe('C:\\path\\file.txt');
    expect(calls[0]!.command).toBe('powershell.exe');
    const script = calls[0]!.args[calls[0]!.args.length - 1];
    expect(script).toContain('OpenFileDialog');
  });
});
