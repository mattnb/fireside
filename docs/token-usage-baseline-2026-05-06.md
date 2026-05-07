# Fireside Token Usage Baseline - 2026-05-06

Purpose: pre-session-policy baseline for the token-condensation rollout. Phase 2 should compare
against these numbers when validating whether worker/reviewer session reset clears the 50%+
provider-token reduction gate.

## Query Method

- Source DB: `data/fireside.sqlite`
- Window: 7 days ending 2026-05-06T22:56:36.977Z
- Run window: `agent_runs.started_at >= window_start`
- Usage window: `agent_run_actions.created_at >= window_start`
- Usage aggregation: parse `context_usage_json`, exclude `quotaOnly` rows, then take the max
  `usedTokens` per run so repeated provider usage events do not double-count one turn.
- Session-policy proxy: `agent_runs.cli_session_id` non-empty means the run used persistent/resumed
  provider session context. There is no explicit `sessionPolicy` field yet.
- Primary provider attribution: by `agent_runs.agent_id` prefix, not raw `context_usage_json.provider`,
  because provider telemetry currently mismatches on some Gemini-agent runs.

Historical rows do not contain the new `promptSections` diagnostics yet. Section-level deltas start
with runs created after the Phase 1 accounting patch.

## Primary Baseline: Run-Attributed Providers

| Provider | Runs | Live prompt tokens | Avg prompt chars | Usage runs | Provider `usedTokens` | Used/live ratio | Used/usage-live ratio | Raw reported context | Resumed runs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Claude | 1,303 | 5,299,920 | 16,268 | 1,231 | 507,195,717 | 95.7x | 99.2x | 1,272,449,615 | 1,265 (97.1%) |
| Codex | 1,410 | 5,471,155 | 15,520 | 1,110 | 195,372,424 | 35.7x | 43.1x | 44,650,170,824 | 1,060 (75.2%) |
| Gemini | 517 | 1,949,727 | 15,083 | 351 | 52,143,069 | 26.7x | 43.3x | 14,206,766,440 | 480 (92.8%) |
| Total | 3,230 | 12,720,802 | 15,752 | 2,692 | 754,711,210 | 59.3x | 69.6x | 60,129,386,879 | 2,805 (86.8%) |

Interpretation:

- The current all-provider baseline is 754.7M provider `usedTokens` against 12.7M estimated live
  prompt tokens, or 59.3x on all runs.
- Runs with usage telemetry are worse: 754.7M provider `usedTokens` against 10.9M linked live
  prompt tokens, or 69.6x.
- 86.8% of all runs have a stored `cli_session_id`, so persistent/resumed provider context is the
  current default behavior in practice.
- The 50% acceptance gate for Phase 2 should treat `provider usedTokens / live prompt tokens` and
  resumed-run percentage as primary metrics.

## No-Op Outcome Baseline

| Provider | Outcomes | No visible message | No visible + no progress | Prompt tokens spent on no-visible/no-progress | Failed outcomes |
|---|---:|---:|---:|---:|---:|
| Claude | 780 | 385 (49.4%) | 246 (31.5%) | 1,073,390 | 3 |
| Codex | 673 | 473 (70.3%) | 159 (23.6%) | 683,233 | 0 |
| Gemini | 148 | 28 (18.9%) | 27 (18.2%) | 114,160 | 18 |
| Total | 1,601 | 886 (55.3%) | 432 (27.0%) | 1,870,783 | 21 |

Interpretation:

- 27.0% of turn outcomes emitted no visible message and made no progress.
- Those no-visible/no-progress turns consumed 1.87M estimated live prompt tokens before provider
  session amplification.
- No-op dispatch suppression remains a real multiplier after the session-policy gate, but it should
  be evaluated separately from Phase 2 so the session-policy ROI is not hidden by dispatch changes.

## Telemetry Provider Mismatch

Raw `context_usage_json.provider` attribution is not reliable enough for Phase 2 provider-by-provider
gates yet:

- 377 usage rows in the 7-day window have `context_usage_json.provider` disagreeing with the provider
  implied by `agent_runs.agent_id`.
- In the raw telemetry-provider view, Gemini has 517 runs but 0 Gemini usage runs and 0 Gemini
  `usedTokens`.
- The same raw view over-attributes usage to Codex, including Gemini-agent runs recorded as Codex
  usage.

That mismatch is the measurement reason to keep the Gemini telemetry fix in Phase 1. Until it lands,
Phase 2 should use the run-attributed provider view above for rollout-level ROI and treat raw
provider labels as suspect for Gemini.

## Phase 2 ROI Gate

Recommended acceptance comparison after `sessionPolicy` lands:

1. Compare post-policy provider `usedTokens / live prompt tokens` against the 59.3x all-run baseline
   and 69.6x usage-run baseline.
2. Track worker/reviewer resumed-run percentage separately from lead/coordinator resumed-run
   percentage. The total 86.8% resumed baseline should fall sharply only for roles moved to
   `ephemeral` or `reset-after-lane`.
3. Keep no-op dispatch rates visible but do not include Phase 4 suppression wins when claiming the
   Phase 2 session-policy gate.
4. Re-run this same query after Gemini telemetry is fixed so provider labels and run-attributed
   labels agree.
