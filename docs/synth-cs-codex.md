# Fireside Condensing Strategy Synthesis

Synthesis by Codex, 2026-05-06.

Sources:

- `docs/condense-strats-codex.md`
- `docs/condense-strats-claude.md`

Scope: research synthesis only. This document does not record shipped implementation changes.

## Executive Summary

Claude and Codex found the same broad problem from two different angles:

1. Fireside repeats a large fixed protocol shell on nearly every active-mission turn.
2. Resumed provider CLI sessions then multiply the cost of those prompts by carrying accumulated prior prompt, tool, and model context across turns.

Claude's analysis shows the live prompt itself is overweight: median prompt size sits near the configured 16k character budget, and most of that budget is fixed protocol overhead rather than actual chat transcript.

Codex's analysis shows that the live prompt is only the visible layer. In recent local data, provider-reported usage for Claude/Codex turns was roughly 32x-34x the live prompt estimate because resumed sessions retain large provider context. Some Claude turns with roughly 3.7k estimated live prompt tokens reported hundreds of thousands of context tokens.

The combined conclusion:

> Shrinking the prompt shell is necessary, but the biggest quota win comes from changing when Fireside preserves provider session context.

## Unified Diagnosis

### Live Prompt Overhead

Claude measured recent production prompt distribution:

| Percentile | Prompt chars | Est. tokens |
| --- | ---: | ---: |
| p10 | 14,072 | 3,518 |
| p50 | 15,806 | 3,952 |
| p90 | 18,273 | 4,569 |
| p99 | 20,414 | 5,104 |

Codex measured a similar split across recent stored prompts:

| Metric | Approximate value |
| --- | ---: |
| Average prompt size | 14,010 chars |
| Average scaffolding/state/protocol | 11,591 chars |
| Average transcript body | 2,407 chars |
| Average live messages | 2.5 |

That means the prompt budget is mostly spent before the current conversation has much room to breathe.

### Resumed Session Multiplier

Codex measured provider-to-live-prompt ratio over a recent 48-hour window:

| Provider | Runs | Provider tokens | Live prompt estimate | Ratio |
| --- | ---: | ---: | ---: | ---: |
| Codex | 91 | 12.2M | 365k | 33.6x |
| Claude | 204 | 26.1M | 804k | 32.5x |

This is the more important long-run effect. Even if Fireside cuts the live prompt by 25%, a large resumed provider session can still dominate quota burn.

### Prompt Budget Behavior

Claude identified that `buildTurnPromptResult` only moves from full detail to compact/minimal after the rendered prompt exceeds the prompt budget. This means the verbose prompt can ship by default whenever it fits under the cap.

Counterintuitively, raising `FIRESIDE_MAX_PROMPT_CHARS` can increase per-turn cost because it allows more verbose protocol to survive. A larger budget gives agents more context only if the prompt assembly uses the extra room for useful transcript or task evidence rather than repeated syntax docs.

## Highest-Leverage Strategy

### Adopt Per-Turn Session Policy

Fireside should stop treating resumable provider sessions as the universal default.

Recommended policies:

| Turn type | Session policy | Rationale |
| --- | --- | --- |
| Team lead / PM / coordinator | Persistent with compaction | These agents benefit from continuity and mission-level memory. |
| Long investigation / debugging thread | Persistent with compaction | The agent may need local reasoning continuity across tool calls and turns. |
| YOLO assigned work-lane worker | Ephemeral or reset-after-lane | Mission Control already defines the work packet; preserving all prior provider context is usually wasteful. |
| QA/review lane | Ephemeral by default | Review should be driven by current artifacts, evidence, and acceptance criteria. |
| No-lane coordination pulse | Suppress unless needed | Do not spend a full provider turn to discover that the agent has nothing to add. |

This should be the first architectural target because it attacks the 32x-34x provider multiplier directly.

## Prompt Condensing Strategy

### Make Prompt Detail Intentional

Do not let "fits under budget" decide whether the verbose protocol shell is included.

Recommended behavior:

- Default active-mission turns to compact protocol.
- Use full protocol only for first exposure, malformed-block repair, or explicit training/diagnostic turns.
- Keep latest human/agent message authoritative.
- Preserve direct @mention lines when truncation is unavoidable.

### Split Prompt Slices By Role

Coordinator turns need more mission-wide protocol than worker turns.

Workers usually need:

- identity and exact visible handle rules
- assigned lane
- current phase
- dependencies/blockers for that lane
- relevant permission grant
- minimal `/mission-task` and `/mission-receipt` reminder
- latest triggering message

Workers usually do not need:

- full `/mission-create` schema
- full `/mission-plan` schema
- temporary-agent roster protocol
- full collaboration-note schema
- full active plan body
- broad room history
- repeated discussion-budget prose until the limit is near

### Externalize Stable Protocols

Provider-neutral option:

- Write a room-local `protocols.md` beside `recap.md` and `transcript.md`.
- Store full schemas for `/mission-task`, `/mission-phase`, `/mission-plan`, `/mission-receipt`, `/collab-note`, `/permission-request`, `/draft-artifact`, and `/agent-roster`.
- Replace repeated schema blocks in the live prompt with short references.
- Re-inject a full schema only on first exposure or after malformed output.

Claude-specific option:

- Split prompts into stable primer and dynamic tail.
- Put stable protocol/identity guidance in a cacheable prefix if Claude Code exposes prompt-cache controls through the CLI or if Fireside later uses the Anthropic SDK directly.

These approaches compose. Externalized protocols reduce every provider's prompt size. Prompt caching then makes the remaining stable prefix cheaper for Claude when cache hits are available.

## Invocation Condensing Strategy

Do not run agents just because a round exists.

Recommended scheduler filters:

- Run an agent when it has an assigned unblocked lane.
- Run an agent when it is directly tagged.
- Run an agent when a blocker requires that exact agent or persona.
- Run the team lead when a system/mission repair event needs coordination.
- Suppress opportunistic no-lane pulses unless there is a concrete reason.
- If an agent repeatedly returns empty/no-op in a phase, suppress future opportunistic turns until new evidence, a direct mention, or a lane appears.

Codex found 69 of 500 recent turn outcomes were no-op/empty-message outcomes, averaging about 4k estimated prompt tokens each before provider-session amplification.

## Combined Implementation Order

### Phase 1: Low-Risk Prompt Reductions

1. Add prompt section accounting to diagnostics so reductions can be measured by section.
2. Default active-mission prompts to compact protocol unless full schema is explicitly needed.
3. Drop or sharply shrink `recentActivity` from task context.
4. Tighten mission-create protocol injection so ordinary words like "plan" do not trigger the full mission scaffold schema.
5. Suppress discussion-budget text until the final one or two rounds.

Expected result: meaningful per-turn prompt reduction with limited behavior risk.

### Phase 2: Session Policy

1. Add a per-agent/per-turn session policy:
   - `persistent`
   - `compacting`
   - `ephemeral`
   - `reset-after-lane`
2. Default YOLO assigned workers to `reset-after-lane` or `ephemeral`.
3. Keep leads/coordinators persistent with compaction.
4. Surface the current session policy in run diagnostics so token behavior is inspectable.

Expected result: largest quota-burn reduction in long-running YOLO missions.

### Phase 3: Externalized Protocols

1. Write room-local `protocols.md`.
2. Replace repeated live prompt schemas with pointers.
3. Add a repair path that re-injects exact schemas when an agent emits malformed hidden blocks.
4. Track schema-read behavior so the system can identify models that need more inline guidance.

Expected result: provider-neutral prompt shrinkage, especially on active-mission turns.

### Phase 4: Provider-Specific Caching

1. Verify whether Claude Code CLI exposes enough control for prompt cache markers.
2. If not, decide whether Claude should remain CLI-only or whether a direct Anthropic SDK path is justified for cacheable turns.
3. Investigate Codex/Gemini equivalents separately; do not assume equal support.

Expected result: major effective input-token reduction on providers that support cached stable prefixes.

## Risk Matrix

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Agents stop updating Mission Control | Removing schema repetition may reduce compliance. | Keep compact reminders, re-inject schema after malformed output, strengthen reconciliation repair prompts. |
| Workers lose useful context after reset | Ephemeral sessions remove provider memory. | Make work packets self-sufficient and keep Mission Control as source of truth. |
| More file reads/tool calls | Externalized protocols may cause agents to read files. | Keep protocol files short and stable; only full schema-read when needed. |
| Cache implementation complexity | CLI may not expose cache markers. | Treat caching as provider-specific Phase 4, not the foundation. |
| Agents appear inert after suppression | Fewer opportunistic turns can look like stalled collaboration. | UI should show deterministic routing/suppression reasons. |

## Practical Target

The target is not "smallest possible prompt." The target is:

> A worker assigned one checklist lane should receive exactly enough mission state to act, should not carry the whole room's provider session history by default, and should leave durable Mission Control evidence before its session is compacted or discarded.

That preserves Fireside's core advantage, coordinated autonomous work, while reducing quota burn from repeated protocol and accumulated provider context.
