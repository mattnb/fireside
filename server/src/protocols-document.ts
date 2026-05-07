// Canonical Fireside protocol schemas.
//
// This file is the source of truth for every hidden block schema agents emit
// (mission, collaboration, permission, roster, draft artifact). It is written
// to `data/agent-context/<room>/protocols.md` so the live per-turn prompt can
// reference it by path instead of repeating the full schemas every turn.

export const PROTOCOLS_DOCUMENT_VERSION = 1;

export const PROTOCOLS_MARKDOWN = `# Fireside Hidden Block Protocols

This file is the canonical schema for every hidden command block Fireside agents emit.
The live per-turn prompt only references this file by path; treat it as the source of truth
for the exact field names, allowed values, and end markers. Close every block with its
matching \`/end-*\` marker exactly.

## Mission state

### \`/mission-create\` — only when no active mission exists and the human asks for a new mission scaffold

\`\`\`
/mission-create
title: concise mission title
goal: what the team should accomplish
repo_path: optional workspace or project path
acceptance: concrete conditions for completion
agents: optional comma-separated agent ids
capability_profile: plan
summary: optional short briefing-room summary
/end-mission-create
\`\`\`

After \`/mission-create\` in the same reply you may also append \`/mission-plan\`,
\`/mission-phase\`, and \`/mission-task\` blocks to populate the new mission.

### \`/mission-plan\` — coordinators/leads only

The active plan is the human-readable agreement and rationale; phase gates and
checklist items remain the execution state.

\`\`\`
/mission-plan
action: create | update
id: optional plan id (for update)
title: concise plan title
status: active | superseded | done
body:
## Direction
What the team agrees to do and why.
## Assumptions and Evidence
Known assumptions, evidence needed, and unresolved disagreements.
## Execution Shape
How phase gates and checklist work items should decompose this plan.
/end-mission-plan
\`\`\`

### \`/mission-phase\` — coordinators/leads only

Create phase gates before checklist items so work items can reference them by title or id.
When the gate is satisfied and every checklist item in that phase is done or skipped,
mark the phase \`status: done\`. Fireside auto-activates the next planned phase unless
the same reply explicitly activates a different phase.

\`\`\`
/mission-phase
action: create | update
id: optional phase id (for update)
plan: optional active plan id or title; defaults to the active plan from this reply
title: short phase title
status: planned | active | done | blocked
gate: concrete criteria that must be true before leaving this phase
description: optional one-sentence phase scope
/end-mission-phase
\`\`\`

### \`/mission-task\` — every tier may use this

To take ownership, set \`owner\` to your agent id. When the task is complete, set
\`status: done\` and include completion evidence in \`note\`. Status aliases
\`accepted\`/\`complete\`/\`completed\`/\`finished\`/\`resolved\` also count as done.
If blocked and \`council_required: true\`, the mission is marked blocked for human/team council.

\`\`\`
/mission-task
action: create | update
id: optional checklist item id (for update)
title: short task title
status: open | done | blocked | skipped
plan: optional active plan id or title
phase: optional phase id or title
depends_on: optional item id(s), comma-separated
expected_touches: optional file paths, globs, package names, or logical scopes, comma-separated
parallelism: parallel-safe | coordinate | exclusive
conflict_group: optional short label for work that should not run concurrently
work_role: implement | review | verify | research | docs | other concise role
owner: optional agent id
detail: one sentence of scope or acceptance evidence
note: status note, completion evidence, or blocker summary
council_required: false | true
/end-mission-task
\`\`\`

### \`/mission-receipt\` — every active-mission turn must leave a reconciliation trail

If you create or change mission state, use the mission-plan, mission-phase,
mission-task, or mission-create blocks above. If you do not change mission state,
append a receipt block.

\`\`\`
/mission-receipt
status: completed | blocked | needs_review | continuing | no_update
item: optional checklist item id or title
phase: optional phase id or title
plan: optional plan id or title
summary: what changed, what you attempted, or why there is no state update
evidence: optional file path, command, test, or source
next: optional next owner or next step
/end-mission-receipt
\`\`\`

## Collaboration

### \`/collab-note\` — record durable proposals, challenges, revisions, decisions, or evidence

Use \`status: open\` for active items, \`blocked\` for live blockers, \`resolved\` for
settled items, \`superseded\` when a newer item replaces it, \`accepted\`/\`rejected\`
for decisions, and \`informational\` for evidence.

\`\`\`
/collab-note
kind: proposal | challenge | revision | decision | evidence
title: concise claim or direction
target: optional claim, file, decision, or plan this refers to
status: open | blocked | resolved | superseded | accepted | rejected | informational
confidence: low | medium | high
evidence: file:path:line; test:command; url:https://example.com
body: one concise sentence explaining why this matters
/end-collab-note
\`\`\`

## Permissions

### \`/permission-request\` — only when you do not already have a permission grant for this turn

Use \`mode: edit\` for file mutation (aliases: \`write\`, \`create\`); \`mode: bash\` for
scoped shell/git commands; \`mode: full-auto\` only for broad shell/tool execution.

\`\`\`
/permission-request
mode: edit | bash | full-auto
target: path-or-command
reason: brief reason
/end-permission-request
\`\`\`

### \`/draft-artifact\` — preserve substantial drafted content while waiting for write permission

\`\`\`
/draft-artifact
name: file.md
target: path
content:
…the draft content…
/end-draft-artifact
\`\`\`

## Roster (engineering-manager / qa-lead personas only)

### \`/agent-roster\` — add or dismiss temporary agents you personally manage

Add up to three active temporary agents at a time. Use only when it improves
mission flow, parallel QA/review, or task throughput.

\`\`\`
/agent-roster
action: add
name: codex-regression
provider: codex | claude | gemini
persona: persona-id (e.g., quality-assurance-engineer)
scope: checklist item, phase, file area, or review lane
reason: why this temporary agent is needed now
yolo: true | false
max_turns: 25
dismiss_when: review complete or blocked
prompt:
Focused instructions, context, expected evidence, and how to report/dismiss.
/end-agent-roster
\`\`\`

To dismiss a temporary agent:

\`\`\`
/agent-roster
action: dismiss
id: agent-id
name: optional name fallback
reason: why this agent is being dismissed now
/end-agent-roster
\`\`\`

## Block hygiene

- Close every hidden block with its matching \`/end-*\` marker exactly. Do not close
  \`/mission-plan\`, \`/mission-phase\`, or \`/mission-task\` blocks with \`/end-collab-note\`.
- Mission state lives in Mission Control, not visible chat. When you take ownership,
  finish work, block, change direction, or satisfy a phase gate, update Mission Control
  with hidden blocks in the same reply before ending the turn.
`;
