# Phase 4 — Permission and Collaboration Tools Design

Status: design pass (research). 2026-05-07.
Phase id: `EddLwWkULl_Brl`. Lane: `lLrXjLEmHKXcDb`.

This memo answers Phase 4's three questions in order:

1. State-permission grant model — per-agent profile fields, or stay
   inferred from persona/yolo?
2. `permission.*` tool surface (schema, semantics, adapter impact).
3. `collab.*` tool surface (schema, semantics, adapter impact).

It does **not** ship handlers; those are Milestone 4 implementation work.
The schema skeletons exist as importable types so Milestone 4 can plug in
handlers without re-litigating contracts.

---

## 1. State-permission grant model

**Decision: keep state permissions inferred from persona/yolo for now.
Do not add per-agent profile fields in Phase 4.**

### Why

- The mapping already works. `statePermissionsForGrant` in
  `server/src/tools/permissions/authorize-tool-call.ts` resolves a
  `PermissionGrant` to a concrete `StatePermission[]` based on
  `source === 'yolo'`, `mode === 'full-auto' | 'edit' | 'plan'`. Tests in
  `server/tests/unit/tools/state-permissions.test.ts` already exercise
  the matrix.
- Per-agent profile fields would force a schema migration on
  `RoomAgentProfile` (`server/src/agents/types.ts:30`) and a new
  admin-side UX (an Aegis grants editor, room-level overrides,
  inheritance from persona). Nobody on the team has asked for that
  affordance, and we have no concrete use case where the inferred
  mapping returns the wrong answer.
- Persona-derived defaults are easy to layer in later as a thin
  override step in `statePermissionsForGrant` — the call site that
  reads the grant does not need to change.

### What we will do in Phase 4

- Continue routing all tool authorization through `authorizeToolCall`.
- Hidden-command adapter passes `statePermissions` derived from the
  active `PermissionGrant`, not a hard-coded `['mission:write']`.
  Today the adapter at
  `server/src/tools/adapters/slash-block-adapter.ts:181`
  short-circuits to `mission:write`; Milestone 4 must replace that with
  `statePermissionsForGrant(grant)` so phase/plan/collab/permission
  tools authorize correctly.
- `permission.request` requires `permission:request`, which is granted
  in plan/edit/full-auto/yolo per the existing matrix — i.e. always
  available unless the agent has no grant at all. That is the right
  default for a tool whose purpose is to ask for more permission.

### What is explicitly deferred

- Per-agent state-permission overrides (`profile.statePermissions`).
- Persona-level state-permission templates.
- Room-level admin grants beyond yolo.

These become a Phase 7+ concern when we have a real workflow where
"agent X may write missions but not complete phases" matters. Until
then, the `mission:admin` gate on `mission.phase.complete` and friends
already gives the human the right escape hatch — yolo unlocks it for
the run, and non-yolo runs cannot complete a phase without an explicit
human action.

### Open question deferred to council

> Should an agent in `plan` mode be able to file `permission.request`?

Current matrix says yes (`permission:request` is granted at `plan`).
That is consistent with how `/permission-request` works today: a plan-
only run can ask for elevation. Keeping it in plan is correct — denying
it would force the agent to either fail silently or escape via a chat
message, both worse than a structured request the human can approve.

---

## 2. `permission.*` tools

### Initial surface (Phase 4 ships only `permission.request`)

| Tool                          | State perm           | Notes                                |
| ----------------------------- | -------------------- | ------------------------------------ |
| `permission.request`          | `permission:request` | Asks the human for elevation.        |
| `permission.current_grants`   | `mission:read`       | Read-only inspect; defer to Phase 5. |
| `permission.explain_denial`   | `mission:read`       | Pretty-prints last denial; Phase 5+. |

Only `permission.request` is on the Phase 4 critical path. The other
two are Phase 5+ once we know what surfacing them in chat looks like.

### `permission.request` schema

```ts
interface PermissionRequestArgs {
  mode: 'plan' | 'edit' | 'full-auto';
  target: string;            // 1..500 chars, trimmed
  reason: string;            // 1..1000 chars, trimmed
  requestedMode?: string;    // raw alias the agent typed (e.g. "shell")
  capabilities?: PermissionCapability[];
  filesystemScope?: 'task' | 'cwd' | 'custom' | 'unrestricted';
  web?: boolean;
}
```

The schema mirrors `ParsedPermissionRequest`
(`server/src/permissions.ts:72`) but presented as a typed args object
instead of free-form key-value lines.

### Handler outline (Milestone 4)

1. Build a `ParsedPermissionRequest` via `buildPermissionGrant` so the
   capabilities table stays consistent with `/permission-request`.
2. Insert an `agent_tool_calls` row (already done by
   `executeToolCall`).
3. Emit a single `permission-requested` effect carrying the full
   parsed request. The broker's existing permission orchestrator
   consumes the effect to enqueue/auto-approve the request the same
   way it handles a hidden-block extraction today.
4. If yolo policy auto-approves, the broker still creates the
   `agent_tool_calls` row plus the `permission_request` row; the tool
   call's `result.status` is `applied` and the effect payload tells
   the orchestrator to short-circuit.

### Adapter impact

