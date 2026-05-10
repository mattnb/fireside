# Mission Proposal/Approve/Verify Gates

**Date:** 2026-05-07 (revised 2026-05-09 for MCP-first reality)
**Owner:** unassigned
**Status:** spec — PR 1 in progress
**Inspired by:** Chorus AI-DLC pipeline (Idea → Q&A elaboration → Proposal → Admin approval → Execute → dual-path Acceptance Criteria → Done). See `docs/backlog.md` and the harness comparison at `docs/chorus-comparison-2026-05-08.md`.

## 2026-05-09 revision — post-Phase-2 MCP migration

Phase 2 of the MCP-first migration (commits `04eef92` + `de5a084`) deleted the slash-block extractor pipeline. Hidden-block parsers are no longer the canonical input surface — MCP tools are. Sub-deliverable 6 has been rewritten in place to use **5 new MCP tools** (`mission.clarify.ask` / `mission.clarify.answer`, `mission.acceptance.create` / `.update` / `.reorder`, `mission.propose.submit`, `mission.verify`, `mission.approve`) and **2 new HTTP endpoints** (`POST /api/tasks/:id/approve` and `/reject`) for human approval, since humans don't drive MCP. Sub-deliverables 1–5 are unchanged. The sequencing PRs and ~1500 LOC magnitude estimate also stand.

## Context

Fireside already has the mission-state bones — `tasks`, `task_plans`, `task_phases`, `task_checklist_items`, `task_checklist_notes`, `mission-receipts` parsing, `mission-state/*` applicators, `phase-completion`, `auto-advance-phase`. What it does not have:

1. An explicit **draft → proposed → approved** gate. Tasks today flip straight from creation to dispatchable; any agent referenced in `agents` can start working as soon as a `<!-- mission-create -->` block lands.
2. **Per-criterion acceptance records**. `tasks.acceptance_criteria` is a single TEXT blob. There is no row-per-criterion to attach pass/fail evidence to, and no way to know "AC #3 is verified, AC #4 is failing" without reading prose.
3. A **dual-path verify**. The receipt applicator (`server/src/mission-state/mission-receipt-applicator.ts:207`) closes a checklist item from the doer's own `<!-- mission-receipt status: completed -->` block. There is no requirement for a second, independent agent (or human) to confirm. `needs_review` exists as a receipt status but the applicator treats it as a continuation, not a hard gate.
4. A **structured clarification loop**. Today the lead either parses the human's brief well enough to commit a mission, or asks free-text clarifying questions in chat. Neither path persists Q/A pairs against the future task, so the elaboration is lost the moment the lead context resets.

Chorus enforces all four. The spec below adds them to fireside on top of the existing schema using additive migrations and new hidden-block parsers, matching the style of the existing `mission-create` / `mission-phase` / `mission-plan` / `mission-task` / `mission-receipt` blocks.

## Non-goals

These are **deliberately out of scope** because they conflict with fireside's local-first, single-user posture:

- Multi-tenancy, OIDC, API keys, role-based admin separation. The "approver" in fireside is **the human user** (Matt) or an agent the human has explicitly designated as `verifierAgentId` for that task. There is no admin/superadmin tier.
- A separate "Companies / Project Groups / Projects" hierarchy. Fireside already has rooms and projects; that's enough.
- Web-based approval UI in this spec. The first cut is text-driven (hidden-block + chat command). A UI surface for approvals lands in a follow-up spec once the data model is proven.

## Sub-deliverable 1 — Proposal status state machine on `tasks`

**Schema.** Add three columns to `tasks` via `ALTER TABLE` migration (same pattern as `rooms.lead_agent_id` at `server/src/db.ts:488`):

```sql
ALTER TABLE tasks ADD COLUMN proposal_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE tasks ADD COLUMN verifier_agent_id TEXT;
ALTER TABLE tasks ADD COLUMN proposed_by_agent_id TEXT;
```

**State vocabulary:**

