# Fireside prompt-condensation strategies — Claude analysis

Author: Claude (Opus 4.7, 1M context). Date: 2026-05-06.
Scope: research only — no code changes shipped from this analysis.

## TL;DR

Fireside burns quota faster than a non-Fireside Claude session because the
median per-turn prompt is **~16,000 chars / ~4,000 tokens**, and **~75-90%
of that is fixed protocol overhead** rebroadcast every turn. The biggest
single contributor is the Mission Update protocol block (~3,000 chars /
~750 tokens repeated verbatim on every active-mission turn). Two
independent levers compound:

- **Tier 1** (config flips, low risk): drop ~2,500-3,500 chars of
  always-on protocol. Estimated ~17-25% per-turn reduction.
- **Tier 2** (architectural): externalize protocols to a referenced file
  and/or wire Claude prompt caching. Estimated ~50%+ effective input-token
  reduction on Claude turns once warm.

Combined: a typical YOLO active-mission turn's fixed overhead would drop
from ~3,500 tokens to roughly 1,000-1,200 tokens uncached, with
prompt-caching shrinking the remaining ~1,200 to ~10% of list price on
Claude. That is roughly a **2.5-3× longer YOLO loop on the same quota
window** before caching, more after.

## Methodology

1. Sampled `agent_runs.prompt_chars` and `estimated_prompt_tokens` for the
   last 500 runs in `data/fireside.sqlite` to characterize what is
   actually flying.
2. Read the prompt assembly surface end-to-end:
   - `server/src/orchestration/agent-turn-context.ts` (assembles the
     `BuildTurnOptions`).
   - `server/src/transcript.ts` (`renderPrompt` + `buildTurnPromptResult`,
     the actual rendering and budget loop).
   - `server/src/task-summary.ts` (`buildTaskPromptContext`,
     `recentActivity`).
   - `server/src/agents/personas.ts` (per-turn persona injection).
   - `server/src/agents/claude.ts` (verified there is no `--system` /
     `--append-system-prompt` / `cache_control` wiring today).
3. Wrote `scripts/measure-prompt-overhead.mjs` to call the real
   `buildTurnPromptResult` with synthetic inputs and attribute cost to
   each block. The script is research-only and can be deleted; it lives
   in `scripts/` so it can be re-run after each candidate change.

## Measured token burn

### Distribution from production runs (last 500)

| percentile | prompt chars | est. tokens |
|---|---|---|
| p10 | 14,072 | 3,518 |
| p50 | 15,806 | 3,952 |
| p90 | 18,273 | 4,569 |
| p99 | 20,414 | 5,104 |

Total across the 500-run window: **~7.4M chars / ~1.85M est. tokens of
input**. Median sits within ~200 chars of the configured 16,000-char
budget — the budget is being saturated, which means agents are not
getting the full transcript they "could" have. The budget is being
spent on protocol.

### Synthetic attribution from `scripts/measure-prompt-overhead.mjs`

Same agent identity, no transcript history, latest message `"hi"`. Each
row is built on the previous row's options.

| Configuration | chars | est. tokens |
|---|---|---|
| Bare shell (no mission/permission/collab/context-files) | 4,597 | 1,150 |
| + active mission (full Mission Control protocol) | 11,317 | 2,830 |
| + collab ledger (2 items) | 11,635 | 2,909 |
| + context-files block | 12,196 | 3,049 |
| + edit permission grant | 11,963 | 2,991 |
| + YOLO + work lane + discussion budget | **14,083** | **3,521** |

That final row is the **fixed overhead before any transcript content or
latest-message body**. On a 4-agent, 5-round YOLO over the 16K cap,
that's roughly **70,000 tokens of pure protocol** on top of whatever
real work the loop does.

## Cost attribution by block

All citations are to current `main` working-tree code.

