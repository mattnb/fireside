// Canonical Fireside protocol manifest.
//
// This file is written to `data/agent-context/<room>/protocols.md`. Keep it
// compact: full tool argument references are retrieved through `search.tools`
// instead of being repeated in every turn prompt.

import {
  TOOL_SCHEMA_REFERENCES,
  ensureSearchToolsRegistered,
} from './tools/handlers/search-tools.js';

ensureSearchToolsRegistered();

export const PROTOCOLS_DOCUMENT_VERSION = 4;

export const COMPACT_TOOL_MANIFEST_PROMPT =
  'Fireside is registered as an MCP server in your CLI ("fireside"). Call its structured tools — mission.task.update, mission.receipt.submit, collab.note.add, permission.request, agent.set_status, mission.phase.* and mission.plan.* — for every mission-state, evidence, permission, or coordination update. Visible chat is for human/team communication only. Never type tool calls as text in chat; only invoke them through the MCP transport. Use search.tools for full argument references.';

const PRIMARY_TOOL_NAMES = TOOL_SCHEMA_REFERENCES.map((tool) => tool.name).join(', ');

export const TOOL_MANIFEST_MARKDOWN = `# Fireside Structured Tool Manifest

All mission-state, collaboration, permission, and coordination work goes through the **fireside MCP server** that Fireside auto-registers in your CLI at startup. The server is reachable over loopback at \`http://127.0.0.1:<port>/api/mcp\`; you do not need to configure it.

Visible chat is for human/team communication only. **Do not write tool calls as text in chat.** Pseudo-syntax like \`/mission-task action: update id: abc status: done\` is no longer parsed and will not produce any state effect — emit the call through your CLI's MCP tool-use mechanism instead.

Use the corresponding fireside tool when you complete, block, assign, reopen, request permission, or record durable collaboration notes. The live tool catalog is:

${TOOL_SCHEMA_REFERENCES.map(
  (tool) =>
    `- ${tool.name}: ${tool.summary} Required state permission: ${tool.requiredPermissions.join(', ') || 'none'}.`,
).join('\n')}

Retrieve detailed argument references on demand by calling the \`search.tools\` MCP tool, e.g. \`search.tools({ namespace: 'mission.task', includeSchemas: true })\`.
`;

export const PROTOCOLS_MARKDOWN = `# Fireside Protocols

This context file is the compact manifest for Fireside's structured tool layer.
Tool calls are exclusively MCP-routed; the legacy slash-block text adapter is
deprecated and ignored. Call \`search.tools\` for detailed argument references
on demand.

${TOOL_MANIFEST_MARKDOWN}

## Operating Rules

- Mission state lives in Mission Control, not visible chat. Update it through MCP tool calls only.
- Call exactly one fireside tool per concrete state change. Bundle related fields into a single argument object rather than emitting multiple partial calls.
- Include completion evidence in the tool's \`note\`, \`body\`, \`evidence\`, or equivalent argument.
- Include \`blockedReason\` plus \`councilRequired\` when team or human council is required.
- Use exact room @handles in visible chat when assigning another agent to act.
- Pseudo-tool text in chat (\`/mission-task\`, \`<!-- fireside-tool -->\`, etc.) produces no state effect and will be stripped from history when re-rendered to other agents. If you cannot reach the fireside MCP server, surface that as a visible blocker — do not type the call as prose.

## Tool Retrieval

The prompt-visible catalog currently contains ${TOOL_SCHEMA_REFERENCES.length} tools:

\`\`\`text
${PRIMARY_TOOL_NAMES}
\`\`\`

Call \`search.tools\` with \`query\`, \`namespace\`, or \`names\` to retrieve the full schema reference for only the tools you need.
`;
