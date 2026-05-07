# Fireside token-condensation synthesis — Claude lane

Author: Claude (Opus 4.7, 1M context). Date: 2026-05-06.
Inputs synthesized: `docs/condense-strats-claude.md` (Claude lane) and
`docs/condense-strats-codex.md` (Codex lane).
Scope: research only — no code changes shipped from this synthesis.

## Executive summary

Each lane found a different multiplier. Both are real and they compound:

- **Claude lane (mine).** Per-turn fixed protocol overhead is roughly
  **3,500 tokens of every prompt** before a single character of
  transcript or latest message lands. Verified by reading the
  prompt-assembly surface and re-rendering with controlled inputs.
- **Codex lane.** Resumed CLI sessions inflate the *effective* per-run
  context the provider bills by **32-37×** the live-prompt estimate.
  Verified independently: in the last 48h, Claude billed **24.1M
  tokens against a 750K live-prompt estimate (32.2×)** and Codex
  billed **17.7M against 476K (37.2×)**. A single Claude turn billed
  **998,494 tokens** — near the full 1M context window.

Codex's lever is the larger of the two. My lever is smaller in
absolute tokens per turn but composes with theirs and applies to
every provider including those without server-side caching.

The combined target — **stateless workers + condensed shell + tighter
invocation** — should drop quota burn dramatically more than either
strategy alone.

## What both lanes agree on

1. **The live transcript is not the dominant cost.** Codex measured the
   recent-prompt body at ~2,400 chars out of ~14,000-char average
   prompts. My synthetic attribution puts the fixed shell at ~14,000
   chars before any transcript. Trimming chat is the wrong knob.
2. **Protocol blocks are repeated every turn.** The mission-update
   schemas alone are ~3,000 chars, repeated verbatim on every
   active-mission turn.
3. **Role-specific prompt slicing is overdue.** A worker doing one
   checklist lane does not need the mission-create scaffold,
   roster-management protocol, or the full plan body. Both lanes call
   for narrower prompts per role.
4. **Reset is sometimes better than compact.** Long-lived worker
   sessions accumulate context that compaction does not actually free
   for billing. Codex frames this directly; my lane noted the issue
   indirectly via the prompt-caching reframe below.

## Where the lanes diverge — and what verification showed

### Codex's biggest claim, verified

Codex reported a 32-34× ratio between provider-reported context tokens
and the live-prompt estimate. I re-derived the same number from
`agent_run_actions.context_usage_json` over the last 48h, computing
per-run-max so multiple usage events for one run aren't double-counted:

| Provider | live runs | live tokens | usage runs | provider tokens (per-run-max sum) | **ratio** | max single run |
|---|---:|---:|---:|---:|---:|---:|
| Claude | 206 | 750,264 | 184 | 24,129,117 | **32.2×** | 998,494 |
| Codex  | 146 | 475,952 | 130 | 17,711,779 | **37.2×** | 251,697 |
| Gemini |  17 |  63,313 |   0 | (no usage telemetry captured) | n/a | n/a |

The 998,494-token Claude run is the smoking gun. That is not driven by
the live prompt I render — `transcript.ts` will trim aggressively long
before that. It is the resumed session carrying all prior turns
forward at full size every time.

I also verified that **session resume is the active default**, not
opt-in as the wiki implies: in the last 7 days, **2,795 of 3,213 runs
(87%) had a stored `cli_session_id`**. The wiki's "opt-in via
`FIRESIDE_RESUME_CLI_SESSIONS=1`" framing is stale; `config.ts:94`
defaults the flag to `true`.

### My biggest claim, refined

My Tier 2 #4 said "wire Claude prompt caching." That recommendation is
partially wrong. Inspecting recent `context_usage_json` payloads shows
the Claude and Codex CLIs already emit `cacheCreationInputTokens` and
`cacheReadInputTokens`, and a sample Codex turn showed 93,056 of
97,385 input tokens served from cache (~96% cache hit). Provider-side
prompt caching is happening automatically through the CLIs.

The real lever is **structural**: the cache key is the prompt prefix.
If Fireside reorders fields between turns, mutates the persona/roster
line slightly, or interleaves dynamic content into the middle of the
"stable" shell, every turn becomes a cache miss. The win is therefore
to keep the prompt assembled as `<stable prefix> + <dynamic tail>` so
the prefix stays byte-identical across turns within a session.

### A wasted-turn rate worse than Codex reported

Codex said "69 of 500 turn outcomes were agent-declined" (~14%). I
queried `agent_turn_outcomes` directly:

- **885 of 1,591 (56%) of turn outcomes emitted no visible message.**
- **431 of 1,591 (27%) emitted no message AND made no mission-state
  progress.**

The 27% no-message-and-no-progress slice is pure waste — each of those
turns paid the full per-turn shell *plus* whatever the resumed session
multiplier added that turn. At 32× amplification, a single 3,500-token
"agent had nothing to add" turn can bill ~110,000 effective tokens
against quota. Suppressing those turns is one of the cheapest wins in
either lane's analysis.

## Reconciled win list

