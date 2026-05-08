# Fireside Structured Agent Tool Layer Spec

Status: draft

Author: Codex

Date: 2026-05-07

Source prompt: compare Chorus to Fireside and turn the highest-value gap, "structured agent tools / MCP layer", into a concrete Fireside spec.

Related external reference:

- Chorus README: https://github.com/Chorus-AIDLC/Chorus
- Chorus MCP tool model: https://github.com/Chorus-AIDLC/Chorus/blob/main/docs/MCP_TOOLS.md
- Chorus permission model: https://github.com/Chorus-AIDLC/Chorus/blob/main/docs/PERMISSIONS.md

## Summary

Fireside should add a structured agent tool layer that lets agents mutate mission state, route work, report evidence, request permissions, and inspect assignments through typed tool calls instead of relying primarily on chat text and parsed slash blocks.

The first implementation does not need to expose a full public MCP server. It should create a provider-neutral internal tool contract, wire that contract to existing Fireside services, then expose it through adapters:

1. Hidden-command compatibility adapter for current `/mission-*` and `/permission-request` blocks.
2. Provider prompt/tool bridge for CLIs that cannot call MCP directly.
3. Optional MCP endpoint once the internal contract is stable.

The important shift is architectural: prompts should explain what tools exist, but structured tool calls should become the authoritative control plane.

## Problem

Fireside currently depends on agent-authored text blocks for many critical actions:

- `/mission-create`
- `/mission-plan`
- `/mission-phase`
- `/mission-task`
- `/mission-receipt`
- `/collab-note`
- `/permission-request`
- `/agent-roster`

This has worked well enough to prove the product direction, but it creates recurring failure modes:

- Agents bury commands in prose, comments, markdown, or malformed blocks.
- Provider-specific formatting quirks break state updates.
- Long prompt instructions are repeatedly injected so agents remember syntax.
- Mission state updates compete with human-readable chat output.
- The broker has to infer intent from text that was not designed as an API.
- Hidden commands are hard to validate before they reach state applicators.
- The same action can be represented many ways, making replay and diagnostics harder.

The current pipeline work is the right direction, but the long-term target should be typed actions with schemas, permissions, idempotency, and explicit audit records.

## Goals

- Make agent-initiated state changes deterministic and schema-validated.
- Reduce prompt budget spent on command syntax.
- Preserve a complete audit trail for every tool call, including accepted, rejected, and no-op outcomes.
- Keep the human-visible chat readable while still surfacing meaningful activity.
- Support provider-neutral permissions and yolo grants through the same enforcement path.
- Make mission execution replayable without launching provider CLIs.
- Allow future MCP clients to integrate without rewriting mission logic.
- Keep hidden slash commands working during migration.

## Non-Goals

- Do not replace Claude/Codex/Gemini provider adapters in the first phase.
- Do not expose arbitrary filesystem or shell tools through this layer.
- Do not build hosted multi-tenant auth as part of this work.
- Do not require every provider to support native function calling before Fireside benefits.
- Do not remove existing hidden-command parsing until compatibility and migration are proven.

## Design Principles

### Structured Actions Are Source Of Truth

Agent intent should be represented as a typed action object:

```json
{
  "tool": "mission.task.update",
  "idempotencyKey": "run-123:task-update:DskpV4XKvHyn9f:done",
  "args": {
    "taskId": "DskpV4XKvHyn9f",
    "status": "done",
    "note": "Verified locally with focused regression coverage."
  }
}
```

Visible chat text can describe the action, but it should not be the durable representation of the action.

### Tool Execution Is A Pipeline

Every tool call should pass through the same stages:

1. Decode
2. Authenticate actor
3. Validate schema
4. Normalize references
5. Check permissions
6. Check idempotency
7. Apply state change
8. Record audit event
9. Emit UI/broker effects

Each stage should be pure or close to pure where possible, with narrow side-effect boundaries.

### Compatibility Is An Adapter

Existing slash blocks should become one possible input adapter:

```text
/mission-task
action: update
id: abc
status: done
note: ...
/end-mission-task
```

The adapter parses this into:

```json
{
  "tool": "mission.task.update",
  "args": {
    "taskId": "abc",
    "status": "done",
    "note": "..."
  }
}
```

After that translation, hidden commands and future MCP/tool calls use the same execution path.

### Permissions Are Enforced At Tool Boundaries

Tool permission checks should be independent of prompt instructions. If an agent lacks capability, the call is rejected or converted into a pending permission request.

### Idempotency Is Mandatory

Agents retry. Providers resume. Runs can be replayed. A tool call must be safe to receive more than once.

## Proposed Tool Namespaces

### `agent.*`

Agent identity, check-in, queue, and self-state.

Initial tools:

- `agent.checkin`
- `agent.set_status`
- `agent.list_assignments`
- `agent.ack_message`
- `agent.request_turns`

Example:

```json
{
  "tool": "agent.checkin",
  "args": {
    "includeAssignments": true,
    "includeQuota": true
  }
}
```

### `mission.*`

Mission lifecycle and mission-level state.

Initial tools:

- `mission.create`
- `mission.update_brief`
- `mission.set_active_plan`
- `mission.snapshot`
- `mission.complete`
- `mission.repair_status`

### `mission.plan.*`

Plans and plan markdown.

Initial tools:

- `mission.plan.create`
- `mission.plan.update`
- `mission.plan.activate`
- `mission.plan.archive`

Confirmed Phase 3 schemas:

- `mission.plan.create`: `{ title, body?, status? }`
  - `title` is required.
  - `status` is optional and limited to `draft | active`; default behavior remains handler/applicator owned.
- `mission.plan.update`: `{ planId, title?, body? }`
  - `planId` is required for native tool callers. The schema also accepts `title`/`plan` compatibility refs for the slash-block adapter, but the resolver should normalize to the canonical plan id before mutation.
  - At least one of `title` or `body` is required. Activating or archiving a plan should use the dedicated tools below.
- `mission.plan.activate`: `{ planId }`
  - Activates the selected plan and relies on the existing repository behavior that supersedes other active plans for the same mission.
- `mission.plan.archive`: `{ planId, status?, reason? }`
  - `status` defaults to `archived` in the handler if absent and may only be `archived | superseded`.
  - `reason` is audit metadata only; it should not be appended to plan markdown unless a later product decision explicitly asks for that.

### `mission.phase.*`

Phase gates.

Initial tools:

- `mission.phase.create`
- `mission.phase.update`
- `mission.phase.complete`
- `mission.phase.reopen`
- `mission.phase.list_blockers`

Confirmed Phase 3 schemas:

- `mission.phase.create`: `{ title, plan?, description?, gate?, status?, sortOrder? }`
  - `title` is required.
  - `plan` accepts a plan id, title, `current`, or a clear ref such as `none`; handlers resolve it against the active mission's plans.
  - `status` is optional and limited to `planned | active | blocked`; `done` is intentionally excluded because completion must use `mission.phase.complete` so empty-phase validation and admin permission checks are explicit.
- `mission.phase.update`: `{ phaseId, title?, plan?, description?, gate?, status?, sortOrder? }`
  - `phaseId` is required for native tool callers. The schema also accepts `title`/`phase` compatibility refs so the slash-block adapter can preserve current behavior while normalizing to a phase id before mutation.
  - `status` is limited to `planned | active | blocked`; hidden `/mission-phase status: done` compatibility should decode to `mission.phase.complete`, not `mission.phase.update`.
- `mission.phase.complete`: `{ phaseId, note?, evidence? }`
  - Requires `mission:admin`.
  - Handler must reuse existing unfinished-checklist validation before setting `done`; failed validation records a rejected tool call with the same blocker detail currently produced by the phase applicator.
- `mission.phase.reopen`: `{ phaseId, status?, reason? }`
  - Requires `mission:admin`.
  - `status` defaults to `active` in the handler if absent and is limited to `planned | active | blocked`.

