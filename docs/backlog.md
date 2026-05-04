# Fireside Backlog

## Pending

No queued implementation items.

## Completed 2026-05-03

### Add explicit room team lead routing

Problem:
- Broker/system events that need agent repair work, such as empty-phase YOLO launch blockers,
  previously chose a "lead-style" agent by persona priority only.
- That made room coordination implicit and brittle when Matt had already chosen a project manager,
  engineering manager, or other named coordinator for the team.

Remediation:
- Rooms now persist an optional `leadAgentId`, exposed through state snapshots and the room create/edit
  APIs.
- The create-room and edit-agents modals can mark exactly one participant as the team lead, and the
  agent rail shows a compact `lead` marker.
- Agent prompts identify the room team lead and explain that broker/system coordination requests may be
  routed there first, while still requiring exact `@handle` mentions for execution handoffs.
- Empty-phase YOLO blocker repair now targets the explicit lead first when that agent is present and
  idle, then falls back to the existing project-manager/engineering-manager/QA priority list.

Verification:
- Client build, server build, and full Vitest suite pass.
- Focused room-repo, transcript, human-message-router, and broker integration coverage verifies lead
  persistence, prompt text, and explicit-lead repair routing.

### Tighten autonomous launch, handoff, identity, and Gemini telemetry

Problem:
- Empty open phases correctly blocked YOLO launch, but the system only appended a passive system
  message, leaving the team idle instead of assigning somebody to repair the mission structure.
- Agent prompts still allowed plain-name handoffs, which can fail to wake the intended agent when
  routing depends on exact `@handles`.
- Multiple agents, or an agent and the human, could share confusing display names or route handles.
- Gemini stream-json stats contained useful token telemetry that Fireside was not surfacing.

Remediation:
- Blocked YOLO launches now dispatch one idle lead-style repair turn using deterministic priority:
  project manager, engineering manager, QA lead, technical lead, product manager, principal
  engineer, then first idle agent.
- Agent prompts now list each recipient's exact `@handle` and explicitly tell agents that plain
  names are conversational only.
- New/edit agent flows and the HTTP room endpoints validate case-insensitive display names and
  route handles against both agents and the current human name.
- Gemini result events now parse `stats.usage_metadata` and legacy `stats.models.*.tokens` into
  provider context usage actions.

Verification:
- Focused transcript, Gemini adapter, rooms/profile, and broker integration tests pass.
- Full typecheck passes.

### Add provider scoring foundation for persona/team selection

Problem:
- Team templates and persona dispatch need provider guidance that is more concrete than "use the
  strongest model everywhere."
- Quota, authentication, recent failures, and existing team composition all matter when assigning
  work to Claude, Codex, Gemini, or future providers.

Remediation:
- Added a pure provider scoring module that ranks available providers for a persona slot.
- The scorer combines persona capability tags, default provider preferences/fallbacks, static
  provider capability priors, live health inputs, quota pressure, recent failure rate, and
  current team provider counts.
- Results are explainable: every candidate includes selected state, score, capability score,
  normalized health, reasons, and warnings so UI/team builders can show why a provider was chosen.
- Prompt generation keeps stable agent ids machine-readable for dispatch while reinforcing given
  names as the visible chat identity.

Verification:
- Added focused provider-scoring unit coverage for UX, engineering, QA, quota, failure, and team
  saturation scenarios.
- Full Vitest, typecheck, server build, and diff whitespace checks pass.

### Wire provider scoring into agent-team selection

Problem:
- The provider scorer existed as a backend utility, but the create/edit agent flows still left the
  human to manually infer which provider fit each persona.
- The team builder needed quota-aware guidance without silently overriding the user's provider
  choices.

Remediation:
- Added `POST /api/agents/provider-score`, returning explainable recommendations for draft persona
  slots with current team saturation, live quota telemetry, and recent provider failure rate folded
  into the score. Context telemetry is returned for visibility but is not scored.