Ordered by expected impact × ease, combining both lanes.

### Tier 1 — biggest single levers

1. **(Codex) Default workers to ephemeral provider sessions.**
   Specifically: when an agent is invoked for an assigned work-lane
   pulse — not for lead/coordinator duties — set the CLI invocation to
   omit `--resume`/equivalent and start a fresh session. Coordinators,
   PMs, EMs, and architects keep persistent sessions; everyone else
   defaults stateless. Implementation lives in
   `agent-turn-context.ts` (`resumeCliSessions` already accepts a
   per-call boolean) and `getResumableCliSessionId`. Add a
   `sessionPolicy` field to room-agent profiles or workflow profiles.

   *Direct attack on the 32-37× multiplier.* Most impactful single
   change in either lane.

2. **(Both lanes) Slice protocols by role and turn kind.**
   Codex framed this as role-specific prompt assembly. I framed it as
   "make compact the default and externalize schemas." Same lever:
   stop sending the full mission-update / collab-note / agent-roster
   schemas to every agent on every turn. Concrete shape:
   - Worker turns get `/mission-task` + `/mission-receipt` schemas
     only.
   - Coordinator turns add `/mission-plan` and `/mission-phase`.
   - Engineering-manager / QA-lead turns add the agent-roster
     protocol.
   - Mission-create scaffolding only when no active mission exists
     *and* the latest message explicitly requests one (tightening
     `shouldIncludeMissionCreateProtocol` past its current loose
     regex match on words like "plan" / "todo").

   *Saves ~2,500-4,000 chars per turn for worker-role agents,
   compounds with #1 because every ephemeral worker spawn pays the
   shell from scratch.*

3. **(Codex) Suppress no-op-prone invocations.**
   With 27% of turns emitting no message and no progress, the
   discussion scheduler is invoking agents that have nothing to say.
   Concrete shape:
   - Don't fire opportunistic coordination pulses unless there's a
     real reason: direct mention, assigned work lane, blocker
     requiring this agent, explicit handoff, or coordinator decision.
   - "Coordination pulse with no lane" routes to the team lead first,
     not all eligible agents.
   - Per-mission-phase quarantine: if an agent emitted two
     consecutive empty/no-op responses in the same phase, suppress
     opportunistic dispatch until a direct tag, new lane, or new
     evidence appears.

   Attacks both axes at once: fewer turns, and the turns saved are
   the ones that produced nothing.

### Tier 2 — structural, smaller per-turn but always-on

4. **Externalize per-turn protocols to `data/agent-context/<room-id>/protocols.md`.**
   Provider-neutral cousin of #2. Replace each verbose protocol block
   with a one-line pointer. Agents that need the schema (rare after
   the first valid emit) read the file. Composes cleanly with #1
   because the externalized text is identical across worker spawns
   and lives outside the prompt entirely.

5. **Preserve cache-prefix stability across turns.**
   Refined version of my original "wire prompt caching" claim. The
   CLIs already cache; the lever is to keep the assembled prompt's
   stable header (opening, identity, persona, roster, externalized
   protocol pointers) byte-identical between turns within a session,
   so the cache prefix matches. Concrete shape:
   - Hold the stable prefix as a memoized string per room/agent/role
     tuple; rebuild only when room composition changes.
   - Move all volatile fields (discussion budget counters, work-lane
     assignment, recent-mission-activity, latest message) below the
     stable prefix so the prefix's byte boundary stays clean.
   - Add a regression test that asserts the prefix is stable across
     two consecutive prompt builds with only transcript/latest-message
     differing.

6. **Drop `recentActivity` from the active-mission prompt.**
   `task-summary.ts:55-58` injects up to 10 lines (5 runs + 5
   messages). The messages overlap with the `Transcript:` block. The
   runs leak per-run prompt-token estimates back to the agent, which
   is meta-information about its own conversation. Saves up to ~1,800
   chars per turn.

### Tier 3 — small but clean

7. Strip the inline `/permission-request` schema in plan mode
   (`transcript.ts:617-626`, ~700 chars). Move to `protocols.md`.
8. Suppress discussion-budget chatter until the final 1-2 rounds
   (`transcript.ts:645-664`, ~500-600 chars).
9. Compact the room roster line (`transcript.ts:152-173`,
   ~120 chars × n_agents). Persona/provider belong in the cached
   primer, not in every turn.

### Codex Tier 2 #5 (compaction policy) — accept as proposed

Codex's "prefer reset over compact for some agents" reads like the
operational corollary of #1 above. Adopt the proposed flag:
`sessionPolicy: persistent | compacting | ephemeral | reset-after-lane`,
defaulted by role, override-able per agent.

## Combined ROI math

Building on the per-turn fixed-shell math from
`docs/condense-strats-claude.md` and the 32-37× provider amplifier
from `docs/condense-strats-codex.md`:

| Configuration | Per-turn live | Provider effective | Note |
|---|---:|---:|---|
| Today (worker, persistent session, full protocol) | ~3,500 tokens | ~110,000 tokens | 32× amplifier on full live shell |
| + Tier 1 #2 (role-sliced protocol) | ~1,700 tokens | ~54,000 tokens | Same session amplification, smaller live |
| + Tier 1 #1 (ephemeral worker) | ~1,700 tokens | ~1,700 tokens | Amplifier eliminated for that role |
| + Tier 1 #3 (no-op suppression at 27% rate) | n/a | **−27% of total turns** billed | Multiplies through |
| + Tier 2 #5 (cache-prefix stability) | ~1,700 tokens | ~200-400 effective tokens on cache hit (Claude/Codex) | Caching turn-2 onward |

For an autonomous YOLO loop of 4 workers × 5 rounds, the difference
between "today" and "Tier 1 + Tier 2 #5" applied is roughly
**~2.2M tokens billed → ~250-300K tokens billed** — a ~7-9× total
quota stretch on the same loop. The 27% no-op suppression compounds
on top of that as a roughly 1.37× extra stretch.

These numbers are estimates derived from sampled measurements; the
actual ratio depends heavily on session age and how aggressively the
existing auto-compaction is firing. The order-of-magnitude conclusion
is robust: **Codex's #1 alone justifies the work.**

## Things to check that neither lane resolved

- **Wiki vs code drift on session-resume default.** The
  `wiki/engineering/Fireside.md` entry says "CLI session resume is now
  opt-in via `FIRESIDE_RESUME_CLI_SESSIONS=1`," and the env table in
  the same file lists default `true`. The code in `config.ts:94`
  defaults it to `true`. The "opt-in" prose is wrong. Update the wiki
  in place when the policy work lands.
- **Wiki vs code drift on prompt-budget default.** The wiki mentions
  ~24,000 chars; `config.ts:84` defaults `FIRESIDE_MAX_PROMPT_CHARS`
  to 16,000. Production runs sit pinned near 16K, so the code value
  is what's live.
- **Gemini context-usage telemetry is missing.** 17 Gemini runs in the
  48h window had zero `usedTokens` events. Either the Gemini adapter
  is not surfacing usage in the same field shape (see
  `agents/gemini.ts` and the wiki note about quota sampling being
  "best-effort additive"), or the action records use a different
  field. Worth a 30-minute fix to make Gemini's quota burn visible
  before any policy decisions go live, otherwise the impact of
  changes will be invisible for one of three providers.
- **Cache-prefix stability today.** I haven't measured how often the
  Claude/Codex CLI cache *hits* in practice across consecutive
  Fireside turns. If room/agent state mutates between turns in ways
  that change the prefix, the cache may be missing more than the
  sample I caught suggests. Worth instrumenting before betting the
  ~96% number.
- **Mission Control sufficiency for stateless workers.** Codex
  flagged this; I want to underline it. If we move workers to
  ephemeral sessions, Mission Control + handoff context + recent
  receipts must be reliable enough to be the source of truth. Edge
  cases: cross-lane investigation that took two turns to figure out,
  long shell command output the worker needs to remember. These need
  artifact files (`recap.md`, lane notes) carrying the load that
  resumed CLI memory does today.

## Recommended sequencing

1. **Today (no policy risk).** Tier 2 #6 + Tier 3 #7 + #8 + #9 +
   wiki/code-drift fixes + Gemini telemetry fix. Drop ~1,800 chars/turn
   on workers, get measurement parity across providers. Add a
   regression test against the prompt-shell byte budget.
2. **Next.** Tier 1 #2 (role-sliced protocols) and Tier 2 #4
   (externalize protocols to `protocols.md`). Same diff scope, same
   files (`transcript.ts`, `agent-turn-context.ts`). Lands the largest
   per-turn shell shrink before changing session policy.
3. **Then, gated.** Tier 1 #1 (`sessionPolicy`) + Tier 2 #5
   (cache-prefix stability) + Codex's compaction-policy flag. Ship
   stateless-worker support behind a feature flag, dogfood for a day
   in a single room, watch the provider-token totals from
   `agent_run_actions` directly. Roll out by role: workers first,
   reviewers second, leads/PMs/EMs last.
4. **Finally.** Tier 1 #3 (no-op suppression) once the new prompt
   shape has stabilized — otherwise we'll be tuning suppression
   thresholds against the old prompt's behavior.

## Where my original doc was wrong

For the record, since this synthesis supersedes the originals on
overlapping points:

- The "wire Claude prompt caching" framing in
  `condense-strats-claude.md` was wrong as stated. CLI-level caching
  is already on. The right framing is "preserve cache-prefix
  stability so the existing caching actually hits."
- I underweighted the wasted-turn rate. Codex caught the
  agent-declined pattern; my doc didn't quantify it. The DB-verified
  rate (27% of turns produce no message and no progress) is a
  first-tier finding, not a footnote.
- My "ROI math" table treated per-turn shell as the dominant cost.
  After verifying Codex's amplifier number, that table understates
  the real opportunity by roughly 30×. The corrected ROI table above
  reflects both axes.

Codex's analysis was tighter on the cost model. Mine was tighter on
the per-block attribution and the prompt-text mechanics. The combined
plan is stronger than either alone.