| Status | Meaning |
|---|---|
| `draft` | Task exists, plan/phases/checklist may exist, but it is not workable. Created when a `<!-- mission-create -->` block specifies `proposal: draft` (new field). Lead can iterate without dispatch firing. |
| `elaborating` | Lead has asked clarifying questions; awaiting human or designated answerer. Worker dispatch is blocked. |
| `proposed` | Lead has emitted a complete proposal (plan + phases + checklist + per-row ACs). Awaiting approval. Worker dispatch is blocked. |
| `approved` | Human (or an agent the human pre-authorised) has emitted a `<!-- mission-approve -->` block. Worker dispatch unblocks. |
| `executing` | At least one phase is `active` and at least one checklist item has been dispatched. Set automatically the first time a worker turn fires against the task. |
| `verifying` | Last checklist item has reached `done`. Awaiting AC verification (sub-deliverable 5). |
| `done` | All AC rows verified. Task closes. |
| `rejected` | Approver emitted `<!-- mission-approve action: reject -->`. Terminal. New mission needed. |

**Backward compatibility.** The `DEFAULT 'approved'` ensures every existing task is treated as already approved; nothing in the wild stalls. The new gate only kicks in for tasks that opt into the proposal flow by setting `proposal: draft` in their `mission-create` block.

**`tasks.status` vs `tasks.proposal_status`.** They are orthogonal. `status` tracks lifecycle (`active | paused | blocked | verifying | done`) and is set by the receipt applicator + lane planner. `proposal_status` tracks the gate the task is currently sitting at. Both must be writable by their respective code paths without stomping each other.

**Files touched:**
- `server/src/db.ts` — add the three `ALTER TABLE` statements to the migration block (line ~470 onward, matching existing pattern).
- `server/src/repos/tasks.ts` — extend `Task`, `TaskRow`, `CreateTaskInput`, `UpdateTaskInput`, `rowToTask`. Add `setProposalStatus(db, taskId, status, byAgentId): Task | null` helper; legalises only the documented transitions.

**Tests:**
- `server/tests/unit/repos/tasks-proposal-status.test.ts` — round-trip, default-on-existing-rows, `setProposalStatus` enforces legal transitions and rejects illegal ones (e.g. `done → draft`, `rejected → approved`).

## Sub-deliverable 2 — Structured Acceptance Criteria table

**Schema.** New table:

```sql
CREATE TABLE IF NOT EXISTS task_acceptance_criteria (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  doer_agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  doer_check_status TEXT NOT NULL DEFAULT 'pending',
  doer_check_evidence TEXT NOT NULL DEFAULT '',
  doer_check_at INTEGER,
  doer_check_by_agent_id TEXT,
  verifier_check_status TEXT NOT NULL DEFAULT 'pending',
  verifier_check_evidence TEXT NOT NULL DEFAULT '',
  verifier_check_at INTEGER,
  verifier_check_by_agent_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acceptance_criteria_task ON task_acceptance_criteria(task_id, sort_order);
```

**Status vocabulary** (per-AC and per-side):
- `pending` — not yet evaluated.
- `pass` — pass evidence recorded.
- `fail` — fail evidence recorded; task cannot reach `done`.

**AC-level `status` derivation rule** (computed in `recomputeAcceptanceStatus`, not stored derived):
- Both sides `pass` → AC `pass`.
- Either side `fail` → AC `fail`.
- Otherwise → AC `pending`.

**Migration of legacy `tasks.acceptance_criteria` blob.** Don't auto-split it. The blob remains. New tasks created via the proposal flow start with rows; legacy tasks created without ACs stay row-less and continue to use the blob for human-readable display. A one-shot migration script can be added later if needed.

**Files touched:**
- `server/src/db.ts` — `CREATE TABLE` + index in the schema block.
- New: `server/src/repos/acceptance-criteria.ts` (~250 LOC) — CRUD: `createAcceptanceCriterion`, `listAcceptanceCriteria(db, taskId)`, `updateAcceptanceCriterion`, `recordDoerCheck`, `recordVerifierCheck`, `recomputeAcceptanceStatus`, `allCriteriaPassed(db, taskId): boolean`.

**Tests:**
- `server/tests/unit/repos/acceptance-criteria.test.ts` — CRUD round-trips; status derivation rules at all 9 (doer × verifier) combinations; `allCriteriaPassed` returns false when any AC is pending or fail; `ON DELETE CASCADE` on task deletion.

