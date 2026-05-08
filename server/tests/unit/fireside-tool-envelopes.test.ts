import { describe, expect, it } from 'vitest';
import { stripFiresideToolEnvelopes } from '../../src/fireside-tool-envelopes.js';

describe('stripFiresideToolEnvelopes', () => {
  it('removes a canonical fireside-tool envelope and reports the count', () => {
    const input = [
      'Heads up: receipt below.',
      '',
      '<!-- fireside-tool',
      'tool: mission.task.update',
      'args:',
      '  taskId: abc',
      '  status: done',
      '  note: Verified.',
      '/fireside-tool -->',
    ].join('\n');

    const result = stripFiresideToolEnvelopes(input);
    expect(result.count).toBe(1);
    expect(result.visibleText).toBe('Heads up: receipt below.');
  });

  it('also strips the malformed /end-fireside-tool close marker as defense in depth', () => {
    const input = [
      'Status update.',
      '',
      '<!-- fireside-tool',
      'tool: mission.receipt.submit',
      'args:',
      '  status: continuing',
      '/end-fireside-tool -->',
    ].join('\n');

    const result = stripFiresideToolEnvelopes(input);
    expect(result.count).toBe(1);
    expect(result.visibleText).toBe('Status update.');
  });

  it('strips multiple envelopes in one message', () => {
    const input = [
      'Reply prose.',
      '',
      '<!-- fireside-tool',
      'tool: mission.task.update',
      'args:',
      '  taskId: a',
      '  status: done',
      '/fireside-tool -->',
      '',
      '<!-- fireside-tool',
      'tool: mission.task.update',
      'args:',
      '  taskId: b',
      '  status: done',
      '/fireside-tool -->',
    ].join('\n');

    const result = stripFiresideToolEnvelopes(input);
    expect(result.count).toBe(2);
    expect(result.visibleText).toBe('Reply prose.');
  });

  it('leaves text without envelopes unchanged and reports a zero count', () => {
    const input = 'Nothing to strip here. /mission-receipt blocks are handled elsewhere.';
    const result = stripFiresideToolEnvelopes(input);
    expect(result.count).toBe(0);
    expect(result.visibleText).toBe(input);
  });

  it('does not match a stray /fireside-tool close without an opening envelope', () => {
    const input = 'A loose /fireside-tool --> token in prose should not be touched.';
    const result = stripFiresideToolEnvelopes(input);
    expect(result.count).toBe(0);
    expect(result.visibleText).toBe(input);
  });
});