| Block | Chars | Source | Notes |
|---|---|---|---|
| Opening + identity + handoff + persona + roster | ~1,500 | `transcript.ts:677-693`, `formatAgentProfile`, `formatRoomProfiles` | Always-on shell; baseline floor every turn pays |
| Plan-mode permission protocol | ~700 | `transcript.ts:617-627` | Includes the full `/permission-request` schema dump even on turns that won't request anything |
| Collaboration protocol (verbose) | ~1,100 | `transcript.ts:570-588` | Full `/collab-note` schema dump on every turn; compact branch is ~300 chars |
| Active-mission header (title/goal/criteria/phase/checklist/plan) | ~1,200 | `transcript.ts:511-550` | Genuinely dynamic content; not protocol bloat |
| **Mission update protocol (verbose)** | **~3,000** | `transcript.ts:426-482` | **Single biggest contributor.** `/mission-plan`, `/mission-phase`, `/mission-task`, `/mission-receipt` schemas in full; compact branch (lines 422-425) is ~400 chars but only fires once the prompt is already over budget |
| Mission-create protocol (when triggered) | ~800-1,000 | `transcript.ts:399-421`, `shouldIncludeMissionCreateProtocol` at 335-339 | Regex match against `plan|task|todo|checklist|brief|...` — fires on ordinary chat phrasing |
| Workflow profile prompt | up to 1,400 | `transcript.ts:551-561` | Per-mission, per-template; varies |
| YOLO work lane + scope contract | ~700 | `transcript.ts:629-637` | YOLO turns only |
| Discussion budget chatter | ~500-600 | `transcript.ts:645-664` | Every multi-round turn |
| Context-files notice | ~570 | `transcript.ts:382-397` | Informational pointer to recap.md/transcript.md |
| `recentActivity` from task context | up to ~1,800 | `task-summary.ts:55-58`, `formatRun` at 35-43 | **Partially redundant with the `Transcript:` block below**; also leaks per-run prompt-token estimates back to the agent |

### Why the budget loop hides this from the operator

`buildTurnPromptResult` (`transcript.ts:705-834`) only flips
`detail = 'compact'` *after* a full-detail render exceeds
`maxPromptChars`. With the default 16K budget and a typical mission, the
verbose render is ~14K-15K chars before transcript, so the verbose path
fits and ships. With a higher budget (the 24K mentioned in
`wiki/engineering/Fireside.md`), the compact path never fires at all and
every turn pays the full ~3,000-char mission-protocol tax. That is
exactly inverse to what the operator would intuit: *raising* the budget
makes per-turn cost worse, not better.

## Wins, ranked by ease × impact

### Tier 1 — config-level flips, low risk

1. **Make `compactPrompt` the default for active-mission turns.**
   The verbose schema dump is essentially "syntax docs for a first-time
   agent." Once an agent has emitted a valid `/mission-task` or
   `/mission-receipt` once, it has the schema and won't lose it within a
   provider session. Approaches:
   - Flip the initial `detail` to `'compact'` in
     `buildTurnPromptResult` (`transcript.ts:718`) and let the existing
     loop expand to `'full'` only if there's headroom.
   - OR add a `FIRESIDE_PROTOCOL_DETAIL=compact|full` config knob.
   - OR keep `'full'` for the first turn of a new room (where no agent
     has seen the schema yet) and `'compact'` thereafter.

   Estimated savings: **~2,500 chars / ~625 tokens per turn**, roughly
   17% of a typical YOLO prompt.

2. **Drop `recentActivity` from the task-prompt context.**
   `task-summary.ts:55-58` builds it from up to 5 recent runs + 5
   recent messages. The messages portion overlaps with the `Transcript:`
   block already appended at the bottom of the prompt. The runs portion
   leaks `estimatedPromptTokens` back to the agent (`task-summary.ts:40-42`),
   which is meta-information about the conversation it does not need.

   Estimated savings: ~600-1,800 chars/turn depending on activity volume.