## Sub-deliverable 3 — Clarifying-question loop

**Schema.** New table:

```sql
CREATE TABLE IF NOT EXISTS task_clarifying_questions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'general',
  question TEXT NOT NULL,
  asked_by_agent_id TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  answered_by TEXT NOT NULL DEFAULT '',
  answered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clarifying_questions_task ON task_clarifying_questions(task_id, sort_order);
```

**Categories** (lightweight free-string with a recommended set):
`scope`, `data-model`, `acceptance`, `out-of-scope`, `risk`, `general`.

**Behaviour.** While `proposal_status = 'elaborating'`, the lead emits one or more `<!-- mission-clarify -->` blocks (sub-deliverable 6). Each unanswered question keeps the task in `elaborating`. The human (or an agent the human designates) answers in chat by sending one or more `<!-- mission-clarify -->` blocks of action `answer`. When all open questions have non-empty `answer`, the lead must transition the task to `proposed` (its next turn).

**Files touched:**
- `server/src/db.ts` — `CREATE TABLE` + index.
- New: `server/src/repos/clarifying-questions.ts` (~150 LOC) — CRUD; `openQuestions(db, taskId)`; `answerQuestion(db, questionId, answer, answeredBy)`.

**Tests:**
- `server/tests/unit/repos/clarifying-questions.test.ts` — CRUD; `openQuestions` filters by empty answer; cascade delete.

## Sub-deliverable 4 — Approval gate in the dispatch path

**The single rule.** No worker turn dispatches against a task whose `proposal_status` is not in `{approved, executing, verifying}`. This is the gate.

**Where to enforce.** The dispatch path runs through `server/src/orchestration/work-lane-planner.ts`. Add a precheck at the top of `planAgentWorkLane` (or whichever helper picks the next dispatchable item) that returns "no work" with a structured reason when the task is in `draft | elaborating | proposed | rejected | done`. The lead is exempt — leads must keep running so they can drive the elaboration → propose → approve loop.

**Lead vs worker check.** Use the existing `room.leadAgentId` comparison already in use at `server/src/orchestration/agent-turn-context.ts`. If `agentId === room.leadAgentId`, the gate is bypassed. Otherwise it applies.

**Auto-transition `approved → executing`.** Set when the first worker turn dispatches against an approved task. Idempotent. Done in the same precheck path that bumps the lane.

**Auto-transition to `verifying`.** When the receipt applicator closes the last `task_checklist_items` row to `done` (or `skipped`), and `allCriteriaPassed` is false (i.e. there are AC rows still `pending`), set `proposal_status = 'verifying'`. Existing `phase-completion` already runs after each receipt; the cleanest spot is the tail of `reconcileMissionState` at `server/src/mission-state/mission-receipt-applicator.ts:163`.

**Auto-transition to `done`.** When `allCriteriaPassed(db, taskId)` becomes true. Same hook.

**Files touched:**
- `server/src/orchestration/work-lane-planner.ts` — precheck on task `proposal_status`; emit a typed `LaneBlockedReason = 'awaiting-approval' | 'awaiting-clarification' | 'rejected' | 'done'` when blocked so the broker can surface the reason in the working panel.
- `server/src/mission-state/mission-receipt-applicator.ts` — at the tail of `reconcileMissionState`, call `maybeAdvanceProposalStatus(db, taskId)` (new helper in `repos/tasks.ts`).
- `server/src/broker.ts` — when `LaneBlockedReason` is non-null, write a `kind: 'diagnostic'` run-action explaining why (matches existing diagnostic pattern around `mission receipt ignored` at `mission-receipt-applicator.ts:60`).

**Tests:**
- `server/tests/unit/orchestration/work-lane-planner-proposal-gate.test.ts` — gate blocks workers but lets leads through, for each blocked status; `executing` and `verifying` and `approved` all dispatch normally.
- `server/tests/integration/proposal-gate-end-to-end.test.ts` — full flow: create task with `proposal: draft`, lead emits clarifies, human answers, lead emits proposal, human approves, worker dispatches, AC verified end-to-end.

## Sub-deliverable 5 — Dual-path AC verification