- The new-mission and edit-agents dialogs now request scores for their draft rows and render a
  compact recommendation strip per agent.
- Recommendations show the selected provider, top reasons/warnings, and a one-click `use <provider>`
  action when the recommendation differs from the current row.

Verification:
- Added HTTP coverage for provider recommendations and team-saturation routing.
- Full Vitest, typecheck, server/client builds, and diff whitespace checks pass. The Angular client
  build still reports the existing bundle budget warning.

### Recalibrate provider scoring from frontier-model syntheses

Problem:
- The first provider priors were reasonable but too coarse: they treated provider fit mostly as
  broad coding/planning/UX strength.
- Matt added `docs/synthesis-opus-47.md`, `docs/synthesis-gpt-55.md`,
  `docs/synthesis-gemini-31-pro.md`, and `docs/routing-matrix.md`, which contain more concrete
  routing evidence and model-specific caveats.

Remediation:
- Expanded scoring dimensions for autonomous tool loops, MCP-heavy work, exact retrieval,
  web/source synthesis, knowledge-work deliverables, low-cost background analysis, latency,
  SQL/data reasoning, schema reliability, multimodal input, scientific reasoning, and mission
  receipt reliability.
- Reweighted provider priors from the routing evidence: Claude/Opus stronger for hard multi-file
  engineering, long autonomous loops, MCP orchestration, long fuzzy synthesis, knowledge work, and
  mission-receipt reliability; Codex/GPT stronger for exact retrieval, source synthesis, SQL/data,
  schema reliability, latency-critical work, and scoped code review; Gemini stronger for
  cost-efficient background analysis, multimodal/visual inputs, broad ideation, and scientific or
  abstract reasoning while weaker for repo-scale agentic loops, SQL, and schema-sensitive work.
- Updated persona capability tags so team recommendations have more meaningful lane-specific
  rationale instead of generic provider stereotypes.

Verification:
- Added provider-scoring tests for source synthesis/exact retrieval, autonomous tool loops,
  multimodal low-cost work, and SQL/data lanes.

### Make provider quota scoring reset-horizon aware

Problem:
- Provider scoring used quota percentage as a mostly flat penalty.
- That made `80% used / resets in 8 hours` look worse than it should, and failed to distinguish it
  from `50% used / resets in 5 days`, which is strategically more dangerous.

Remediation:
- Provider health now carries five-hour and seven-day reset timestamps/window sizes into the scorer.
- Quota scoring computes a pressure value from usage percent, remaining reset horizon, and projected
  burn rate across the window.
- The scorer now treats high usage close to reset as manageable, while penalizing moderate usage
  early in a long window when projected burn suggests the quota will run out.

Verification:
- Added deterministic provider-scoring coverage proving an `80% / resets in 8h` provider can still
  beat a `50% / resets in 5d` provider when capabilities are comparable.

### Explain provider recommendation tradeoffs

Problem:
- A persona slot such as `Quality Assurance Engineer` could recommend Claude even though Codex has
  the stronger static QA prior.
- The recommendation was technically correct when live health was bad, but the UI only showed why
  the winner won, not why the current provider lost.
- Stale quota reset timestamps could also look like unknown reset pressure after the window had
  already expired.

Remediation:
- Expired quota reset windows now drop out of quota-pressure scoring instead of becoming an
  "unknown reset" penalty.
- Provider recommendation cards now include a compact "current <provider>" rationale when the
  selected provider differs from the recommended one, including health warnings such as recent
  failures, quota pressure, or provider availability.

Verification:
- Full Vitest, server build, client build, and diff whitespace checks pass. The Angular client build
  still reports the existing bundle budget warning.

### Remove context pressure from provider scoring

Problem:
- Context window occupancy was too weak a signal for provider choice because agents can compact and
  continue.
- Using context pressure in recommendations could steer away from a capable provider for a condition
  that should be handled operationally by compaction instead of provider routing.