3. **Tighten `shouldIncludeMissionCreateProtocol`.**
   `transcript.ts:335-339`'s regex matches `mission`, `brief`,
   `phase gate`, `checklist`, `to-do`, `todo`, `task list`,
   `work breakdown`, `plan` — ordinary chat phrases like "let's plan
   that out" trigger an 800-1,000 char `/mission-create` syntax block
   even when no mission scaffold is being requested. Two options:
   - Gate the protocol behind an explicit `/mission-create` request
     from the human (or a directed-control button).
   - Replace the per-turn injection with a one-line pointer:
     "no active mission — ask Fireside to scaffold one with
     /mission-create".

   Estimated savings: 800-1,000 chars/turn on triggering messages
   (which is many of them, given how broad the regex is).

### Tier 2 — architectural, biggest payoff

4. **Wire Claude prompt caching.**
   Verified absent: zero matches for `cache_control`, `--system`,
   `--append-system-prompt`, or `prompt-caching` in
   `server/src/agents/`. `agents/claude.ts:396-415` builds argv with
   `-p --verbose --output-format stream-json --include-partial-messages`
   and pipes the entire prompt through stdin (`buildStdin` at 416-418).

   The stable per-turn protocol stack (~3,500 tokens of opening,
   identity, persona, handoff line, mission protocols, collab protocol,
   workflow profile, …) is **identical across consecutive turns within a
   session and across multiple agents within a room**. That is exactly
   the shape Anthropic's prompt cache rewards: a cached prefix at 10% of
   list price on cache hits, with a 5-minute TTL that easily covers a
   YOLO loop's pacing.

   Implementation rough cut:
   - Split the rendered prompt into two parts: a stable "system primer"
     (everything that doesn't change across turns within a session) and
     the dynamic tail (Transcript, latest message, work-lane assignment,
     discussion-budget counters, recent-mission-activity if kept).
   - Pass the primer via `--append-system-prompt` (Claude Code CLI flag)
     so the underlying API call sees it as a system message, then mark
     it `cache_control: { type: "ephemeral" }`. The CLI surfaces an
     `--append-system-prompt` flag; verify cache-marker support, fall
     back to a `claude` API SDK call if the CLI doesn't expose
     `cache_control` directly.
   - Codex's API supports caching with similar semantics. Gemini does
     not have a directly comparable feature today, so this win is
     provider-uneven.

   Estimated effective savings on Claude: with ~70-80% of input tokens
   in the cacheable prefix, **~60-70% reduction in effective input cost**
   on cache-hit turns. Cache misses (first turn after a 5-min idle) pay
   the same as today, plus a small write tax.

5. **Externalize per-turn protocols to `data/agent-context/<room-id>/protocols.md`.**
   This is the provider-neutral cousin of (4): the room-local context
   directory already holds `recap.md` and `transcript.md`. Add
   `protocols.md` with the full mission-update / collab-note /
   permission-request / draft-artifact / agent-roster schemas. Replace
   each verbose protocol block in the prompt with a one-line pointer
   ("Mission update protocol: see `protocols.md` for the full schema").
   Agents that need the schema (rare after the first valid emit) read
   the file with `Read`/`cat`.

   Estimated savings: the full ~3,000 chars of mission protocol every
   turn unconditionally, plus the ~1,100 chars of collab protocol and
   ~700 chars of permission-request protocol when those are externalized
   too. **Roughly 4,000-5,000 chars / ~1,000-1,250 tokens per turn**,
   provider-agnostic.

   This composes with (4): the *remaining* per-turn shell is small, and
   what shell remains can still be cached on Claude.

### Tier 3 — smaller but easy

6. **Drop the `/collab-note` schema block once the ledger is non-empty.**
   `transcript.ts:574-585` injects the full schema every turn. By the
   time the ledger has any items, the agent has seen the schema. Keep
   the prose-level "challenge weak assumptions / cite evidence"
   guidance, drop the schema dump. ~700 chars saved on most turns.

7. **Drop the inline `/permission-request` schema in plan mode.**
   `transcript.ts:617-626`. Most plan-mode turns won't request
   permission, and when an agent does need to request, it has the
   schema in `protocols.md` (see #5) or in the room's existing
   permission-request transcript history. ~700 chars saved.

8. **Suppress discussion-budget chatter until the final 1-2 rounds.**
   `transcript.ts:645-664`. "Round 2 of 5, you have already sent 1
   message(s)" is informational, not actionable, until budget is
   actually tight. Inject only when `round >= maxRounds - 1`. ~500-600
   chars saved on most multi-round turns.

9. **Compact the room roster.**
   `transcript.ts:152-173` emits `displayName [handle=@..., id=...,
   provider=..., persona=...]` for every member — ~120 chars per
   member × n_agents. Persona/provider are roughly invariant per-room
   and can move to the cached primer (#4) or `protocols.md` (#5). The
   per-turn line can shrink to a handle list.

   ~600-800 chars saved on larger rooms.

## Rough ROI math

Starting from a typical YOLO active-mission turn at ~14,000 chars /
~3,500 tokens of fixed overhead:

| Step | New fixed overhead | % reduction vs today |
|---|---|---|
| Today | ~3,500 tokens | 0% |
| + Tier 1 (#1 + #2 + #3) | ~2,700-2,900 tokens | 17-23% |
| + Tier 3 (#6 + #7 + #8 + #9) | ~2,100-2,400 tokens | 31-40% |
| + Tier 2 #5 (externalize protocols) | ~1,000-1,200 tokens | 65-71% |
| + Tier 2 #4 (Claude caching, on cache hit) | ~150-200 effective tokens | **94-96%** |

The last row is Claude-only and applies only on cache hits inside the
TTL window; the row above it applies to every provider on every turn.

The transcript and latest message still cost what they cost — these
strategies don't compress real conversation, only the protocol shell.
A YOLO loop that previously hit the 16K budget at turn 4-5 (causing
older messages to drop) would, after Tier 1 + Tier 2 #5, hit the budget
many turns later, meaning agents see more transcript on the same
budget without paying more per turn.

## What I'd ship in what order

1. **Today**: Tier 1 #1 (`compactPrompt` default) + #2 (drop
   `recentActivity`) + #3 (gate `shouldIncludeMissionCreateProtocol`).
   Three small edits in `transcript.ts` and `task-summary.ts`. Add a
   regression test that asserts a representative active-mission YOLO
   prompt is below a target byte budget. Measure on the same 500-run
   sample after a few hours of dogfooding.
2. **Next**: Tier 2 #5 (externalize protocols to `protocols.md`).
   Provider-neutral. Updates `context-files.ts` to write the protocols
   file, updates `transcript.ts` to emit pointers instead of schema
   bodies. Larger diff, but no provider-specific risk.
3. **Then**: Tier 2 #4 (Claude prompt caching). Largest single
   provider-specific win. Touches `agents/claude.ts` and the
   prompt-assembly seam — needs the system/user split discussed above.
   Gate behind a config flag for one or two days to confirm
   cache-hit-rate matches expectations before flipping the default.

## Things to verify before acting

- Confirm Claude Code CLI's `--append-system-prompt` flag passes
  `cache_control` markers through to the API. If it strips them, the
  caching win requires using the Anthropic SDK directly instead of the
  CLI for cacheable prefixes — bigger refactor.
- Confirm Codex CLI's analogue (their `--instructions` or system-prompt
  flag, depending on version) carries cache markers similarly.
- Confirm `wiki/engineering/Fireside.md`'s claim of "approximately
  24,000 characters" matches the current code default of 16,000 in
  `config.ts:84`. The wiki may be stale, or one of the two surfaces is
  drifting from the other. The 16K default is what production is
  actually using per the DB sample.
- The compact-branch (`compactPrompt = true`) path was written
  defensively but has not been the primary code path historically.
  Worth a focused test pass to confirm agents emit valid mission/collab
  blocks against the compact text alone before flipping the default.

## Appendix: scratch artifacts

- `scripts/measure-prompt-overhead.mjs` — re-runnable harness used for
  the synthetic attribution table above. Calls the real
  `buildTurnPromptResult` with controlled inputs. Delete or keep as you
  prefer; it's a research artifact, not a product surface.
