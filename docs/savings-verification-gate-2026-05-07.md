# Savings Verification Gate - 2026-05-07

Purpose: define the repeatable final gate for the "durable role session policy + lead lifecycle
reset + compaction accounting" execution mission. This is a gate harness and rollout note, not a
pass claim; the implementation has not yet run through a post-restart 24h sample.

## Gate Command

Use the verifier after Matt restarts the non-watch server with the implemented lanes:

```powershell
node scripts/verify-token-savings-gate.mjs `
  --room 5YZGXgDK6e5M `
  --since <post-restart-iso> `
  --until <post-restart-plus-24h-iso>
```

For the default rolling 24h query:

```powershell
node scripts/verify-token-savings-gate.mjs --room 5YZGXgDK6e5M
```

The script calls `scripts/measure-run-kind-baseline.mjs --json`, so the run-kind query and the
final gate share one source of truth.

## Baseline Constants

Source: `docs/run-kind-baseline-2026-05-07.md`, captured before Lane 1 source edits.

| Metric | Baseline |
| --- | ---: |
| All-provider tokens | 9,557,288 |
| Normal + maintenance provider tokens | 9,257,296 |
| Normal turns | 49 |
| Normal live prompt tokens | 187,424 |
| No visible + no progress rate | 35.2% |
| Failed outcomes | 0 |
| Workflow repair rate | 7.0% |
| Mission receipt count per turn | 52.1% |

## Savings Normalization

A 24h soak will not have the same traffic volume as the 0.81h pre-source-edit baseline slice, so
the gate does not compare absolute provider tokens directly. It requires both normalized savings
metrics to clear the same threshold:

1. Normal + maintenance provider tokens per normal turn must fall by at least 25%.
2. Normal + maintenance provider tokens per normal live prompt token must fall by at least 25%.

Baseline thresholds:

| Metric | Baseline | Required max for pass |
| --- | ---: | ---: |
| Normal + maintenance provider tokens per normal turn | 188,924 | 141,693 |
| Normal + maintenance provider/live token ratio | 49.39x | 37.04x |

The first metric captures operating cost including `/compact` overhead. The second guards against a
traffic mix artifact where fewer but larger turns make per-run cost look better while token
amplification remains high.

## Fidelity Guards

Savings only count if these counters do not regress:

| Guard | Pass condition |
| --- | --- |
| No visible + no progress rate | `<= 35.2%` |
| Failed outcomes | `<= 0` |
| Workflow repair rate | `<= 7.0%` |
| Mission receipt count per turn | `>= 52.1%` |
| Post-reset first-turn cost | reported separately, not averaged away |

The broader fidelity contract still applies: no missed handoffs, no missed Mission Control updates,
post-reset coordination stays clean, and sampled routing/mission-state decisions remain equivalent.
Those require manual review or future persisted markers beyond the scalar DB counters above.

## Dry Run Against Current DB

Command:

```powershell
node scripts/verify-token-savings-gate.mjs --room 5YZGXgDK6e5M --since 2026-05-07T00:26:47.019Z
```

Result at 2026-05-07T01:21:20.261Z:

- Gate result: **NOT PASSED**
- 24h window ready: no (0.91h window)
- Traffic floor ready: yes
- Current all-provider tokens: 9,982,853
- Current normal + maintenance provider tokens: 9,682,861
- Current normal turns: 51
- Current normal live prompt tokens: 194,602
- Current post-reset first turns: 0

| Guard | Result | Baseline | Current | Value |
| --- | --- | ---: | ---: | ---: |
| Normal + maintenance cost per normal turn | fail | 188,924 provider/run | 189,860 provider/run | -0.5% reduction |
| Normal + maintenance cost per normal live token | fail | 49.39x | 49.76x | -0.7% reduction |
| No visible + no progress rate | pass | 35.2% | 35.1% | 35.1% |
| Failed outcomes | pass | 0 | 0 | 0 |
| Workflow repair rate | pass | 7.0% | 6.8% | 6.8% |
| Mission receipt count per turn | fail | 52.1% | 50.0% | 50.0% |

This failure is expected. The dry run is still measuring pre-runtime-change behavior, and no
`post-reset.first-turn` rows exist before Lane 2 writes persisted run kinds.

## Rollout Sequence

1. Finish Lane 1, Lane 2, and Lane 3 source changes.
2. Matt restarts the non-watch server.
3. Record the restart timestamp as the verification `--since` value.
4. Let the room run for 24h or enough representative mission traffic.
5. Run `scripts/verify-token-savings-gate.mjs`.
6. If both normalized savings guards and all scalar fidelity guards pass, perform the manual fidelity
   review for missed handoffs/Mission Control state and post-reset decision quality.
7. Only then mark the mission savings gate complete.

## Current Status

Blocked on post-implementation runtime data. The gate harness and rollout notes are ready; the
actual pass/fail verdict must wait for source changes to run after restart and for a 24h sample to
exist.

## Post-restart Marker

Matt restarted the server after implementation. The first lower bound for post-restart sampling is
the actual `node --enable-source-maps dist/server/src/index.js` process start, not the chat message
timestamp:

- Server process id: 44644
- Server start: 2026-05-07T02:25:23.352Z
- Server start ms: 1778120723352
- Query: `node scripts/measure-run-kind-baseline.mjs --room 5YZGXgDK6e5M --since 1778120723352`

Initial result: zero completed measurable turns. The only completed post-marker row at the time of
the first query was an interrupted failed process with no outcome row and no provider usage, so the
measurement script now excludes rows that have neither an `agent_turn_outcomes` row nor a
provider-usage row. This keeps aborted local process noise and context-reset markers out of turn ROI
and fidelity counters.

The DB schema now has `agent_turn_outcomes.run_kind`, and the measurement script reports
`Persisted run_kind column present: yes`. The next query should begin showing populated buckets
after new-runtime agent turns complete.

## Early Post-restart Sample

Command:

```powershell
node scripts/verify-token-savings-gate.mjs --room 5YZGXgDK6e5M --since 1778120723352 --json
```

Result at 2026-05-07T02:42:19.699Z:

- Gate result: **NOT PASSED**
- 24h window ready: no (0.28h window)
- Traffic floor ready: no (2 completed measurable normal turns)
- Current normal + maintenance provider tokens: 259,527
- Current normal turns: 2
- Current normal live prompt tokens: 7,234
- Worker resumed-session rows: 0
- Workflow repair provider tokens: 0

| Guard | Result | Baseline | Current | Value |
| --- | --- | ---: | ---: | ---: |
| Normal + maintenance cost per normal turn | pass | 188,924 provider/run | 129,764 provider/run | 31.3% reduction |
| Normal + maintenance cost per normal live token | pass | 49.39x | 35.88x | 27.4% reduction |
| No visible + no progress rate | pass | 35.2% | 0.0% | 0.0% |
| Failed outcomes | pass | 0 | 0 | 0 |
| Workflow repair rate | pass | 7.0% | 0.0% | 0.0% |
| Mission receipt count per turn | fail | 52.1% | 50.0% | 50.0% |

This is useful directional signal only. The sample is too small and too young to close the savings
gate, but it confirms the post-restart instrumentation is now producing measurable rows with
persisted `normal.turn` buckets and worker fresh-session behavior.

## Follow-up Post-restart Pulse

Command:

```powershell
node scripts/verify-token-savings-gate.mjs --room 5YZGXgDK6e5M --since 1778120723352 --json
```

Result at 2026-05-07T03:05:29.928Z:

- Gate result: **NOT PASSED**
- 24h window ready: no (0.67h window)
- Traffic floor ready: no (6 completed measurable normal turns)
- Current normal + maintenance provider tokens: 1,070,301
- Current normal turns: 6
- Current normal live prompt tokens: 22,540
- Post-reset first turns: 4
- Post-reset first-turn provider tokens: 395,701
- Workflow repair provider tokens: 47,393 across 1 row

| Guard | Result | Baseline | Current | Value |
| --- | --- | ---: | ---: | ---: |
| Normal + maintenance cost per normal turn | fail | 188,924 provider/run | 178,384 provider/run | 5.6% reduction |
| Normal + maintenance cost per normal live token | fail | 49.39x | 47.48x | 3.9% reduction |
| No visible + no progress rate | pass | 35.2% | 9.1% | 9.1% |
| Failed outcomes | pass | 0 | 0 | 0 |
| Workflow repair rate | fail | 7.0% | 9.1% | 9.1% |
| Mission receipt count per turn | fail | 52.1% | 36.4% | 36.4% |

This pulse is still too small to close the gate. It also should not be used to judge the new
mechanical-model routing: the only workflow-repair row in the sample started at
2026-05-07T02:51:00.576Z and still used `claude-opus-4-7`, before the Haiku routing patch had been
restarted into the running server. The direct Claude usage rows do show provider-billed cache
telemetry after the cache-prefix change, including `cache_read_input_tokens` on repeated Claude
normal turns.

## Second Follow-up Post-restart Pulse

Command:

```powershell
node scripts/verify-token-savings-gate.mjs --room 5YZGXgDK6e5M --since 1778120723352 --json
```

Result at 2026-05-07T03:18:51.501Z:

- Gate result: **NOT PASSED**
- 24h window ready: no (0.89h window)
- Traffic floor ready: no (8 completed measurable normal turns)
- Current normal + maintenance provider tokens: 1,210,888
- Current normal turns: 8
- Current normal live prompt tokens: 29,443
- Post-reset first turns: 4
- Post-reset first-turn provider tokens: 395,701
- Workflow repair provider tokens: 47,393 across 1 row

| Guard | Result | Baseline | Current | Value |
| --- | --- | ---: | ---: | ---: |
| Normal + maintenance cost per normal turn | fail | 188,924 provider/run | 151,361 provider/run | 19.9% reduction |
| Normal + maintenance cost per normal live token | fail | 49.39x | 41.13x | 16.7% reduction |
| No visible + no progress rate | pass | 35.2% | 15.4% | 15.4% |
| Failed outcomes | pass | 0 | 0 | 0 |
| Workflow repair rate | fail | 7.0% | 7.7% | 7.7% |
| Mission receipt count per turn | fail | 52.1% | 30.8% | 30.8% |

The sample has more data and the normalized savings direction improved, but it still misses the
25% savings threshold and remains too small/young to close the gate. It still has only one
workflow-repair row, the same pre-Haiku-routing `claude-opus-4-7` row from
2026-05-07T02:51:00.576Z, so mechanical routing still has no representative validation sample.

## Third Follow-up Post-restart Pulse

Command:

```powershell
node scripts/verify-token-savings-gate.mjs --room 5YZGXgDK6e5M --since 1778120723352 --json
```

Result at 2026-05-07T04:50:29.520Z:

- Gate result: **NOT PASSED**
- 24h window ready: no (1.42h window)
- Traffic floor ready: no (13 completed measurable normal turns)
- Current normal + maintenance provider tokens: 1,836,000
- Current normal turns: 13
- Current normal live prompt tokens: 47,958
- Post-reset first turns: 6
- Post-reset first-turn provider tokens: 586,294
- Workflow repair provider tokens: 47,393 across 1 row

| Guard | Result | Baseline | Current | Value |
| --- | --- | ---: | ---: | ---: |
| Normal + maintenance cost per normal turn | pass | 188,924 provider/run | 141,231 provider/run | 25.2% reduction |
| Normal + maintenance cost per normal live token | fail | 49.39x | 38.28x | 22.5% reduction |
| No visible + no progress rate | pass | 35.2% | 10.0% | 10.0% |
| Failed outcomes | pass | 0 | 0 | 0 |
| Workflow repair rate | pass | 7.0% | 5.0% | 5.0% |
| Mission receipt count per turn | fail | 52.1% | 25.0% | 25.0% |

This pulse is directionally better on normalized cost per turn, but the gate remains blocked:
the 24h and 20-normal-turn floors are not met, provider/live savings still misses the 25% target,
and the mission-receipt fidelity guard is still materially below baseline. Mechanical-routing
savings still lack a post-Haiku workflow-repair or maintenance-compaction sample.
