import { agentTools } from './handlers/agent-tools.js';
import { collabTools } from './handlers/collab-tools.js';
import { missionPhaseTools } from './handlers/mission-phase-tools.js';
import { missionPlanTools } from './handlers/mission-plan-tools.js';
import { missionReceiptTools } from './handlers/mission-receipt-tools.js';
import { missionTaskTools } from './handlers/mission-task-tools.js';
import { permissionRequestTool } from './handlers/permission-tools.js';
import { searchToolsTool } from './handlers/search-tools.js';
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
  ...missionReceiptTools,
  ...collabTools,
  permissionRequestTool,
  searchToolsTool,
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
