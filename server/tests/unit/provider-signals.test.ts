import { describe, expect, it } from 'vitest';
import {
  isVisibleProviderSignal,
  readableProviderSignalDetail,
} from '../../src/provider-signals.js';

describe('provider signal visibility', () => {
  it('suppresses low-signal provider lifecycle events', () => {
    expect(isVisibleProviderSignal({ label: 'claude message_start' })).toBe(false);
    expect(isVisibleProviderSignal({ label: 'claude content_block_start' })).toBe(false);
    expect(isVisibleProviderSignal({ label: 'codex thread started', detail: 'fixture-codex-thread' })).toBe(false);
    expect(isVisibleProviderSignal({ label: 'claude tool_use', detail: 'Edit' })).toBe(false);
  });

  it('keeps assistant-ready events with readable text', () => {
    expect(
      isVisibleProviderSignal({
        label: 'codex assistant message ready',
        detail: '{"message":"Thanks for flagging this; I am checking the failure path now."}',
      }),
    ).toBe(true);
    expect(
      readableProviderSignalDetail(
        '{"message":"Thanks for flagging this; I am checking the failure path now."}',
      ),
    ).toBe('Thanks for flagging this; I am checking the failure path now.');
  });

  it('keeps non-noisy broker and usage events', () => {
    expect(isVisibleProviderSignal({ label: 'agent process started' })).toBe(true);
    expect(isVisibleProviderSignal({ label: 'claude result received', detail: '100K/1M tokens' })).toBe(true);
  });
});