**The contract.** Before a task can reach `proposal_status = 'done'`, every row in `task_acceptance_criteria` must have **both** `doer_check_status = 'pass'` and `verifier_check_status = 'pass'`. The two checks must be performed by **different agents** (or the verifier must be the human — `byAgentId = 'human'`).

**Doer self-check.** Recorded by the agent that closed the matching checklist item. Either:
- (a) Inferred from a `<!-- mission-receipt status: completed -->` block when its `item` ref maps via `task_checklist_items.acceptance_ref` to one or more AC rows — write `doer_check_status = 'pass'` and copy `summary + evidence` into `doer_check_evidence`. _(Schema note: add `acceptance_ref TEXT` to `task_checklist_items` so receipts can carry AC linkage. Optional column; null-safe.)_
- (b) Explicit, via a new `<!-- mission-verify side: doer -->` block (sub-deliverable 6).

**Verifier check.** Recorded **only** by `task.verifier_agent_id` or by a human (`agentId = 'human'`) and **never** by the doer. The applicator rejects a `<!-- mission-verify side: verifier -->` block if its author equals the AC's `doer_check_by_agent_id`. The rejection writes a diagnostic run-action and leaves the AC row untouched.

**Verifier assignment rules.**
1. If `task.verifier_agent_id` is set, that agent is the verifier. The human can pre-set this in the `mission-create` block.
2. If unset and the room has 2+ agents, the lead picks the verifier as part of the proposal (lead must be different from the doer of any given AC).
3. If unset and the room has only 1 agent, the human is the verifier by default. The doer cannot self-verify under any circumstance.

**Edge case: doer pass + verifier fail.** AC row goes to `fail`. Receipt applicator does NOT auto-revert checklist item from `done`. The verifier's fail evidence is the signal that work needs another loop; lead's next turn must either reopen the checklist item or address the verifier's evidence directly. (Decision deferred to lead, not codified.)

**Files touched:**
- `server/src/db.ts` — `ALTER TABLE task_checklist_items ADD COLUMN acceptance_ref TEXT;` (additive, null-safe).
- `server/src/repos/task-checklist.ts` — extend `TaskChecklistItem`, input/update types, row mapper.
- `server/src/repos/acceptance-criteria.ts` — `recordDoerCheck` and `recordVerifierCheck` enforce the doer ≠ verifier invariant.
- `server/src/mission-state/mission-receipt-applicator.ts` — when a receipt closes a checklist item with non-null `acceptance_ref`, fan out to `recordDoerCheck` for each referenced AC.
- New: `server/src/mission-state/mission-verify-applicator.ts` (~180 LOC) — applies parsed `<!-- mission-verify -->` blocks; handles doer/verifier branch; rejects same-agent verify; writes diagnostic run-actions on rejection.

**Tests:**
- `server/tests/unit/repos/acceptance-criteria-dual-path.test.ts` — same-agent verify rejected; doer pass + verifier pass advances AC to `pass`; doer pass + verifier fail leaves AC at `fail`.
- `server/tests/integration/dual-path-verify-end-to-end.test.ts` — task with 3 ACs goes through one verify-fail / fix / re-verify cycle and reaches `done`.

## Sub-deliverable 6 — MCP tools + HTTP human-approval routes + skill flow

**Five new MCP tools, mirroring the existing pattern at `server/src/tools/handlers/mission-receipt-tools.ts` and `server/src/tools/schemas/mission-receipt.ts`:**

### `mission.clarify.ask`
Lead asks a clarifying question against the active task.
- Args: `category` (`scope` | `data-model` | `acceptance` | `out-of-scope` | `risk` | `general`), `question` (required, non-empty).
- Required permission: `mission:write`.
- Effect: inserts a row in `task_clarifying_questions`. Returns the question id.

### `mission.clarify.answer`
The designated answerer answers an open clarifying question.
- Args: `questionId` (required), `answer` (required, non-empty).
- Caller may be any agent (the lead designates answerers via prompt convention — no DB-level allowlist for v1). Humans answer via the HTTP route below, not MCP.
- Effect: writes `answer` + `answered_at` + `answered_by` on the row.

