import { runPipeline } from '../core/pipeline.js';
import { createAgentReplySignalContext } from './create-agent-reply-signal-context.js';
import { normalizeFiresideEnvelopesStep } from './steps/normalize-fireside-envelopes.js';
import { stripFiresideToolEnvelopesStep } from './steps/strip-fireside-tool-envelopes.js';
import type {
  AgentReplySignalPipelineContext,
  AgentReplySignalPipelineInput,
} from './types.js';

// Phase 2 (2026-05-09): MCP is the canonical and only mission/collab/
// permission tool entry point. The historical /mission-*, /collab-note,
// /permission-request slash-block extractors used to sit here, parsing
// hidden envelopes out of agent replies and routing them through the
// tool engine via slash-block-adapter.ts. They've been removed —
// agents that emit slash blocks now see them appear as inert chat text
// (the two sanitizer steps below still strip leaked tool-envelope
// markup so the chat surface stays clean).
export const AGENT_REPLY_SIGNAL_PIPELINE_STEPS = [
  stripFiresideToolEnvelopesStep,
  normalizeFiresideEnvelopesStep,
] as const;

export function runAgentReplySignalPipeline(
  input: AgentReplySignalPipelineInput,
): AgentReplySignalPipelineContext {
  return runPipeline(createAgentReplySignalContext(input), AGENT_REPLY_SIGNAL_PIPELINE_STEPS);
}
