import { describe, expect, it } from 'vitest';
import { LeadResetScheduler } from '../../src/orchestration/lead-reset-scheduler.js';

describe('LeadResetScheduler', () => {
  it('marks and consumes a pending reset exactly once per (room, agent) pair', () => {
    const scheduler = new LeadResetScheduler();
    expect(scheduler.hasPendingReset('room-1', 'lead-a')).toBe(false);

    scheduler.markPendingReset('room-1', 'lead-a', { reason: 'phase boundary' });
    expect(scheduler.hasPendingReset('room-1', 'lead-a')).toBe(true);

    const consumed = scheduler.consumePendingReset('room-1', 'lead-a');
    expect(consumed).toMatchObject({ reason: 'phase boundary' });
    expect(scheduler.hasPendingReset('room-1', 'lead-a')).toBe(false);
    expect(scheduler.consumePendingReset('room-1', 'lead-a')).toBeNull();
  });

  it('keeps marks separated by room and by agent', () => {
    const scheduler = new LeadResetScheduler();
    scheduler.markPendingReset('room-1', 'lead-a', { reason: 'phase boundary' });
    scheduler.markPendingReset('room-2', 'lead-a', { reason: 'threshold cross' });
    scheduler.markPendingReset('room-1', 'lead-b', { reason: 'manual' });

    expect(scheduler.hasPendingReset('room-1', 'lead-a')).toBe(true);
    expect(scheduler.hasPendingReset('room-1', 'lead-b')).toBe(true);
    expect(scheduler.hasPendingReset('room-2', 'lead-a')).toBe(true);
    expect(scheduler.hasPendingReset('room-2', 'lead-b')).toBe(false);

    expect(scheduler.consumePendingReset('room-1', 'lead-a')?.reason).toBe('phase boundary');
    expect(scheduler.hasPendingReset('room-1', 'lead-b')).toBe(true);
    expect(scheduler.hasPendingReset('room-2', 'lead-a')).toBe(true);
  });

  it('treats double-mark as idempotent and keeps the most recent reason', () => {
    const scheduler = new LeadResetScheduler();
    scheduler.markPendingReset('room-1', 'lead-a', { reason: 'phase boundary' });
    scheduler.markPendingReset('room-1', 'lead-a', { reason: 'threshold cross' });

    expect(scheduler.hasPendingReset('room-1', 'lead-a')).toBe(true);
    expect(scheduler.consumePendingReset('room-1', 'lead-a')?.reason).toBe('threshold cross');
  });

  it('clearAll removes every pending reset', () => {
    const scheduler = new LeadResetScheduler();
    scheduler.markPendingReset('room-1', 'lead-a', { reason: 'a' });
    scheduler.markPendingReset('room-2', 'lead-b', { reason: 'b' });
    scheduler.clearAll();
    expect(scheduler.hasPendingReset('room-1', 'lead-a')).toBe(false);
    expect(scheduler.hasPendingReset('room-2', 'lead-b')).toBe(false);
  });
});