Remediation:
- Provider scoring still normalizes and returns context telemetry for human visibility.
- Context no longer changes provider score and no longer appears in recommendation reasons or
  warnings.

Verification:
- Added provider-scoring coverage proving a high-context Codex QA slot is still selected when its
  capability fit is strongest and no stronger health signal says otherwise.

### Add dedicated UX personas

Problem:
- The existing agent roster had strong product, engineering, QA, and reviewer personas, but only a
  lightweight UX/accessibility lens.
- Matt needs a UX-focused team that can take a functional product and push it toward a clearly
  excellent user-facing experience instead of merely applying generic UI patterns.

Remediation:
- Added `UX Architect` for end-to-end experience architecture, design-language direction,
  information architecture, state models, accessibility baseline, and UX phase gates.
- Added `UX Researcher` for user/job/task framing, assumption tracking, research questions,
  usability activities, and evidence-backed UX requirements.
- Added `Interaction Designer` for workflows, affordances, controls, microinteractions,
  interruption/recovery, responsive behavior, focus order, and state visibility.
- Added `Visual Design Systems Designer` for typography, spacing, color roles, iconography,
  component states, motion, density, tokens, and cohesive visual-language application.

Verification:
- Persona unit coverage proves all four roles exist and retain key prompt commitments.
- Full Vitest, typecheck, server build, and diff whitespace checks pass.

### Extract routing decision modules from the broker

Problem:
- Human-message routing, explicit mentions, room-level YOLO startup, queueing, and agent handoffs
  were interleaved inside `server/src/broker.ts`.
- A failure such as `@jimmy` not waking Jimmy or Jimmy not waking Sean required reading the broker's
  whole control flow instead of testing the routing branch in isolation.

Remediation:
- Added `server/src/routing/agent-references.ts` for room-local agent reference resolution.
- Added `server/src/routing/human-message-router.ts` for pure human-message dispatch decisions:
  direct agent turn, group discussion, YOLO startup, queue, or append-only.
- Added `server/src/routing/agent-message-router.ts` for pure agent-to-agent handoff decisions.
- The broker now logs structured `human message routing decision` and `agent message routing decision`
  entries with action, reason, responders, references, ambiguity, and rule trace data.
- Ambiguous generic aliases no longer cancel an otherwise unambiguous room-local target. For example,
  a message that clearly targets Sean can still wake `claude-technical-lead` even if generic
  `Claude` is ambiguous elsewhere in the same message.

Verification:
- Added focused unit coverage for human routing and agent handoff routing.
- Focused routing and broker integration suites pass.

### Extract mission work dispatch decisions from the broker

Problem:
- Agents can create or update checklist items assigned to another room participant without saying
  that participant's name in visible chat.
- Before this slice, that meant the assigned owner might sit idle until a human or another agent
  manually prodded them, even though Mission Control had enough structured state to route the work.
- The decision was hard to inspect because owner eligibility, active jobs, dependencies, and YOLO
  lane assignment were embedded in the broker loop.

Remediation:
- Added `server/src/routing/mission-work-router.ts` as a pure decision module for newly available
  assigned checklist work.
- The router evaluates assigned owner, room membership, self-authored work, busy agents, active item
  jobs, closed status, and unfinished dependencies, returning dispatches plus rule traces.
- `applyMissionTaskUpdates` now returns changed open owned items as dispatch candidates.
- The broker logs structured `mission work routing decision` entries and records a `mission work
  dispatch` run action when assigned work wakes another agent.
- The discussion loop carries those dispatches into the next round as explicit work lanes, so the
  owner receives an `Assigned item:` prompt even without a visible chat handoff.

Verification:
- Added unit coverage for the mission-work router.
- Added broker integration coverage for a planner creating assigned work and the assigned owner
  waking, receiving the work lane, and completing the checklist item.
- Focused routing/broker suites, typecheck, and server build pass.

### Extract discussion thread scheduling from the broker

