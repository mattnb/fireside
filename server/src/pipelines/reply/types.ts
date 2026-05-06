import type { AgentId } from '../../agents/types.js';
import type { ExtractedAgentRosterUpdates } from '../../agent-roster-updates.js';
import type { ExtractedCollaborationNotes } from '../../collaboration-notes.js';
import type { ExtractedMissionCreateUpdates } from '../../mission-create-updates.js';
import type { ExtractedMissionPhaseUpdates } from '../../mission-phase-updates.js';
import type { ExtractedMissionPlanUpdates } from '../../mission-plan-updates.js';
import type { ExtractedMissionReceipts } from '../../mission-receipts.js';
import type { ExtractedMissionTaskUpdates } from '../../mission-task-updates.js';
import type { ExtractedPermissionRequest } from '../../permissions.js';

export interface AgentReplySignalPipelineInput {
  agentId: AgentId;
  text: string;
}

export interface AgentReplySignalPipelineContext {
  agentId: AgentId;
  originalText: string;
  visibleText: string;
  textAfterMissionReceipts: string;
  missionCreates: ExtractedMissionCreateUpdates;
  missionPlans: ExtractedMissionPlanUpdates;
  missionPhases: ExtractedMissionPhaseUpdates;
  missionTasks: ExtractedMissionTaskUpdates;
  agentRoster: ExtractedAgentRosterUpdates;
  missionReceipts: ExtractedMissionReceipts;
  permission: ExtractedPermissionRequest | null;
  collaboration: ExtractedCollaborationNotes;
}
