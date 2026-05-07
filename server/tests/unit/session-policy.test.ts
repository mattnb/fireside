import { describe, expect, it } from 'vitest';
import type { RoomAgentProfile } from '../../src/agents/types.js';
import {
  isSessionPolicy,
  policyAllowsSessionResume,
  policyClearsSessionAfterLane,
  policyEnablesAutoCompaction,
  resolveSessionPolicy,
  SESSION_POLICY_VALUES,
} from '../../src/orchestration/session-policy.js';

function profile(overrides: Partial<RoomAgentProfile> = {}): RoomAgentProfile {
  return {
    id: 'codex-worker',
    providerId: 'codex',
    displayName: 'Codex',
    personaId: 'generalist',
    personaName: 'Generalist',
    personaSummary: '',
    ...overrides,
  };
}

describe('resolveSessionPolicy', () => {
  it('forces ephemeral when global resume kill-switch is off', () => {
    expect(
      resolveSessionPolicy({
        profile: profile({ sessionPolicy: 'persistent' }),
        roomLeadAgentId: 'codex-worker',
        globalResumeCliSessions: false,
      }),
    ).toBe('ephemeral');
  });

  it('honors the explicit per-profile sessionPolicy when global gate is on', () => {
    expect(
      resolveSessionPolicy({
        profile: profile({ sessionPolicy: 'reset-after-lane' }),
        globalResumeCliSessions: true,
      }),
    ).toBe('reset-after-lane');
  });

  it('forces temporary agents to ephemeral even without an explicit policy', () => {
    expect(
      resolveSessionPolicy({
        profile: profile({ temporary: true }),
        globalResumeCliSessions: true,
      }),
    ).toBe('ephemeral');
  });

  it('still honors an explicit policy on a temporary agent', () => {
    expect(
      resolveSessionPolicy({
        profile: profile({ temporary: true, sessionPolicy: 'persistent' }),
        globalResumeCliSessions: true,
      }),
    ).toBe('persistent');
  });

  it('defaults to ephemeral for a non-lead agent when no explicit policy and not temporary', () => {
    expect(
      resolveSessionPolicy({
        profile: profile({ id: 'codex-worker' }),
        roomLeadAgentId: 'claude-principal-software',
        globalResumeCliSessions: true,
      }),
    ).toBe('ephemeral');
  });

  it('defaults to ephemeral when no roomLeadAgentId is supplied (non-lead by absence)', () => {
    expect(
      resolveSessionPolicy({
        profile: profile(),
        globalResumeCliSessions: true,
      }),
    ).toBe('ephemeral');
  });

  it('defaults to compacting for the lead agent when no explicit policy and not temporary', () => {
    expect(
      resolveSessionPolicy({
        profile: profile({ id: 'claude-principal-software' }),
        roomLeadAgentId: 'claude-principal-software',
        globalResumeCliSessions: true,
      }),
    ).toBe('compacting');
  });

  it('still respects an explicit policy on the lead', () => {
    expect(
      resolveSessionPolicy({
        profile: profile({ id: 'claude-principal-software', sessionPolicy: 'persistent' }),
        roomLeadAgentId: 'claude-principal-software',
        globalResumeCliSessions: true,
      }),
    ).toBe('persistent');
  });

  it('still respects an explicit policy on a non-lead worker', () => {
    expect(
      resolveSessionPolicy({
        profile: profile({ id: 'codex-worker', sessionPolicy: 'reset-after-lane' }),
        roomLeadAgentId: 'claude-principal-software',
        globalResumeCliSessions: true,
      }),
    ).toBe('reset-after-lane');
  });

  it('defaults to ephemeral when no profile is supplied (echo / synthetic agents)', () => {
    expect(
      resolveSessionPolicy({
        profile: undefined,
        globalResumeCliSessions: true,
      }),
    ).toBe('ephemeral');
  });
});

describe('policy predicates', () => {
  it('treats every non-ephemeral policy as resumable', () => {
    expect(policyAllowsSessionResume('persistent')).toBe(true);
    expect(policyAllowsSessionResume('compacting')).toBe(true);
    expect(policyAllowsSessionResume('reset-after-lane')).toBe(true);
    expect(policyAllowsSessionResume('ephemeral')).toBe(false);
  });

  it('only enables auto-compaction for the compacting policy', () => {
    expect(policyEnablesAutoCompaction('compacting')).toBe(true);
    expect(policyEnablesAutoCompaction('persistent')).toBe(false);
    expect(policyEnablesAutoCompaction('reset-after-lane')).toBe(false);
    expect(policyEnablesAutoCompaction('ephemeral')).toBe(false);
  });

  it('only flags reset-after-lane for the lane-completion hook', () => {
    expect(policyClearsSessionAfterLane('reset-after-lane')).toBe(true);
    expect(policyClearsSessionAfterLane('compacting')).toBe(false);
    expect(policyClearsSessionAfterLane('persistent')).toBe(false);
    expect(policyClearsSessionAfterLane('ephemeral')).toBe(false);
  });
});

describe('isSessionPolicy', () => {
  it('accepts every legal policy value', () => {
    for (const value of SESSION_POLICY_VALUES) {
      expect(isSessionPolicy(value)).toBe(true);
    }
  });

  it('rejects garbage values from external input', () => {
    expect(isSessionPolicy('persistant')).toBe(false);
    expect(isSessionPolicy('')).toBe(false);
    expect(isSessionPolicy(null)).toBe(false);
    expect(isSessionPolicy(undefined)).toBe(false);
    expect(isSessionPolicy(42)).toBe(false);
  });
});