Problem:
- The broker still owned the turn scheduler inline: eligible agents, per-agent reply counts,
  total YOLO budget, quarantines, directed handoffs, work dispatches, and next-round candidates.
- That made failures like "the agent said the next owner should work but nobody woke" hard to
  audit because message routing, provider execution, and scheduling were intertwined.

Remediation:
- Added `server/src/orchestration/discussion-scheduler.ts` for deterministic discussion scheduling.
- The scheduler now owns:
  - initial responder/handoff-pool setup
  - current per-agent and total budgets, including live YOLO budget expansion
  - round eligibility
  - reply-count accounting
  - YOLO failure quarantine
  - visible handoff and hidden work-dispatch next-candidate decisions
  - idle/no-progress stop decisions
- The broker remains responsible for DB reads/writes, lane conflict checks, prompt building,
  provider execution, run actions, and starting nested room-level YOLO handoffs.
- Work dispatches are now considered even when the creating agent emits only hidden mission blocks
  and no visible chat message.

Verification:
- Added scheduler unit coverage for budget slicing, normal rotation, hidden work dispatch,
  directed YOLO splits, YOLO quarantine, idle stop, and live budget expansion.
- Tightened broker integration coverage so hidden-only assigned checklist work wakes the owner.
- Focused scheduler/routing/broker suites, typecheck, and server build pass.

### Extract work-lane planning from the broker

Problem:
- The board parallelism matrix, YOLO lane assignment, dependency readiness, active-job conflicts,
  expected-touch overlap checks, and conflict-group rules were split between UI-facing snapshots and
  broker dispatch loops.
- That made it hard to validate whether agents could safely run in parallel without replaying a full
  broker turn.

Remediation:
- Added `server/src/orchestration/work-lane-planner.ts` as the pure planner for checklist readiness,
  scope contracts, conflict reasons, pairwise parallelism cells, phase-scoped summaries, and YOLO lane
  assignment proposals.
- The broker now asks the planner for owner updates and lane assignments, then performs the DB writes
  and event emission itself.
- Board parallelism and autonomous dispatch now share the same conflict semantics.

Verification:
- Added focused work-lane planner unit coverage for ownership priority, busy/active exclusions,
  unfinished dependencies, expected-touch overlap, shared conflict groups, and phase-scoped summaries.
- Focused orchestration/routing/broker suites, typecheck, and server build pass.

### Extract mission task state application from the broker

Problem:
- Hidden `/mission-task` blocks directly mutated checklist rows, notes, phase/plan associations, and
  council-blocked mission state inside `broker.ts`.
- Failures such as unresolved plan references or inferred completion status were difficult to test
  without running a full agent turn.

Remediation:
- Added `server/src/mission-state/mission-state-helpers.ts` for shared checklist/phase/plan
  reference resolution, dependency resolution, completion inference, and note-kind selection.
- Added `server/src/mission-state/mission-task-applicator.ts` to apply parsed mission task updates
  against the database while exposing dispatch candidates for newly open owned work.
- The broker delegates task update application to that module and remains responsible for surrounding
  prompt/run orchestration.

Verification:
- Added database-level applicator tests for item creation, notes, dispatch candidates, council blocks,
  and plan/phase mismatch diagnostics.
- Added pure resolver tests for normalized phase refs, active plan aliases, dependency dedupe, and
  completion inference.
- Focused orchestration/routing/broker suites, typecheck, and server build pass.

### Extract permission continuation orchestration

Problem:
- YOLO permission profile normalization, grant construction, and "auto-continue vs wait for human"
  decisions were embedded in the broker's permission-request branch.
- That made the expected behavior for request-in-YOLO hard to reason about and easy to regress while
  fixing normal permission cards.

Remediation:
- Added `server/src/orchestration/permission-orchestrator.ts`.
- The module owns inline YOLO profile detection, normalized YOLO permission profiles, YOLO grant
  construction, room-level YOLO grants, and the continuation decision for permission requests.
- The broker still stores permission requests, updates run state, emits cards, and invokes follow-up
  turns, but the permission policy is now testable without DB or provider execution.