`/permission-request` blocks already extract via
`extractPermissionRequest`. The Milestone 4 adapter will:

1. Run the existing extractor.
2. Translate the parsed request into a `permission.request` tool call
   with idempotency key
   `${runId}:permission.request:${slug(target)}:${sha1(reason).slice(0,12)}`.
3. Hand the call to `executeToolCall`. The handler's
   `permission-requested` effect is what the broker enqueues — the
   adapter no longer enqueues directly.

Backwards-compatibility: the visible-text stripping behavior of the
extractor stays in the adapter. The tool layer never sees the original
hidden block.

---

## 3. `collab.*` tools

### Initial surface

`collab.note.add` and `collab.note.update` are sufficient for Phase 4.
The spec lists `decision.record`, `disagreement.open`,
`disagreement.resolve` — those are not new state, just preset values
of the `kind` and `status` fields on a collaboration note. Adding
convenience tools later is a one-screen change that does not move the
data model. We avoid the proliferation today.

| Tool                    | State perm     | Maps to                                  |
| ----------------------- | -------------- | ---------------------------------------- |
| `collab.note.add`       | `collab:write` | `storeCollaborationNotes` (insert path)  |
| `collab.note.update`    | `collab:write` | `storeCollaborationNotes` (update by id) |

Required permission `collab:write` is already wired into
`requiredStatePermissionsForTool` for any `collab.*` name
(`server/src/tools/permissions/state-permissions.ts:35`).

### Schemas

```ts
type CollaborationKind   = 'proposal' | 'challenge' | 'revision' | 'decision' | 'evidence';
type CollaborationStatus = 'open' | 'blocked' | 'accepted' | 'rejected'
                         | 'resolved' | 'superseded' | 'informational';
type CollaborationConfidence = '' | 'low' | 'medium' | 'high';

interface CollabNoteAddArgs {
  kind: CollaborationKind;
  title?: string;
  body?: string;
  target?: string;
  evidence?: string[];
  status?: CollaborationStatus;        // defaults per kind (decision='accepted', etc.)
  confidence?: CollaborationConfidence;
}

interface CollabNoteUpdateArgs {
  id: string;                          // existing collaboration_notes.id
  status?: CollaborationStatus;
  title?: string;
  body?: string;
  evidence?: string[];
  confidence?: CollaborationConfidence;
}
```

`status` defaulting mirrors `defaultStatus(kind)` in
`server/src/collaboration-notes.ts:51` so the tool layer behaves the
same as the hidden-block parser.

### Handler outline (Milestone 4)

- Reuse `storeCollaborationNotes` in
  `server/src/mission-state/collaboration-note-applicator.ts`. That
  applicator already handles insert + update; the tool handler just
  shapes args into a `ParsedCollaborationNote[]` of length 1 and
  delegates.
- Effect is `activity-created` with `targetType: 'collab-note'` and a
  one-line summary. Tool ledger covers durability; `activity-created`
  is the UI signal.

### Adapter impact

`/collab-note` extraction lives in `extractCollaborationNotes`. The
adapter translates each parsed note into a `collab.note.add` (no `id`)
or `collab.note.update` (with `id`). Idempotency key:

- add:    `${runId}:collab.note.add:${kind}:${sha1(body || title).slice(0,12)}`
- update: `${runId}:collab.note.update:${id}:${sha1(body || title).slice(0,12)}`

A duplicate retry of the same hidden block produces one ledger row
plus a `duplicate` audit row, matching the mission-task pattern.

---

## 4. Test plan (Milestone 4)

Unit:

- `permission.request` schema: required fields, length caps,
  capability filter, filesystemScope/web booleans.
- `collab.note.add` / `update` schemas: kind validation, status
  default-per-kind, evidence array trimming, id requirement on update.
- Adapter conversions: `/permission-request` and `/collab-note` lead
  to the expected tool calls with stable idempotency keys.

Integration:

- `/permission-request` block flows through `executeToolCall` and
  produces the same `PermissionRequest` row the legacy path produced.
- `/collab-note` block routes through tool engine, persists via the
  existing applicator, and emits `activity-created`.
- Duplicate `/collab-note` retry → single applied row + duplicate
  audit row (mirrors mission-task slice).
- Permission denied: a non-yolo run with `mode: 'plan'` cannot fire
  `collab.note.add`; the audit row records `permission_denied` with
  `Missing state permission: collab:write`.

Replay:

- Stored agent output containing both blocks → tool ledger plus
  unchanged downstream state, no provider CLI launch.

---

## 5. Recommended sequencing for Milestone 4

1. Replace the `['mission:write']` short-circuit in the hidden-command
   adapter with `statePermissionsForGrant(grant)`. This is a one-line
   change but unblocks every later tool because permission denials
   stop being silently false-positive.
2. Land `permission.request` schema + handler + adapter.
3. Land `collab.note.add` schema + handler + adapter, then
   `collab.note.update` (smaller scope, share the applicator).
4. Wire run-detail UI to surface `permission-requested` and
   `activity-created` effects with the same Tool Calls section
   (`AgentToolCallView` is already shape-complete).
5. Council review the deferred per-agent profile question if and only
   if a real need surfaces during dogfooding.