### `mission.acceptance.create` / `.update` / `.reorder`
Lead manages AC rows on a task.
- `create`: `title` (required), `detail` (optional), `doer` (optional agent id), `sortOrder` (optional int — appended if absent).
- `update`: `id` (required), then any of `title` / `detail` / `doer`. Once the task is `approved`, updates are rejected by the handler (AC rows go append-only post-approval; future re-edits go via the verify path).
- `reorder`: `id` (required) + `sortOrder` (required).
- Required permission: `mission:write`.

### `mission.propose.submit`
Lead transitions the task `elaborating → proposed`.
- Args: none beyond context. Handler validates: all open questions answered, ≥1 AC row exists.
- Required permission: `mission:write`.
- Effect: `setProposalStatus(taskId, 'proposed', leadAgentId)`.

### `mission.verify`
Doer or verifier records a pass/fail check on an AC.
- Args: `side` (`doer` | `verifier`), `acId` (required), `status` (`pass` | `fail`), `evidence` (required, non-empty).
- Required permission: `mission:write`.
- Side-specific rules enforced by handler:
  - `side: doer` — caller must be the AC's resolved doer (or the agent that closed the linked checklist item if `acceptance_ref` was used).
  - `side: verifier` — caller must be `task.verifier_agent_id` and **must not equal** the AC's `doer_check_by_agent_id`. Same-agent verify rejected with a diagnostic.

### `mission.approve`
Pre-authorised approver agent (member of `room.approver_agent_ids`) approves / rejects / requests changes.
- Args: `action` (`approve` | `reject` | `request-changes`), `reason` (required for reject + request-changes).
- Required permission: `mission:admin`.
- Caller validation: caller's `agentId` must be in `room.approver_agent_ids`. Otherwise rejected with diagnostic.
- Humans approve via the HTTP route below, not MCP — humans don't have an `agentId` to call MCP with.

### HTTP human-approval routes
Two new routes register in `server/src/http-server.ts`:

```
POST /api/tasks/:id/approve         body: {}
POST /api/tasks/:id/reject          body: { reason: string }
POST /api/tasks/:id/request-changes body: { reason: string }
POST /api/clarifying-questions/:id/answer body: { answer: string }
```

These are loopback-trusted (same trust model as the existing `/api/rooms/:id` DELETE). They feed the **same applicator** (`mission-approve-applicator`) the MCP tool's handler does, with `byAgentId = 'human'` baked in. The Angular client gets buttons in the working panel that POST to these — separate UI spec, not in PR 2.

### Skill flow

New skill at `client/skills/mission-propose.md` (and corresponding lead-prompt edits in `server/src/orchestration/lead-rehydration.ts`):

1. Human writes a brief in chat.
2. Lead calls `mission.task.update` with `proposalStatus: 'draft'` to seed the task, then one or more `mission.acceptance.create` for ACs it can extract.
3. If anything is unclear, lead calls one or more `mission.clarify.ask` and **stops the turn**. Task remains in `elaborating` (set by the first `clarify.ask` handler if `proposal_status = 'draft'`).
4. Human (or designated answerer agent) answers — human via `POST /api/clarifying-questions/:id/answer`, agent via `mission.clarify.answer`.
5. Lead revises ACs via `mission.acceptance.update`, then calls `mission.propose.submit`. Task → `proposed`.
6. Human approves via `POST /api/tasks/:id/approve` (or pre-authorised approver agent calls `mission.approve`). Task → `approved`. Worker dispatch unblocks.
7. Workers execute. Receipts close checklist items, which fan out to `doer_check`s on linked ACs (via `acceptance_ref`).
8. Verifier calls `mission.verify side: 'verifier'` per AC.
9. When all ACs pass, task auto-transitions to `done`.

