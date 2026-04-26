// server/src/agents/registry.ts
import { claudeSpec } from './claude.js';
import { codexSpec } from './codex.js';
import { geminiSpec } from './gemini.js';
import { echoSpec } from './echo.js';
import type { AgentId, AgentSpec } from './types.js';

const REGISTRY: Record<AgentId, AgentSpec> = {
  claude: claudeSpec,
  codex: codexSpec,
  gemini: geminiSpec,
  echo: echoSpec,
};

export function getAgentSpec(id: AgentId): AgentSpec {
  const spec = REGISTRY[id];
  if (!spec) throw new Error(`unknown agent id: ${id}`);
  return spec;
}

export function listAgentSpecs(): AgentSpec[] {
  return Object.values(REGISTRY);
}
