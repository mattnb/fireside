import type { AgentId } from '../agents/types.js';

export interface PendingLeadReset {
  reason: string;
  markedAt: number;
}

function key(roomId: string, agentId: AgentId): string {
  return `${roomId}::${agentId}`;
}

/**
 * In-memory scheduler for deterministic lead-session resets. Each
 * (roomId, agentId) pair carries at most one pending reset; the next dispatch
 * for that pair consumes it. Survives only the lifetime of the broker process —
 * a restart loses pending resets, which is acceptable because the next phase
 * advance or threshold cross will re-arm.
 */
export class LeadResetScheduler {
  private readonly pending = new Map<string, PendingLeadReset>();

  markPendingReset(
    roomId: string,
    agentId: AgentId,
    options: { reason: string } = { reason: 'unspecified' },
  ): void {
    this.pending.set(key(roomId, agentId), {
      reason: options.reason,
      markedAt: Date.now(),
    });
  }

  hasPendingReset(roomId: string, agentId: AgentId): boolean {
    return this.pending.has(key(roomId, agentId));
  }

  consumePendingReset(roomId: string, agentId: AgentId): PendingLeadReset | null {
    const k = key(roomId, agentId);
    const entry = this.pending.get(k);
    if (!entry) return null;
    this.pending.delete(k);
    return entry;
  }

  clearAll(): void {
    this.pending.clear();
  }
}