**Files touched:**
- New: `server/src/tools/schemas/mission-clarify.ts` (~80 LOC).
- New: `server/src/tools/schemas/mission-acceptance.ts` (~100 LOC).
- New: `server/src/tools/schemas/mission-propose.ts` (~40 LOC).
- New: `server/src/tools/schemas/mission-verify.ts` (~70 LOC).
- New: `server/src/tools/schemas/mission-approve.ts` (~70 LOC).
- New: `server/src/tools/handlers/mission-clarify-tools.ts` (~120 LOC) — `mission.clarify.ask`, `mission.clarify.answer`.
- New: `server/src/tools/handlers/mission-acceptance-tools.ts` (~180 LOC) — `mission.acceptance.create`, `.update`, `.reorder`.
- New: `server/src/tools/handlers/mission-propose-tools.ts` (~80 LOC) — `mission.propose.submit`.
- New: `server/src/tools/handlers/mission-verify-tools.ts` (~150 LOC) — wraps `mission-verify-applicator`.
- New: `server/src/tools/handlers/mission-approve-tools.ts` (~150 LOC) — wraps `mission-approve-applicator`.
- New: `server/src/mission-state/mission-verify-applicator.ts` — already counted in sub-deliverable 5.
- New: `server/src/mission-state/mission-approve-applicator.ts` (~120 LOC).
- `server/src/tools/default-tools.ts` — register the new tool arrays.
- `server/src/http-server.ts` — add 4 HTTP routes that delegate to the applicators.
- `server/src/orchestration/lead-rehydration.ts` — carry proposal status + open clarifying questions in the checkpoint.
- New: `client/skills/mission-propose.md` — the skill the lead loads when `proposal_status = 'draft'`.

**Tests:**
- One unit spec per schema (`server/tests/unit/tools/schemas/mission-{clarify,acceptance,propose,verify,approve}-schema.test.ts`) — happy path + malformed input rejection.
- One unit spec per handler (same naming pattern under `server/tests/unit/tools/handlers/`) covering CRUD + permission + state-machine guards.
- One unit spec per applicator under `server/tests/unit/mission-state/`.
- `server/tests/integration/mission-proposal-flow.test.ts` — the full Idea → clarify → AC → propose → approve → execute → dual-path verify → done loop end-to-end against a fresh in-memory DB.
- `server/tests/integration/human-approval-http.test.ts` — POST /api/tasks/:id/approve flips proposal_status with `byAgentId = 'human'` and unblocks dispatch.

## File touch summary

| File | Change |
|---|---|
| `server/src/db.ts` | 3 `ALTER TABLE tasks` columns; 1 `ALTER TABLE rooms` column; 1 `ALTER TABLE task_checklist_items` column; 2 new `CREATE TABLE`s |
| `server/src/repos/tasks.ts` | Extend types + `setProposalStatus` + `maybeAdvanceProposalStatus` helpers |
| `server/src/repos/task-checklist.ts` | Add `acceptance_ref` to types/row-mapper |
| `server/src/repos/acceptance-criteria.ts` | New module — CRUD + dual-path check helpers |
| `server/src/repos/clarifying-questions.ts` | New module — CRUD + open-questions helper |
| `server/src/repos/rooms.ts` | Add `approver_agent_ids` JSON-array column (additive) |
| `server/src/tools/schemas/mission-clarify.ts` | New schema |
| `server/src/tools/schemas/mission-acceptance.ts` | New schema |
| `server/src/tools/schemas/mission-propose.ts` | New schema |
| `server/src/tools/schemas/mission-verify.ts` | New schema |
| `server/src/tools/schemas/mission-approve.ts` | New schema |
| `server/src/tools/handlers/mission-clarify-tools.ts` | New handler — `mission.clarify.ask` + `.answer` |
| `server/src/tools/handlers/mission-acceptance-tools.ts` | New handler — `mission.acceptance.create` + `.update` + `.reorder` |
| `server/src/tools/handlers/mission-propose-tools.ts` | New handler — `mission.propose.submit` |
| `server/src/tools/handlers/mission-verify-tools.ts` | New handler — wraps `mission-verify-applicator` |
| `server/src/tools/handlers/mission-approve-tools.ts` | New handler — wraps `mission-approve-applicator` |
| `server/src/tools/default-tools.ts` | Register the 5 new tool arrays |
| `server/src/mission-state/mission-verify-applicator.ts` | New applicator |
| `server/src/mission-state/mission-approve-applicator.ts` | New applicator |
| `server/src/mission-state/mission-receipt-applicator.ts` | Fan out to `recordDoerCheck` when receipt closes a checklist item with `acceptance_ref`; tail-call `maybeAdvanceProposalStatus` |
| `server/src/orchestration/work-lane-planner.ts` | Proposal-gate precheck + `LaneBlockedReason` typing |
| `server/src/orchestration/lead-rehydration.ts` | Carry proposal status + open clarifying questions in the checkpoint |
| `server/src/http-server.ts` | 4 new routes for human approval / clarification answer |
| `server/src/broker.ts` | Surface `LaneBlockedReason` as run-action diagnostic |
| `client/skills/mission-propose.md` | New skill |
| `client/app/...` (deferred) | Working panel surfaces clarify/approve/verify states — separate UI spec |