Verification:
- Added unit coverage for inline YOLO inference, default profile normalization, task/room grant
  construction, manual permission waits, YOLO auto-followups, and the auto-approval safety limit.
- Existing permission parser tests and broker YOLO permission integration tests pass.

### Extract run activity policy from the broker

Problem:
- Provider stream signal throttling, duplicate suppression, low-signal filtering, lifecycle signal
  updates, and heartbeat wording/stall detection were inline with broker timers and DB writes.
- That made the working-run visibility layer hard to tune without touching provider execution flow.

Remediation:
- Added `server/src/orchestration/run-activity.ts`.
- The module turns provider stream events into lifecycle updates and optional run actions, applying
  message throttling, duplicate suppression, and existing provider-signal visibility rules.
- The module also owns heartbeat detail/stall calculations; the broker keeps timer scheduling, lease
  renewal, run updates, and action persistence.

Verification:
- Added unit coverage for visible provider message extraction, noisy duplicate suppression, and
  heartbeat/stall detail calculation.
- Existing lifecycle and provider-signal tests continue to pass.

### Extract provider-turn execution from the broker

Problem:
- `runAgentReply` still directly owned abort-controller wiring, heartbeat cleanup, provider
  invocation, YOLO timeout uncapping, cancellation classification, raw error capture, and YOLO retry
  decisions.
- This made retry/cancel behavior hard to test without a full broker run.

Remediation:
- Added `server/src/orchestration/agent-turn-executor.ts`.
- The executor owns one provider call boundary: register/unregister abort controller, start/stop
  heartbeat, relay cancellation, invoke the provider runner, pass `timeoutMs = null` for YOLO
  permission turns, extract stdout/stderr from thrown provider errors, classify cancellations, and
  compute YOLO retry decisions.
- The broker still persists the run/job outcome, records diagnostics/actions, schedules retry delay,
  and parses successful replies.

Verification:
- Added executor unit coverage for success cleanup, YOLO timeout uncapping, provider failure retry
  decisions, and raw stdout/stderr extraction.
- Full Vitest, typecheck/server build, and diff whitespace checks pass.

### Extract remaining mission state applicators

Problem:
- `/mission-plan`, `/mission-phase`, `/mission-create`, mission receipts/reconciliation, and
  `/collab-note` storage were still implemented inline in `broker.ts`.
- These paths are core to Mission Control accuracy, so they need focused tests independent of agent
  subprocess execution.

Remediation:
- Added mission-state applicators:
  - `mission-create-applicator.ts`
  - `mission-plan-applicator.ts`
  - `mission-phase-applicator.ts`
  - `mission-receipt-applicator.ts`
  - `collaboration-note-applicator.ts`
- Receipt reconciliation now lives beside the other mission state code: item/phase receipt
  resolution, assigned-lane visible-text reconciliation, checklist-derived phase close, phase
  auto-advance, and receipt detail formatting.
- The broker now delegates hidden-block state changes to these modules and remains the side-effect
  shell for dispatching follow-ups and emitting higher-level run flow.

Verification:
- Added applicator coverage for plan creation, first-phase activation, receipt-driven checklist
  completion, checklist notes, and collaboration note storage.
- Full Vitest, typecheck/server build, and diff whitespace checks pass.

### Extract agent prompt/context assembly

Problem:
- Prompt construction mixed transcript selection, context-file generation, active mission context,
  recent runs/messages, collaboration ledger, effective permission selection, workflow profiles, and
  session resume lookup directly into `runAgentReply`.
- That made context-bloat and "what did this agent see?" bugs harder to inspect.

Remediation:
- Added `server/src/orchestration/agent-turn-context.ts`.
- The new assembler owns prompt history selection, optional context-file writing, active mission
  prompt context, collaboration ledger injection, task/workflow/YOLO permission selection, workflow
  profile prompt wiring, prompt stats, live-message character accounting, artifact counts, and
  resumable session lookup.
