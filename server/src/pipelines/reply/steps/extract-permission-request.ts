import type { PipelineStep } from '../../core/pipeline.js';
import { extractPermissionRequest } from '../../../permissions.js';
import type { AgentReplySignalPipelineContext } from '../types.js';

export const extractPermissionRequestStep: PipelineStep<AgentReplySignalPipelineContext> = {
  name: 'reply.extract-permission-request',
  run(context) {
    const permission = extractPermissionRequest(context.visibleText, context.agentId);
    if (!permission) return context;
    return {
      ...context,
      permission,
      visibleText: permission.visibleText,
    };
  },
};
