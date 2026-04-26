// server/tests/unit/tree-kill.test.ts
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { killTree, isPidAlive } from '../../src/windows/tree-kill.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const FIXTURE = path.resolve(path.dirname(__filename), '../fixtures/parent-with-child.cjs');

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('killTree', () => {
  it('terminates parent and child processes on Windows', async () => {
    const proc = execa(process.execPath, [FIXTURE], {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    proc.catch(() => {}); // attach immediately so kill-induced rejection is handled
    let firstLine = '';
    await new Promise<void>((resolve) => {
      proc.stdout!.on('data', (b: Buffer) => {
        firstLine += b.toString('utf8');
        if (firstLine.includes('\n')) resolve();
      });
    });
    const { parent, child } = JSON.parse(firstLine.split('\n')[0]!);
    expect(parent).toBeGreaterThan(0);
    expect(child).toBeGreaterThan(0);

    await killTree(parent);
    await delay(500);

    expect(await isPidAlive(parent)).toBe(false);
    expect(await isPidAlive(child)).toBe(false);
  }, 20_000);

  it('isPidAlive returns false for a non-existent pid', async () => {
    expect(await isPidAlive(0)).toBe(false);
    expect(await isPidAlive(999_999_999)).toBe(false);
  });
});
