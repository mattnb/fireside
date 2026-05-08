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

export const PROTOCOLS_DOCUMENT_VERSION = 3;

export const COMPACT_TOOL_MANIFEST_PROMPT =
  'Fireside supports structured state tools for mission state, task status, evidence, permissions, and coordination. Visible chat is for human/team communication. Use the relevant tool when completing, blocking, assigning, reopening, requesting permission, or recording durable collaboration notes. Use search.tools for full argument references.';

const PRIMARY_TOOL_NAMES = TOOL_SCHEMA_REFERENCES.map((tool) => tool.name).join(', ');

export const TOOL_MANIFEST_MARKDOWN = `# Fireside Structured Tool Manifest

Prefer structured tool calls for mission state, collaboration, permissions, and coordination. Visible chat is for human/team communication.

Use the corresponding structured tool when you complete, block, assign, reopen, request permission, or record durable collaboration notes. The live tool catalog is:

${TOOL_SCHEMA_REFERENCES.map(
  (tool) =>
    `- ${tool.name}: ${tool.summary} Required state permission: ${tool.requiredPermissions.join(', ') || 'none'}.`,
).join('\n')}

Retrieve detailed argument references on demand with \`search.tools\`:

\`\`\`yaml
tool: search.tools
args:
  namespace: mission.task
  includeSchemas: true
\`\`\`

For text-only providers that cannot emit native structured calls, use one generic hidden tool block per state action:

\`\`\`html
<!-- fireside-tool
tool: mission.task.update
args:
  taskId: abc
  status: done
  note: Verified with tests.
/fireside-tool -->
\`\`\`

Compatibility fallback: if a turn's direct instructions require legacy slash blocks such as \`/mission-task\`, \`/mission-receipt\`, \`/permission-request\`, or \`/collab-note\`, emit the required legacy block exactly as instructed by the live turn. Prefer the structured form everywhere else.
`;

export const PROTOCOLS_MARKDOWN = `# Fireside Protocols

This context file is the compact manifest for Fireside's structured tool layer.
It intentionally omits the old full slash-command grammar from the live context
file; call \`search.tools\` when you need the detailed argument reference.

${TOOL_MANIFEST_MARKDOWN}

## Operating Rules

- Mission state lives in Mission Control, not visible chat.
- Append one state update per concrete state change.
- Include completion evidence in note, body, evidence, or equivalent fields.
- Include blockedReason plus councilRequired when team or human council is required.
- Close any hidden fallback block with its matching end marker exactly.
- Use exact room @handles in visible chat when assigning another agent to act.

## Tool Retrieval

The prompt-visible catalog currently contains ${TOOL_SCHEMA_REFERENCES.length} tools:

\`\`\`text
${PRIMARY_TOOL_NAMES}
\`\`\`

Use \`search.tools\` with \`query\`, \`namespace\`, or \`names\` to retrieve the full schema reference for only the tools you need.
`;