- The broker now consumes the prepared context, records read receipts/actions, creates the job/run,
  and executes the provider turn.

Verification:
- Added unit coverage proving active task context, task-scoped permission grants, prompt stats, and
  session-resume behavior are assembled in the new module.
- Full Vitest, typecheck/server build, and diff whitespace checks pass.

### Add backend orchestration diagnostics

Problem:
- Long autonomous missions need backend explanations for "what state is this run actually in?",
  "why was this message routed or queued?", and "what hidden command did the agent emit?"
- Before this pass, some of that information was available only in logger output or mixed into
  run actions.

Remediation:
- Added `server/src/orchestration/run-state-machine.ts`, a higher-level job/run execution model
  that infers queued, leased, running, waiting-on-permission, retrying, completed, failed, canceled,
  dismissed, or superseded state from the durable job/run rows.
- Added `routing_decisions` plus `/api/rooms/:id/routing-decisions`; human routing, agent handoff
  routing, and mission-work routing now persist action, reason, responders, and rule trace.
- Added `mission_command_events` plus `/api/rooms/:id/mission-command-events`; parsed mission
  create/plan/phase/task/receipt and roster commands now leave a durable applied/rejected/reconciled
  event trail.
- Run detail responses now include the inferred execution snapshot.

Verification:
- Added focused repository/state-machine coverage for run execution, routing decision persistence,
  and mission command event persistence.
- Full Vitest, typecheck, server build, client build, and diff whitespace checks pass.

### Add provider contract fixtures and replay harness

Problem:
- Provider adapters are the fragile boundary of the harness. We need to prove parser behavior from
  saved CLI output without launching Claude/Codex/Gemini or burning quota.
- Prompt budget truncation also needed richer diagnostics than a few dropped-message counters.

Remediation:
- Added `server/src/agents/provider-events.ts`, which normalizes provider stream events into a
  shared contract: assistant message, tool use, context usage, quota update, command started,
  command finished, lifecycle, stderr, error, or unknown, with low-signal classification.
- Added provider stream fixtures for Claude and Gemini alongside the existing Codex JSONL fixture.
- Added `server/src/simulation/run-replay.ts`, which can replay saved provider stdout/stderr
  through the real provider parser and normalized event contract, and replay an agent reply through
  hidden-block extraction without mutating database state.
- Extended prompt stats with detail level, over-budget chars, budget notices, available/included/
  dropped history counts, and original vs final latest-message length. Prompt-prepared run actions
  now store those diagnostics as JSON.

Verification:
- Added provider event contract tests and run replay tests.
- Existing provider conformance, transcript, and agent-context tests continue to pass.
- Full Vitest, typecheck, server build, client build, and diff whitespace checks pass.

### Add autonomous mission liveness and turn outcomes

Problem:
- Agents can complete planning or status-reporting turns, leave assigned checklist work ready for
  another owner, and then go quiet because no visible handoff text was emitted.
- Run timelines showed raw events, but they did not persist a compact "what did this turn do?"
  record that later orchestration, debugging, or UI views could query directly.
- Autonomous regressions were still mostly proven through full broker tests, which made it harder to
  replay the exact classes of failures seen in long YOLO dogfooding sessions.

Remediation:
- Added `agent_turn_outcomes` plus repository/API support. Each run can now persist a durable turn
  summary: terminal status, whether it progressed work, failure/error text, mission command counts,
  receipt/reconciliation counts, draft/permission metadata, work dispatches, next agents, and a
  compact summary.
- Added `server/src/orchestration/liveness-policy.ts`, a pure mission liveness evaluator for
  coordinator-style turns. It inspects active mission state, open checklist ownership, dependencies,
  active jobs, and recent outcomes, then chooses `dispatch-ready-work`, `wait-for-agent`,
  `wait-for-human`, `needs-assignment`, `mission-complete`, or `idle`.
