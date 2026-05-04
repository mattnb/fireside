import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAgentSpecs } from '../../src/agents/registry.js';
import {
  replayAgentReplyEffects,
  replayProviderOutput,
} from '../../src/simulation/run-replay.js';
import type { ProviderId } from '../../src/agents/types.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

function spec(id: Exclude<ProviderId, 'echo'>) {
  const found = listAgentSpecs().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing spec ${id}`);
  return found;
}

describe('run replay harness', () => {
  it('replays provider stdout through parser and normalized event contract', () => {
    const stdout = readFileSync(path.join(FIXTURE_DIR, 'codex-exec-jsonl.txt'), 'utf8');
    const replay = replayProviderOutput({
      provider: 'codex',
      spec: spec('codex'),
      stdout,
      sessionId: 'fixture-codex-thread',
    });

    expect(replay).toMatchObject({ ok: true });
    if (!replay.ok) throw new Error(replay.error);
    expect(replay.reply.text).toBe('pong');
    expect(replay.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['assistant_message', 'context_usage']),
    );
  });

  it('replays hidden mission blocks without mutating database state', () => {
    const replay = replayAgentReplyEffects({
      agentId: 'claude',
      text: [
        'Implementation complete.',
        '',
        '<!-- /mission-task',
        'action: update',
        'id: item-1',
        'status: done',
        'note: Verified with tests.',
        '/end-mission-task -->',
        '',
        '/mission-receipt',
        'status: continuing',
        'summary: moving to verification',
        '/end-mission-receipt',
      ].join('\n'),
    });

    expect(replay).toMatchObject({
      visibleText: 'Implementation complete.',
      missionTasks: 1,
      missionReceipts: 1,
      permissionRequested: false,
    });
  });
});
