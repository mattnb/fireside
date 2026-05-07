# SessionPolicy ROI Gate Attempt - 2026-05-06

Purpose: record the first Phase 2 verification attempt and why the ROI gate cannot be accepted yet.

## Gate

Acceptance target: demonstrate at least 50% provider-token reduction on a sampled YOLO loop after
`sessionPolicy` rollout, without increasing malformed/no-progress turns, measured against the Phase
1 baseline in `docs/token-usage-baseline-2026-05-06.md`.

Baseline anchors:

- Provider/live ratio across all runs: 59.3x.
- Provider/live ratio across runs with usage telemetry: 69.6x.
- Resumed-session proxy: 86.8% of runs had non-empty `cli_session_id`.
- No-visible/no-progress baseline: 27.0% of outcomes.

## Attempted Post-Implementation Window

Query window started at 2026-05-06T22:52:46.811Z, the start time of the sessionPolicy implementation
lane visible in `agent_runs`.

Post-implementation sample:

| Metric | Value |
|---|---:|
| Runs | 7 |
| Completed terminal runs | 5 |
| Live prompt tokens | 23,961 |
| Runs with context usage | 5 |
| Usage-linked live prompt tokens | 16,515 |
| Provider `usedTokens` | 1,076,240 |
| Provider/live ratio, all runs | 44.9x |
| Provider/live ratio, usage runs | 65.2x |
| Runs with non-empty `cli_session_id` | 5 / 7 (71.4%) |

Observed runs:

| Started | Agent | Status | `cli_session_id` present | Live tokens | Provider `usedTokens` |
|---|---|---|---:|---:|---:|
| 2026-05-06T22:52:46.811Z | claude-principal-software | completed | yes | 3,942 | 236,573 |
| 2026-05-06T22:52:46.830Z | codex-performance | completed | yes | 4,146 | 162,750 |
| 2026-05-06T23:03:21.126Z | claude-principal-software | completed | yes | 4,310 | 270,081 |
| 2026-05-06T23:03:21.144Z | codex-performance | completed | yes | 4,115 | 202,237 |
| 2026-05-06T23:09:54.052Z | codex-performance | completed | yes | 2 | 204,599 |
| 2026-05-06T23:09:54.070Z | claude-principal-software | running | no | 3,525 | 0 |
| 2026-05-06T23:10:41.908Z | codex-performance | running | no | 3,921 | 0 |

Outcome sample since the same cutoff:

| Agent | Outcomes | No visible | No visible + no progress |
|---|---:|---:|---:|
| claude-principal-software | 2 | 0 | 0 |
| codex-performance | 2 | 0 | 0 |

## Blocker

This is not a valid sessionPolicy ROI sample yet.

Evidence:

- The active room `agent_profiles_json` has no `sessionPolicy` field on either `codex-performance`
  or `claude-principal-software`.
- The implementation intentionally preserves the default `compacting` policy unless a profile sets
  `sessionPolicy` explicitly, or the global resume kill-switch is off.
- 5 of the 7 post-implementation runs still have non-empty `cli_session_id`.
- No completed post-implementation run can be tied to an explicit `ephemeral` or `reset-after-lane`
  policy in persisted diagnostics.

Therefore the observed 44.9x all-run ratio is not proof that sessionPolicy clears the 50% gate. It is
mostly compacting-default traffic and cannot be compared as the rollout sample.

## Required Next Step

Run a controlled sample where the worker/reviewer agents in this room have explicit
`sessionPolicy: "ephemeral"` or `sessionPolicy: "reset-after-lane"` in `rooms.agent_profiles_json`,
then re-run the ROI query.

Recommended minimum sample:

- At least 6 completed worker/reviewer turns under explicit `ephemeral` or `reset-after-lane`.
- Keep lead/coordinator agents on `compacting` or `persistent`.
- Record for each run: agent id, policy, live prompt tokens, `cli_session_id` presence, provider
  `usedTokens`, visible-message outcome, and progress outcome.

Do not mark the Phase 2 ROI gate done until that sample exists.

## Controlled Sample Setup Attempt

Attempt time: 2026-05-06T23:36Z+.

Active room: `5YZGXgDK6e5M` (`fireside efficiency`).

Persisted room profile configuration now sets:

| Agent | Role in room | `sessionPolicy` |
|---|---|---|
| `codex-performance` | room lead | `compacting` |
| `claude-principal-software` | worker/reviewer | `ephemeral` |

This is the intended controlled-sample shape: the non-lead worker/reviewer gets explicit
`ephemeral`, while the room lead stays on the resumed/compacting policy used for coordination.

## Runtime Blocker (Resolved)

Earlier, the controlled sample was not valid because the running non-watch server had not loaded the
post-implementation server code that honors `sessionPolicy`.

Evidence from latest `agent_run_actions` in room `5YZGXgDK6e5M`:

- Latest prompt action details include `promptSections`, which proves the Phase 1 measurement patch
  is active.
- Latest prompt action details do not include `stablePrefixHash`, which proves the server has not
  loaded the later cache-prefix diagnostics patch.
- Latest prompt action details do not include any `sessionPolicy` field or policy diagnostic.

Therefore, any turns run before Matt restarted the non-watch server would have measured the old
runtime and would not prove the explicit `ephemeral` policy path.