- The broker records a `mission liveness decision` run action and durable `routing_decisions` row
  when liveness evaluates a turn. Ready assigned work can now wake its owner even when the
  coordinator/planner did not explicitly mention that owner in visible chat.
- Liveness is intentionally scoped to coordinator/non-lane turns. Agents already inside an assigned
  work lane must still produce normal mission updates/receipts, which prevents auto-nudge loops from
  repeatedly re-dispatching the same in-progress lane.

Verification:
- Added `server/tests/unit/turn-outcomes.test.ts` for durable outcome upserts.
- Added `server/tests/unit/liveness-policy.test.ts` for ready-work dispatch, busy-agent waits,
  human/council waits, and unassigned-work detection.
- Added `server/tests/integration/autonomous-scenarios.test.ts`, which proves a coordinator's
  no-update receipt can dispatch ready owned work to another agent and that the owner receives an
  explicit assigned-lane prompt.
- Added `server/tests/unit/autonomous-replay-scenarios.test.ts` for hidden-only checklist progress,
  buried permission requests, and malformed provider output replay failures.
- Full Vitest, typecheck, server build, client build, and diff whitespace checks pass.

### Surface autonomy health in Mission Control

Problem:
- The broker could now persist liveness decisions, routing decisions, hidden mission command events,
  and compact turn outcomes, but the human still had to inspect APIs or run logs to understand why
  the autonomous team was moving, waiting, blocked, or idle.

Remediation:
- Added a Mission Control `Health` tab backed by the diagnostic endpoints.
- The view summarizes current autonomy state from task control, active runs, turn outcomes, routing
  decisions, and mission command events.
- It shows ready owned work, unassigned work, blockers, active runs, latest liveness decision, last
  routing decision, last progressed turn, recent ready-work dispatches, recent outcomes, and recent
  hidden command parsing results.
- The client refreshes these diagnostics on room load, task updates, run updates, and relevant run
  actions.

Verification:
- Typecheck, full Vitest, server build, client build, and API smoke checks pass.

### Keep explicit human mentions out of blocked YOLO launch paths

Observed during Slate autonomous dogfooding on 2026-05-03.

Problem:
- Matt sent `@jimmy` while another YOLO participant was already running.
- The broker persisted the message as delivered, but no run/read receipt was created.
- Room-aware dispatch was converting the free mentioned YOLO participant back into a YOLO thread;
  the YOLO launch guard could then block the thread, swallowing the direct human handoff.

Remediation:
- Explicit human mentions now bypass room-level YOLO orchestration and run as direct targeted turns.
- Room-level YOLO remains available for unaddressed/team prompts and explicit YOLO startup.
- Regression coverage now verifies direct YOLO-agent mentions, free-agent routing while another
  YOLO agent is running, unaddressed room-level YOLO, and explicit YOLO fanout behavior.

### Disallow empty open phases before autonomous mission launch

Observed during Slate autonomous dogfooding on 2026-05-03.

Problem:
- A project manager agent created empty phases.
- Empty active/open phases make "you are here" pointers, phase progress, next-work selection, and phase-gate status inaccurate.
- Agents can end up operating against a misleading current phase because there are no checklist items to anchor the phase.

Invariant:
- An open/planned/active phase must not be considered executable unless it has at least one checklist item associated with it.
- A done phase may be empty only if it was explicitly closed as a non-goal/decision phase with durable evidence.

Remediation:
- Added YOLO launch validation that fails before agent dispatch when the active mission has empty non-done phases.
- The system message lists each empty phase id, title, and status with cleanup guidance.
- Follow-up remains for richer Mission Control focus affordances and PM/EM prompt wording.

### Add phase-level parallelism matrix and optimizer

Observed during Slate autonomous dogfooding on 2026-05-03.

Problem:
- Agents can identify safe parallel work in chat, but the reasoning is not first-class in Mission Control.
- The project manager can say that Sean can work Governance polish while Rufio continues, but the harness does not surface a phase-level matrix showing which tickets can run together.
- Long-running tasks can take 15+ minutes. Running safe lanes sequentially materially increases wall-clock completion time.

