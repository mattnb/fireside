# Run-kind Baseline - 2026-05-07

Purpose: pre-execution baseline for the "durable role session policy + lead lifecycle reset +
compaction accounting" mission. This snapshot was taken before the Lane 1 source fix so the worker
session-policy leak and current compaction overhead remain visible.

## Query Method

- Script: `node scripts/measure-run-kind-baseline.mjs --room 5YZGXgDK6e5M --since 2026-05-07T00:26:47.019Z`
- Source DB: `data/fireside.sqlite`
- Room: `5YZGXgDK6e5M`
- Window: 2026-05-07T00:26:47.019Z to 2026-05-07T01:15:10.097Z
- Persisted `run_kind` column present: no
- Classification mode: heuristic fallback
- Usage aggregation: max non-quota `usedTokens` per run from
  `agent_run_actions.context_usage_json`
- Prompt hygiene: stored prompts and message text are used only for boolean classification and are
  not emitted by the script.

Current rows do not yet persist `run_kind`. The script detects the column and will prefer persisted
values after Lane 2 instrumentation lands. For this snapshot:

- `maintenance.compaction` is classified from exact `/compact` run prompts.
- `workflow.repair` is classified from system-triggered workflow repair messages.
- `normal.turn` is the default fallback for all other runs.
- `post-reset.first-turn` cannot be inferred reliably before lead-reset instrumentation writes it
  explicitly.

## Totals

- Runs: 71
- Tasks represented: 3
- Usage runs: 68
- Live prompt tokens: 206,398
- Provider tokens: 9,557,288
- Provider/live ratio: 46.31x
- Normal + maintenance provider baseline: 9,257,296
- Workflow repair provider tokens: 299,992

The savings gate should report both all-provider spend and the planned normal+maintenance baseline.
The locked mission target is an additional 25% reduction against post-rollout normal+maintenance
spend, while workflow repair short-circuiting remains a separately measured additive win.

## By run kind

| Bucket | Runs | Usage runs | Live tokens | Provider tokens | Provider/live | Provider share | Resumed | No visible + no progress |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `normal.turn` | 49 | 49 | 187,424 | 6,687,394 | 35.68x | 70.0% | 39 (79.6%) | 4 (8.2%) |
| `maintenance.compaction` | 17 | 14 | 34 | 2,569,902 | 75585.35x | 26.9% | 17 (100.0%) | 17 (100.0%) |
| `workflow.repair` | 5 | 5 | 18,940 | 299,992 | 15.84x | 3.1% | 3 (60.0%) | 4 (80.0%) |

## By role and session

| Bucket | Runs | Usage runs | Live tokens | Provider tokens | Provider/live | Provider share | Resumed | No visible + no progress |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `lead.resumed` | 41 | 41 | 102,380 | 6,461,080 | 63.11x | 67.6% | 41 (100.0%) | 19 (46.3%) |
| `worker.resumed` | 18 | 15 | 57,172 | 2,472,786 | 43.25x | 25.9% | 18 (100.0%) | 4 (22.2%) |
| `worker.fresh` | 12 | 12 | 46,846 | 623,422 | 13.31x | 6.5% | 0 (0.0%) | 2 (16.7%) |

## By agent

| Bucket | Runs | Usage runs | Live tokens | Provider tokens | Provider/live | Provider share | Resumed | No visible + no progress |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `codex-performance` | 41 | 41 | 102,380 | 6,461,080 | 63.11x | 67.6% | 41 (100.0%) | 19 (46.3%) |
| `claude-principal-software` | 30 | 27 | 104,018 | 3,096,208 | 29.77x | 32.4% | 18 (60.0%) | 6 (20.0%) |

## Fidelity Baseline

- No visible + no progress turns: 25 (35.2%)
- Failed outcomes: 0
- Mission updates: 19
- Mission receipts: 37
- Mission reconciliations: 3
- Collaboration notes: 24

These numbers are the minimum fidelity counters to compare after each lane ships. They are not the
full fidelity contract; post-reset coordination cleanliness and decision-consistency sampling require
the Lane 2 reset markers to exist first.

## Coordination Decisions

- Run-kind vocabulary is locked as `normal.turn`, `maintenance.compaction`, `workflow.repair`, and
  `post-reset.first-turn`.
- Pending lead-reset state can be in-memory for v1. A process restart loses the pending marker, but
  the next phase boundary or threshold crossing re-arms it without adding DB write amplification.
- `LEAD_RESET_PERCENT=60` is a reasonable default for the controlled sample. It is intentionally
  conservative: current compaction maintenance is 26.9% of observed provider spend, so avoiding
  `/compact` pressure matters more than squeezing one extra cached lead turn.
- The schema migration mechanic should match the existing DB pattern: `CREATE TABLE IF NOT EXISTS`
  plus `PRAGMA table_info`/`ALTER TABLE` in `ensureAgentTurnOutcomeTables`. Add nullable
  `run_kind TEXT` and keep old rows compatible with heuristic fallback.

## Interpretation

The baseline confirms the execution order:

1. Worker freshness is still leaking: resumed workers consumed 2.47M provider tokens at 43.25x,
   while fresh workers in the same window were 13.31x.
2. Long-lived leads dominate spend: resumed lead turns consumed 6.46M provider tokens at 63.11x.
3. `/compact` maintenance is not incidental: it consumed 2.57M provider tokens, 26.9% of observed
   provider spend in this window.
4. Workflow repair turns are smaller but measurable at 300k provider tokens.

Lane 1 can now proceed with a clean pre-source-edit baseline. Lane 2 should write persisted
`run_kind` values so this same script becomes the post-change measurement query instead of relying
on heuristics.