Resolved: Matt confirmed the server is now in non-watch mode and restarted at
2026-05-07T00:26:47.019Z. Post-restart prompt diagnostics now include `stablePrefixHash`,
`sessionPolicy`, and `resumeCliSession`.

## Measurement Guard Added Before Sample

Follow-up check found one more measurement hazard: provider adapters can return a new `sessionId`
even for a fresh non-resumed turn. The broker used to persist that returned id into
`agent_runs.cli_session_id` regardless of policy, which would make the ROI query falsely classify
explicit `ephemeral` turns as resumed.

The current tree now guards this:

- `prepareAgentTurnContext` sends `sessionId: null` to the provider whenever
  `sessionPolicy === "ephemeral"`, even if `sessions` still contains an older durable id for that
  agent.
- Broker prompt diagnostics include both `sessionPolicy` and `resumeCliSession`, so the ROI query can
  filter on the actual policy decision rather than only the historical `cli_session_id` proxy.
- Broker run completion only stores `agent_runs.cli_session_id` when the policy allows resume.
  Explicit `ephemeral` turns keep the run row `cli_session_id` null even if the provider returns a
  fresh session id.
- The ROI query must classify resumed-provider-context turns from the prompt diagnostic
  `resumeCliSession` value, not by inferring it from `sessionPolicy`. `sessionPolicy` selects the
  rollout cohort; `resumeCliSession` records the actual per-turn resume decision. This matters for
  `reset-after-lane`, which is allowed to resume within a lane and should count as resumed until the
  lane boundary clears the stored session.

Regression coverage: `server/tests/integration/broker-echo.test.ts` asserts an `ephemeral` agent with
an old stored durable session is invoked with `sessionId: null`, records `cliSessionId: null` on the
run row, and emits prompt diagnostics `{ sessionPolicy: "ephemeral", resumeCliSession: false }`.

## Controlled Sample In Progress

Clean sample cutoff: 2026-05-07T00:26:47.019Z, when Matt confirmed the non-watch server restart.

Current provider/session-valid worker/reviewer sample: 6 / 6 completed turns.

| Started | Run | Agent | `sessionPolicy` | `resumeCliSession` | `cli_session_id` present | Live tokens | Provider `usedTokens` | Outcome |
|---|---|---|---|---:|---:|---:|---:|---|
| 2026-05-07T00:27:25.721Z | `RYpJWmD1zdE6O9Kn` | `claude-principal-software` | `ephemeral` | false | no | 3,794 | 47,157 | visible + progress, 1 mission receipt |
| 2026-05-07T00:28:51.008Z | `k7dGc3FWeHXnFaKq` | `claude-principal-software` | `ephemeral` | false | no | 3,924 | 47,318 | visible + progress, 1 mission receipt |
| 2026-05-07T00:29:59.750Z | `26Ur3a6i_Iyu51QX` | `claude-principal-software` | `ephemeral` | false | no | 3,806 | 47,262 | visible + progress, 1 mission receipt |
| 2026-05-07T00:30:51.734Z | `ew3i0rCl3FGnOUIJ` | `claude-principal-software` | `ephemeral` | false | no | 3,936 | 47,432 | visible + progress, 0 mission receipts |
| 2026-05-07T00:32:08.390Z | `uWoQefRlv9NscqCe` | `claude-principal-software` | `ephemeral` | false | no | 3,987 | 47,632 | visible + progress, 1 mission receipt |
| 2026-05-07T00:32:57.202Z | `Jbb9AJJrlP4fR7qO` | `claude-principal-software` | `ephemeral` | false | no | 3,939 | 47,631 | visible + progress, 1 mission receipt |

Receipt-quality note: `ew3i0rCl3FGnOUIJ` is valid for provider-token/session-policy measurement, but
it missed the requested mission receipt. Keep this visible in the malformed/contract-quality check
before accepting the ROI gate.

Lead/coordinator turns remain excluded from the worker/reviewer sample. Latest Codex lead prompt
after the same cutoff is `sessionPolicy: "compacting"` with `resumeCliSession: true`, which verifies
the runtime is current but is not part of the ephemeral worker cohort.

## Controlled Sample Result

Sample totals:

| Metric | Value |
|---|---:|
| Completed worker/reviewer turns | 6 |
| Turns with `sessionPolicy: "ephemeral"` | 6 / 6 |
| Turns with `resumeCliSession: false` | 6 / 6 |
| Turns with non-empty `cli_session_id` | 0 / 6 |
| Live prompt tokens | 23,386 |
| Provider `usedTokens` | 284,432 |
| Provider/live ratio | 12.16x |
| No visible message | 0 / 6 |
| No visible + no progress | 0 / 6 |
| Missing mission receipt | 1 / 6 |

Compared with the Phase 1 baseline:

| Comparison | Baseline ratio | Sample ratio | Reduction |
|---|---:|---:|---:|
| Usage-linked provider/live ratio | 69.6x | 12.16x | 82.5% |
| All-run provider/live ratio | 59.3x | 12.16x | 79.5% |

The controlled sample clears the 50% provider-token reduction target. The no-visible/no-progress rate
is 0%, better than the 27.0% Phase 1 baseline. One turn triggered a missing-receipt repair, so rollout
should keep receipt compliance visible, but the token and no-progress gates pass on this sample.