**Estimated diff:** ~1500 LOC production + ~1200 LOC tests across two PRs (PR 1: schema + repos + tool schemas + CRUD handlers; PR 2: applicators + state-machine handlers + dispatch gate + HTTP routes + skill + integration tests). No data migration required — every change is additive with safe defaults.

## Acceptance criteria (this spec, recursively)

1. A task created with `<!-- mission-create proposal: draft -->` cannot dispatch a worker until a `<!-- mission-approve action: approve -->` block from the human (or an `approver_agent_ids` member) lands.
2. Open clarifying questions block the task from advancing to `proposed` and survive a lead reset (the rehydration checkpoint carries them).
3. AC rows record both doer and verifier checks; an AC cannot reach `pass` without both sides; the same agent cannot be both sides.
4. A task auto-transitions through `approved → executing → verifying → done` without manual nudging when all ACs pass.
5. Existing tasks (with `proposal_status = 'approved'` by default) continue to dispatch normally — the gate is opt-in and backward-compatible.
6. Every new parser has a unit test covering happy path + malformed input.
7. End-to-end integration test exercises the full Idea → Q&A → Proposal → Approve → Execute → Dual-path Verify → Done loop without manual DB edits.

## Open questions — resolved 2026-05-09

1. **Proposal status transition syntax.** ✅ Dedicated `mission.propose.submit` MCP tool. Distinct audit trail and grep-able.
2. **Per-AC vs per-checklist linkage cardinality.** ✅ Single-ref `task_checklist_items.acceptance_ref` for v1. Join table deferred until observed need.
3. **Verifier reuse across phases.** ✅ `verifier_agent_id` on `tasks` for v1. Per-AC verifiers deferred to v2.
4. **Human approval identity.** ✅ Humans don't drive MCP — they go through the new HTTP routes (`POST /api/tasks/:id/approve` etc.) which feed the same applicator with `byAgentId = 'human'`. No `agentId = 'human'` plumbing required in the MCP handler path.
5. **Legacy `tasks.acceptance_criteria` blob.** ✅ When a task has rows in `task_acceptance_criteria`, the blob is treated as legacy display-only. Blob stays in the DB for tasks that never opt in.
6. **Reviewer-agent skill.** Defer — `client/skills/mission-verify.md` will be specced as a follow-up doc once PR 2 lands and we have a verifier-agent run to observe.
7. **Reject + restart.** ✅ Terminal in v1. Carry-forward is a usability follow-up.
8. **Lead exemption.** ✅ `room.leadAgentId` is the source of truth. No edge case in the current dispatch path treats a worker as the lead.

## Sequencing recommendation

**PR 1 (schema + repos + tool schemas + CRUD handlers)** — sub-deliverables 1, 2, 3, plus the schemas + CRUD-only handlers from 6 (`mission.clarify.ask` / `.answer`, `mission.acceptance.create` / `.update` / `.reorder`). Lands as a no-op release for existing tasks (`proposal_status` defaults to `'approved'`). New tools work — agents can populate the new tables — but nothing reads `proposal_status` for gating yet.

**PR 2 (gate + applicators + state-machine handlers + HTTP + skill)** — sub-deliverables 4, 5, plus `mission.propose.submit`, `mission.verify`, `mission.approve` handlers, the applicators they wrap, the 4 HTTP routes, and the skill. Cuts in the actual gate behind the opt-in `proposalStatus: 'draft'` flag in `mission.task.update`.

**PR 3 (UI surface)** — separate spec. Surfaces clarify / approve / verify state in the working panel; adds the buttons that POST to the human-approval routes.
