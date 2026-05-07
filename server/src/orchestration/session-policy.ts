import type { AgentId, RoomAgentProfile, SessionPolicy } from '../agents/types.js';

export const SESSION_POLICY_VALUES: readonly SessionPolicy[] = [
  'persistent',
  'compacting',
  'ephemeral',
  'reset-after-lane',
] as const;

export interface ResolveSessionPolicyInput {
  profile: RoomAgentProfile | undefined;
  roomLeadAgentId?: AgentId | null;
  globalResumeCliSessions: boolean;
}

export function resolveSessionPolicy(input: ResolveSessionPolicyInput): SessionPolicy {
  if (!input.globalResumeCliSessions) return 'ephemeral';
  if (input.profile?.sessionPolicy) return input.profile.sessionPolicy;
  if (input.profile?.temporary) return 'ephemeral';
  // Role-default: only the room lead keeps a resumable session by default.
  // Non-lead workers (and synthetic agents with no profile) default to ephemeral
  // so they don't accumulate provider amplifier across turns. Explicit per-profile
  // sessionPolicy overrides above still win.
  const isLead =
    input.profile?.id != null &&
    input.roomLeadAgentId != null &&
    input.profile.id === input.roomLeadAgentId;
  return isLead ? 'compacting' : 'ephemeral';
}

export function policyAllowsSessionResume(policy: SessionPolicy): boolean {
  return policy !== 'ephemeral';
}

export function policyEnablesAutoCompaction(policy: SessionPolicy): boolean {
  return policy === 'compacting';
}

export function policyClearsSessionAfterLane(policy: SessionPolicy): boolean {
  return policy === 'reset-after-lane';
}

export function isSessionPolicy(value: unknown): value is SessionPolicy {
  return (
    typeof value === 'string' && (SESSION_POLICY_VALUES as readonly string[]).includes(value)
  );
}
