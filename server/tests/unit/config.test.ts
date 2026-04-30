// server/tests/unit/config.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDotEnvFile } from '../../src/config.js';

const ENV_KEYS = ['FIRESIDE_PORT', 'FIRESIDE_HOST', 'FIRESIDE_DATA_DIR', 'FIRESIDE_TEST_QUOTED'];

describe('loadDotEnvFile', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('loads simple .env files without overriding existing process env values', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fireside-env-test-'));
    const file = path.join(dir, '.env');
    process.env.FIRESIDE_PORT = '9000';
    writeFileSync(
      file,
      [
        '# local config',
        'FIRESIDE_PORT=8787',
        'FIRESIDE_HOST=0.0.0.0',
        'FIRESIDE_DATA_DIR=./runtime-data # inline comment',
        'FIRESIDE_TEST_QUOTED="quoted value"',
      ].join('\n'),
      'utf8',
    );

    loadDotEnvFile(file);

    expect(process.env.FIRESIDE_PORT).toBe('9000');
    expect(process.env.FIRESIDE_HOST).toBe('0.0.0.0');
    expect(process.env.FIRESIDE_DATA_DIR).toBe('./runtime-data');
    expect(process.env.FIRESIDE_TEST_QUOTED).toBe('quoted value');
  });
});
