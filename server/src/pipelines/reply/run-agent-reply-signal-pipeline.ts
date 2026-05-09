import { runPipeline } from '../core/pipeline.js';
import { createAgentReplySignalContext } from './create-agent-reply-signal-context.js';
import { extractAgentRosterStep } from './steps/extract-agent-roster.js';
import { extractCollaborationNotesStep } from './steps/extract-collaboration-notes.js';
import { extractMissionCreatesStep } from './steps/extract-mission-creates.js';
import { extractMissionPhasesStep } from './steps/extract-mission-phases.js';
import { extractMissionPlansStep } from './steps/extract-mission-plans.js';
import { extractMissionReceiptsStep } from './steps/extract-mission-receipts.js';
import { extractMissionTasksStep } from './steps/extract-mission-tasks.js';
import { extractPermissionRequestStep } from './steps/extract-permission-request.js';
import { normalizeFiresideEnvelopesStep } from './steps/normalize-fireside-envelopes.js';
import { stripFiresideToolEnvelopesStep } from './steps/strip-fireside-tool-envelopes.js';
import type {
  AgentReplySignalPipelineContext,
  AgentReplySignalPipelineInput,
} from './types.js';

export const AGENT_REPLY_SIGNAL_PIPELINE_STEPS = [
  stripFiresideToolEnvelopesStep,
  normalizeFiresideEnvelopesStep,
  extractMissionCreatesStep,
  extractMissionPlansStep,
  extractMissionPhasesStep,
  extractMissionTasksStep,
  extractAgentRosterStep,
  extractMissionReceiptsStep,
  extractPermissionRequestStep,
  extractCollaborationNotesStep,
] as const;

export function runAgentReplySignalPipeline(
  input: AgentReplySignalPipelineInput,
): AgentReplySignalPipelineContext {
  return runPipeline(createAgentReplySignalContext(input), AGENT_REPLY_SIGNAL_PIPELINE_STEPS);
}
