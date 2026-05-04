// client/app/catalog-defaults.ts
// Default agent catalog used as the initial value before the server's catalog
// loads, and as a fallback in lookups when a referenced persona/provider has
// been removed from the live catalog.

import type { AgentCatalog } from './api.types';

export const DEFAULT_AGENT_CATALOG: AgentCatalog = {
  providers: [
    { id: 'claude', displayName: 'Claude', summary: 'Claude Code provider adapter.' },
    { id: 'codex', displayName: 'Codex', summary: 'OpenAI Codex CLI provider adapter.' },
    { id: 'gemini', displayName: 'Gemini', summary: 'Gemini CLI provider adapter.' },
  ],
  personas: [
    {
      id: 'generalist',
      name: 'Generalist',
      category: 'default',
      summary: 'No special lens; collaborate normally across planning, execution, and review.',
      prompt: '',
    },
  ],
};
