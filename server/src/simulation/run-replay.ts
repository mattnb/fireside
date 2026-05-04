import type { AgentReply, AgentSpec, AgentStreamName, ProviderId } from '../agents/types.js';
import {
  normalizeProviderStreamEvents,
  type ProviderContractEvent,
} from '../agents/provider-events.js';
import { extractAgentRosterUpdates } from '../agent-roster-updates.js';
import { extractCollaborationNotes } from '../collaboration-notes.js';
import { extractDraftArtifacts } from '../draft-artifacts.js';
import { extractMissionCreateUpdates } from '../mission-create-updates.js';
import { extractMissionPhaseUpdates } from '../mission-phase-updates.js';
import { extractMissionPlanUpdates } from '../mission-plan-updates.js';
import { extractMissionReceipts } from '../mission-receipts.js';
import { extractMissionTaskUpdates } from '../mission-task-updates.js';
import { extractPermissionRequest } from '../permissions.js';

export interface ReplayProviderOutputInput {
  provider: Exclude<ProviderId, 'echo'>;
  spec: AgentSpec;
  stdout: string;
  stderr?: string;
  sessionId?: string | null;
}

export type ReplayProviderOutputResult =
  | {
      ok: true;
      reply: AgentReply;
      events: ProviderContractEvent[];
    }
  | {
      ok: false;
      error: string;
      stdout: string;
      stderr: string;
      events: ProviderContractEvent[];
    };

export interface ReplayAgentReplyEffectsInput {
  agentId: string;
  text: string;
}

export interface ReplayAgentReplyEffects {
  visibleText: string;
  draftArtifacts: number;
  missionCreates: number;
  missionPlans: number;
  missionPhases: number;
  missionTasks: number;
  agentRosterUpdates: number;
  missionReceipts: number;
  permissionRequested: boolean;
  collaborationNotes: number;
}

export function replayProviderOutput(
  input: ReplayProviderOutputInput,
): ReplayProviderOutputResult {
  const stderr = input.stderr ?? '';
  const events = [
    ...collectProviderEvents(input, input.stdout, 'stdout'),
    ...collectProviderEvents(input, stderr, 'stderr'),
  ];
  try {
    return {
      ok: true,
      reply: input.spec.parseOutput(input.stdout, stderr),
      events,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stdout: input.stdout,
      stderr,
      events,
    };
  }
}

export function replayAgentReplyEffects(
  input: ReplayAgentReplyEffectsInput,
): ReplayAgentReplyEffects {
  const drafts = extractDraftArtifacts(input.text);
  const creates = extractMissionCreateUpdates(drafts.visibleText);
  const plans = extractMissionPlanUpdates(creates.visibleText);
  const phases = extractMissionPhaseUpdates(plans.visibleText);
  const tasks = extractMissionTaskUpdates(phases.visibleText);
  const roster = extractAgentRosterUpdates(tasks.visibleText);
  const receipts = extractMissionReceipts(roster.visibleText);
  const permission = extractPermissionRequest(receipts.visibleText, input.agentId);
  const afterPermission = permission?.visibleText ?? receipts.visibleText;
  const collaboration = extractCollaborationNotes(afterPermission);

  return {
    visibleText: collaboration.visibleText.trim(),
    draftArtifacts: drafts.drafts.length,
    missionCreates: creates.updates.length,
    missionPlans: plans.updates.length,
    missionPhases: phases.updates.length,
    missionTasks: tasks.updates.length,
    agentRosterUpdates: roster.updates.length,
    missionReceipts: receipts.receipts.length,
    permissionRequested: Boolean(permission),
    collaborationNotes: collaboration.notes.length,
  };
}

function collectProviderEvents(
  input: ReplayProviderOutputInput,
  text: string,
  stream: AgentStreamName,
): ProviderContractEvent[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => input.spec.parseStreamLine?.(line, stream, input.sessionId ?? null) ?? [])
    .flatMap((event) => normalizeProviderStreamEvents(input.provider, [event]));
}