Current behavior:
- Checklist items already carry useful scheduling metadata: dependencies, owner, expected touches, `parallelism`, and `conflict_group`.
- The YOLO lane assigner uses a greedy conflict check against active jobs and reserved contracts.
- That is enough to avoid obvious collisions, but not enough to proactively optimize a whole phase or explain the schedule to the human.

Remediation:
- Added a computed phase parallelism summary for open checklist items:
  - rows/columns are checklist items in the selected phase
  - cells classify `can-run-together`, `blocked-by-dependency`, `same-conflict-group`, `expected-touch-overlap`, `exclusive-lane`, or `not-ready`
  - include the concrete reason and the relevant files/conflict group
- Added an optimizer pass that proposes the next parallel batch for available agents:
  - maximize active agents
  - respect dependencies, owners, active jobs, conflict groups, expected touches, and exclusive lanes
  - prefer finishing blockers for downstream tasks
  - avoid assigning broad `api-content` lanes together unless expected touches are narrowed
- Surfaced the "next parallel batch" on the Board view.
- Added a Board "why" detail panel that lists concrete incompatibility reasons for candidate pairs,
  including dependency blockers, conflict groups, expected file-touch overlap, exclusive lanes, and
  not-ready state.
- Follow-up remains for explicit PM/EM prompt wording and optimizer tuning with agent/provider
  strengths as dogfooding evidence accumulates.

### Hydrate active YOLO turn budget on page reload

Observed during Slate autonomous dogfooding on 2026-05-03.

Problem:
- Reloading the page briefly shows the YOLO counter as the default `100/100` or `100 turns ready`.
- The true active state may be different, for example `98/200`, and only appears later after another live `yoloStatusUpdated` event.

Root cause:
- The browser stores YOLO status only in the transient `client/app/app.ts` `yoloStatus` signal.
- On reload, that signal starts as `null` and `yoloTurnCounterText()` falls back to `100`.
- The broker tracks active YOLO discussion state in memory, but the WebSocket `subscribe` response does not include the current room YOLO status.
- `buildStatusSnapshot()` also does not include active YOLO discussion state, so the client cannot hydrate this from the initial API load.

Remediation:
- Exposed read-only current YOLO status from `Broker` for a room.
- Sent that status immediately on WebSocket room subscription when an active YOLO discussion exists.
- Changed the frontend fallback so unknown status displays `YOLO ready`, not `100/100`.
- Follow-up remains for also adding YOLO status to `StatusSnapshotRoom`.

### Repair hidden-block parsing for YAML-style ledger content

Observed during Slate dogfooding on 2026-05-03.

Problem:
- Collaboration/evidence ledger rows can store garbage values such as `body = "|"` and `evidence = ["|"]`.
- Mission receipt actions can store details like `{"message":"|","status":"continuing","summary":"|"}`.
- Empty `<!-- -->` wrappers can remain visible in chat after an agent wraps slash blocks in HTML comments.

Root cause:
- `server/src/collaboration-notes.ts` and `server/src/mission-receipts.ts` parse only single-line `key: value` fields.
- Agents often emit YAML-style block scalar and list syntax:
  - `body: |` followed by indented text
  - `evidence: |` followed by indented text
  - `evidence:` followed by indented `- item` rows

Remediation:
- Added a shared hidden-block field parser that supports single-line fields, multiline `|` block scalars, and indented list continuations.
- Used it from collaboration notes, mission receipts, mission tasks, mission phases, and mission creation.
- Stripped empty HTML comment wrappers left behind after hidden block extraction.
- Added unit coverage for collaboration notes and mission receipts using Claude/Gemini-style hidden blocks.
- Added startup repair for existing malformed collaboration/evidence rows and mission receipt actions
  by reparsing `agent_runs.reply_text`, plus cleanup for historical empty `<!-- -->` chat messages.