### `mission.task.*`

Checklist work items.

Initial tools:

- `mission.task.create`
- `mission.task.update`
- `mission.task.assign`
- `mission.task.claim`
- `mission.task.release`
- `mission.task.block`
- `mission.task.complete`
- `mission.task.add_note`
- `mission.task.link_phase`
- `mission.task.link_plan`
- `mission.task.set_dependencies`
- `mission.task.set_scope_contract`

### `mission.evidence.*`

Evidence and receipts.

Initial tools:

- `mission.evidence.add`
- `mission.evidence.link_task`
- `mission.evidence.link_phase`
- `mission.receipt.submit`

### `collab.*`

Collaboration notes, disagreements, proposals, and decisions.

Initial tools:

- `collab.note.add`
- `collab.note.update`
- `collab.decision.record`
- `collab.disagreement.open`
- `collab.disagreement.resolve`

### `permission.*`

Permission requests and grants.

Initial tools:

- `permission.request`
- `permission.current_grants`
- `permission.explain_denial`

The human approval UI can continue to own approval/denial. Agent-side tools should request and inspect state, not self-approve outside yolo policy.

### `search.*`

Search and retrieval across Fireside state.

Initial tools:

- `search.global`
- `search.room`
- `search.mission`
- `search.briefings`
- `search.runs`

This is also the natural future home for artifact/file search.

## Permission Model

Fireside already has provider/action capabilities:

- `read`
- `edit-existing`
- `create-file`
- `delete-file`
- `run-command`
- `git-commit`
- `git-push`
- `network`
- `escape-cwd`

The tool layer should add state permissions that are distinct from filesystem permissions:

| Permission           | Allows                                                     |
| -------------------- | ---------------------------------------------------------- |
| `mission:read`       | Inspect mission state, plans, phases, tasks, evidence      |
| `mission:write`      | Create/update plans, phases, checklist items, notes        |
| `mission:admin`      | Complete/reopen phases, complete mission, repair structure |
| `collab:write`       | Add collaboration notes, disagreements, decisions          |
| `agent:write-self`   | Update own status, ack messages, claim/release own work    |
| `agent:coordinate`   | Assign work to other agents, request team turns            |
| `permission:request` | Create permission requests                                 |
| `search:read`        | Search mission/room/briefing state                         |

Yolo mode should grant a default state profile separately from filesystem grants:

```json
{
  "state": [
    "mission:read",
    "mission:write",
    "mission:admin",
    "collab:write",
    "agent:write-self",
    "agent:coordinate",
    "permission:request",
    "search:read"
  ],
  "filesystem": ["read", "edit-existing", "create-file", "run-command"],
  "turnBank": 100
}
```

## Data Model Additions

### `agent_tool_calls`

Durable record for every decoded structured action.

Fields:

- `id`
- `room_id`
- `mission_id`
- `run_id`
- `message_id`
- `agent_id`
- `tool_name`
- `idempotency_key`
- `source`
- `status`
- `args_json`
- `normalized_args_json`
- `result_json`
- `error`
- `created_at`
- `applied_at`

Suggested statuses:

- `decoded`
- `validated`
- `applied`
- `rejected`
- `duplicate`
- `permission_pending`
- `permission_denied`
- `failed`

Suggested sources:

- `hidden-command`
- `provider-tool-call`
- `mcp`
- `system`
- `replay`

This table should either replace or subsume parts of `mission_command_events` over time. During migration, `mission_command_events` can remain as the UI-facing legacy stream while `agent_tool_calls` becomes the canonical execution ledger.

### `agent_tool_call_effects`

Optional secondary table if a single tool call can emit multiple effects.

Fields:

- `id`
- `tool_call_id`
- `effect_kind`
- `target_type`
- `target_id`
- `summary`
- `payload_json`
- `created_at`

This is useful for UI timelines: "updated checklist item", "completed phase", "queued agent turn", "created permission request".

## Execution Architecture

Proposed modules:

```text
server/src/tools/
  registry.ts
  types.ts
  execute-tool-call.ts
  schemas/
    mission-task.ts
    mission-phase.ts
    mission-plan.ts
    permission.ts
    collab.ts
    agent.ts
    search.ts
  permissions/
    state-permissions.ts
    authorize-tool-call.ts
  idempotency.ts
  adapters/
    slash-block-adapter.ts
    provider-tool-adapter.ts
    mcp-adapter.ts
  handlers/
    mission-task-tools.ts
    mission-phase-tools.ts
    mission-plan-tools.ts
    permission-tools.ts
    collab-tools.ts
    agent-tools.ts
    search-tools.ts
```

The existing applicators should be reused behind handlers:

- `server/src/mission-state/mission-task-applicator.ts`
- `server/src/mission-state/mission-phase-applicator.ts`
- `server/src/mission-state/mission-plan-applicator.ts`
- `server/src/mission-state/mission-create-applicator.ts`
- `server/src/mission-state/collaboration-note-applicator.ts`
- `server/src/orchestration/permission-orchestrator.ts`

The broker should not become the tool engine. It should decode agent replies, hand tool calls to `executeToolCall`, then react to returned effects.

## Tool Call Lifecycle

```text
agent reply / provider event / MCP request
  -> adapter decodes candidate tool calls
  -> registry resolves tool definition
  -> schema validates args
  -> resolver normalizes ids, names, handles, phase refs, plan refs
  -> permission check
  -> idempotency check
  -> handler applies state change
  -> audit row recorded
  -> effects emitted to broker/UI
```

Handler return shape:

```ts
interface AgentToolResult {
  status: 'applied' | 'rejected' | 'duplicate' | 'permission_pending' | 'failed';
  summary: string;
  data?: unknown;
  effects: AgentToolEffect[];
}
```

Effect shape:

```ts
interface AgentToolEffect {
  kind:
    | 'mission-updated'
    | 'task-updated'
    | 'phase-updated'
    | 'plan-updated'
    | 'permission-requested'
    | 'agent-dispatch-requested'
    | 'activity-created';
  targetType?: string;
  targetId?: string;
  summary: string;
  payload?: unknown;
}
```

## Provider Integration Strategy

### Phase 1: Hidden Commands To Tool Calls

Keep current prompt behavior. Parse hidden commands exactly as today, but convert them into `AgentToolCall` objects before state mutation.

Benefits:

- Low provider risk.
- Immediate audit consistency.
- Existing tests can be ported around the new execution core.

### Phase 2: Compact Tool Manifest In Prompts

Replace long syntax docs with a compact manifest:

```text
Use structured tool blocks when updating Fireside state.
Available tools: mission.task.update, mission.phase.complete, collab.note.add, permission.request.
Prefer one tool block per action.
```

The full schema should be available through context files or a `search/tools` retrieval call, not repeated in every prompt.

### Phase 3: Provider Tool Bridge

For providers that emit structured tool events, map those directly to `AgentToolCall`.

For providers that only emit text, continue parsing hidden blocks.

### Phase 4: MCP Endpoint

Expose the same registry through an MCP server:

```text
POST /api/mcp
```

MCP should not get its own implementation logic. It should be another adapter over the same registry and handlers.

## Prompt Changes

The prompt should stop teaching a large command grammar on every turn.

Target prompt text:

```text
Fireside supports structured state tools. Use them for mission state, task status, evidence,
permissions, and coordination. Visible chat is for human/team communication.

When you complete, block, assign, or reopen work, emit the corresponding structured tool call.
When you need another agent to act, tag their exact @handle in visible chat and use the task/assignment tool when applicable.
```

For text-only providers, add:

```text
If your provider cannot emit native tool calls, use the slash-block fallback
required by the live turn. The text-input adapter parses that block and routes
it through the same structured tool engine:

/mission-task
action: update
id: abc
status: done
note: Verified with tests.
/end-mission-task
```

