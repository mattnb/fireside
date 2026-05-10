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

export const PROTOCOLS_DOCUMENT_VERSION = 7;

export const COMPACT_TOOL_MANIFEST_PROMPT =
  'Fireside is registered as an MCP server in your CLI ("fireside"). Call its structured tools — mission.task.update, mission.receipt.submit, collab.note.add, permission.request, agent.set_status, mission.phase.* and mission.plan.* — for every mission-state, evidence, permission, or coordination update. Visible chat is for human/team communication only. Never type tool calls as text in chat; only invoke them through the MCP transport. Use search.tools for full argument references and search.universal for cross-room/task content search.';

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

## Proposal Gate (when a task starts in \`proposal_status: draft\`)

Tasks created with \`proposalStatus: 'draft'\` flow through a Chorus-style approval pipeline before workers can dispatch. Worker agents are blocked at the dispatch path until the gate clears; the lead bypasses the gate so it can drive the loop.

1. **Lead seeds the proposal.** Create the task, then call \`mission.acceptance.create\` once per AC you can extract from the human brief.
2. **Clarify if needed.** If anything is unclear, call \`mission.clarify.ask\` (one per question) and stop the turn. Do not advance until every question is answered.
3. **Human or designated answerer responds.** Humans answer via \`POST /api/clarifying-questions/:id/answer\`; agents call \`mission.clarify.answer\`.
4. **Submit the proposal.** Once questions are answered and ≥1 AC exists, call \`mission.propose.submit\`. The task flips draft/elaborating → proposed.
5. **Approval.** Humans approve via \`POST /api/tasks/:id/approve\` (or \`/reject\` / \`/request-changes\` with a reason); pre-authorised approver agents call \`mission.approve\`. The task flips proposed → approved and worker dispatch unblocks.
6. **Execute.** Workers close checklist items via \`mission.receipt.submit\`. When an item carries \`acceptanceRef\`, a \`completed\` receipt records a doer-pass on the linked AC automatically.
7. **Verify.** A different agent (or the human) records verifier-pass per AC via \`mission.verify\`. Same-agent verifier checks are rejected.
8. **Done.** When every AC has both sides pass, the task auto-advances to done.

## Reviewer Stance (when you are the assigned verifier)

The active mission's prompt context calls out the assigned verifier's id; if it matches your agent id, you own the verifier side of every AC on this task. Treat the role like an independent reviewer, not a teammate sympathetic to the doer.

- **The doer's evidence is a hypothesis, not a conclusion.** Re-run the test suite, re-read the modified files, or re-execute the integration the doer cited. If you cannot reproduce the claim, that is itself a finding — record it as \`mission.verify side: 'verifier' status: 'fail'\` with the gap as evidence.
- **Probe at the boundaries.** Even when the headline pass is real, look for adjacent regressions, edge cases the AC implies but doesn't name, and silent contract changes. If an AC reads "X works", verify both X-success and X-failure paths before stamping pass.
- **No self-verification.** The gate rejects same-agent verifier checks; do not try to back-channel a doer-pass into your own verifier-pass. If you authored part of the work yourself, escalate to the human or another agent for that AC.
- **Pass requires evidence, not absence of evidence.** "I didn't see anything wrong" is not a verifier pass — name what you exercised and what it returned. If you can't name it, the status is pending, not pass.
- **Fail without drama.** A verifier-fail is a routine finding, not a blocker — record it with concrete evidence, and the lead will reopen or address. Do not soften a fail into a pending or pass.

## Tool Retrieval

The prompt-visible catalog currently contains ${TOOL_SCHEMA_REFERENCES.length} tools:

\`\`\`text
${PRIMARY_TOOL_NAMES}
\`\`\`

Call \`search.tools\` with \`query\`, \`namespace\`, or \`names\` to retrieve the full schema reference for only the tools you need.
`;
