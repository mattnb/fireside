import { agentTools } from './handlers/agent-tools.js';
import { collabTools } from './handlers/collab-tools.js';
import { missionAcceptanceTools } from './handlers/mission-acceptance-tools.js';
import { missionApproveTools } from './handlers/mission-approve-tools.js';
import { missionClarifyTools } from './handlers/mission-clarify-tools.js';
import { missionPhaseTools } from './handlers/mission-phase-tools.js';
import { missionPlanTools } from './handlers/mission-plan-tools.js';
import { missionProposeTools } from './handlers/mission-propose-tools.js';
import { missionReceiptTools } from './handlers/mission-receipt-tools.js';
import { missionTaskTools } from './handlers/mission-task-tools.js';
import { missionTaskSetVerifierTools } from './handlers/mission-task-set-verifier-tools.js';
import { missionVerifyTools } from './handlers/mission-verify-tools.js';
import { permissionRequestTool } from './handlers/permission-tools.js';
import { searchToolsTool } from './handlers/search-tools.js';
import { searchUniversalTools } from './handlers/search-universal-tools.js';
import { defaultToolRegistry } from './registry.js';
import type { AgentToolDefinition } from './types.js';

// Agent tool definitions are heterogeneous by args type; the registry preserves
// each handler's concrete type at definition time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RegisteredToolDefinition = AgentToolDefinition<any>;

const DEFAULT_TOOLS: readonly RegisteredToolDefinition[] = [
  ...agentTools,
  ...missionPlanTools,
  ...missionPhaseTools,
  ...missionTaskTools,
  ...missionTaskSetVerifierTools,
  ...missionReceiptTools,
  ...missionClarifyTools,
  ...missionAcceptanceTools,
  ...missionProposeTools,
  ...missionVerifyTools,
  ...missionApproveTools,
  ...collabTools,
  permissionRequestTool,
  searchToolsTool,
  ...searchUniversalTools,
];

let registered = false;

export function ensureDefaultToolsRegistered(): void {
  if (registered) return;
  for (const tool of DEFAULT_TOOLS) {
    if (!defaultToolRegistry.has(tool.name)) {
      defaultToolRegistry.register(tool);
    }
  }
  registered = true;
}