The slash-block format is the supported text-input adapter during this
migration. Native provider tools and MCP calls should use the canonical typed
tool names and schemas directly.

## UI Impact

### Run Detail Modal

Add a "Tool Calls" tab:

- tool name
- status
- actor
- normalized target
- summary
- raw args
- result/error
- effects emitted

### Mission Control

Show structured effects as activity:

- "Nat completed Regression coverage"
- "Jimmy assigned Rebuild dashboard to Temur"
- "Ariane opened disagreement: IA tradeoff"
- "Phase 4 reopened because 6 unfinished tasks remain"

### Diagnostics

Add a tool-call replay view:

- select run
- replay decoded tool calls against fixture state
- show which calls would apply, reject, or duplicate

## Migration Plan

### Milestone 1: Tool Registry Skeleton

Deliverables:

- `server/src/tools/types.ts`
- `server/src/tools/registry.ts`
- `server/src/tools/execute-tool-call.ts`
- unit tests for registry lookup, schema failures, unknown tools, and idempotency.

No behavior change yet.

### Milestone 2: Mission Task Tool

Deliverables:

- `mission.task.update`
- `mission.task.add_note`
- hidden `/mission-task` adapter routes through tool engine
- existing mission task applicator tests still pass
- new audit rows created for parsed task updates

### Milestone 3: Phase And Plan Tools

Deliverables:

- `mission.phase.create/update/complete/reopen`
- `mission.plan.create/update/activate/archive`
- empty-phase validation uses tool-call diagnostics where possible
- UI can show source tool calls for phase/plan changes

### Milestone 4: Permission And Collaboration Tools

Deliverables:

- `permission.request`
- `collab.note.add/update`
- hidden `/permission-request` and `/collab-note` adapters route through tool engine
- permission approvals continue using existing human UI

### Milestone 5: Prompt Compression

Deliverables:

- replace entity-specific slash syntax in prompts with compact tool manifest
- write full tool schema to context fixture when needed
- measure prompt overhead before/after

### Milestone 6: MCP Adapter

Deliverables:

- `/api/mcp` or local MCP-compatible endpoint exposing selected tools
- API key or local-only trust model
- tool permission enforcement shared with internal engine
- no duplicate handler logic

## Testing Strategy

Unit tests:

- tool registry and schema validation
- permission mapping
- idempotency behavior
- slash-block adapter conversions
- handler outcomes and effects

Integration tests:

- existing agent reply with `/mission-task` updates task through tool engine
- malformed hidden block records rejected tool call without mutating mission state
- duplicate provider retry records duplicate outcome without double note/task change
- permission request creates pending permission card through tool engine
- yolo state permission grants auto-approve eligible permission calls

Replay tests:

- run stored provider output through adapters
- assert tool call ledger and resulting mission state
- assert no provider CLI launch occurs

## Open Questions

- Should the first MCP endpoint be enabled by default or gated behind `FIRESIDE_ENABLE_MCP=1`?
- Should state permissions be per-agent profile fields immediately, or inferred from persona/yolo mode for the first version?
- Should tool calls be visible in chat by default, or only summarized as activity events?
- Should failed tool calls notify the team lead automatically?
- Should human UI actions also flow through the same tool engine for perfect audit parity?

## Success Criteria

- Agents can update mission tasks/phases/plans without relying on bespoke slash block parsing.
- The broker can explain every accepted/rejected mission mutation by tool call id.
- Duplicate retries do not create duplicate notes, activity events, or dispatches.
- Run replay can reproduce mission state changes from stored output.
- Prompt text dedicated to command syntax shrinks materially.
- The UI shows high-signal agent actions without surfacing low-level parsing noise.

## Recommended First Slice

Build `mission.task.update` end to end.

This is the best first slice because checklist task updates are the most frequent and most painful failure point. It also exercises the full path:

- parser compatibility
- schema validation
- reference normalization
- mission-state applicator reuse
- durable audit
- UI effects
- idempotency
- replay

Once this is stable, phase, plan, receipt, collaboration, and permission tools follow the same pattern.
