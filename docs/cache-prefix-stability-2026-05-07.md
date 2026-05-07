# Cache Prefix Stability - 2026-05-07

Purpose: document the Phase 5 cache-prefix stability check after `protocols.md` externalization,
stable-prefix diagnostics, and provider-billed cache telemetry landed.

## Source

- Room: `5YZGXgDK6e5M` (`fireside efficiency`)
- Database: `data/fireside.sqlite`
- Window cutoff: `2026-05-07T00:26:47.019Z`, when Matt confirmed the non-watch restart.
- Metrics:
  - Consecutive prompt diagnostics with identical `stablePrefixHash` per agent. This remains the
    cache-hit proxy for stable prompt-prefix bytes before provider usage is available.
  - Claude provider result telemetry when emitted by the CLI: `cache_read_input_tokens` and
    `cache_creation_input_tokens` are now preserved in `AgentContextUsage`, included in usage action
    detail text, and rolled into status-snapshot token buckets.

## Results

| Agent                       | Prompt rows | Unique stable-prefix hashes | Consecutive hash hits | Hit-rate proxy |                              Stable prefix |
| --------------------------- | ----------: | --------------------------: | --------------------: | -------------: | -----------------------------------------: |
| `claude-principal-software` |           9 |                           1 |                 8 / 8 |         100.0% |             5,231 chars / 1,308 est tokens |
| `codex-performance`         |           7 |                           2 |                 5 / 6 |          83.3% | 4,556-4,638 chars / 1,139-1,160 est tokens |

Claude's worker prompt prefix was byte-stable across every post-restart transition in the observed
window: hash `11314cd80d17c2aab53e182f19ee5a21ae7e4b7de0f4aec8e36a6af33e68e1a8`.

Codex had one prompt-shape transition at the start of the window:

- First hash: `0fb299b10e03cc70c616e8e04fa1e619b572c9b37ab96b5aafc9cf8588c66870`
- Subsequent recurring hash: `c1790108d8d57ee487b0ec64d198ada9934b0cdbaec9e3600f55030ba98b9c8d`

That first miss is attributable to a dispatch/work-lane prompt shape switching to the recurring
coordination/verification shape. After that switch, Codex's stable prefix stayed stable in the
observed window.

## Gate Read

Phase 5's prompt-shape requirements are satisfied:

- Room-local `protocols.md` exists and the live prompt points to it instead of inlining full hidden
  block schemas by default.
- Prompt diagnostics expose `stablePrefixChars`, `stablePrefixEstimatedTokens`, and
  `stablePrefixHash`.
- Stable sections are separated from dynamic mission state, ledger, budget notices, and transcript
  tail fields.
- Claude turns pass `--exclude-dynamic-system-prompt-sections` by default, with
  `FIRESIDE_CLAUDE_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS=0` as an emergency opt-out, so
  per-machine default-system-prompt sections do not poison provider cache reuse ahead of Fireside's
  stable prompt bytes.
- Regression coverage exists in `server/tests/unit/transcript.test.ts` for stable prefix bytes/hash
  across dynamic turns.
- Regression coverage exists in `server/tests/unit/claude.test.ts` proving provider-billed
  `cache_read_input_tokens` and `cache_creation_input_tokens` survive Claude stream-result parsing
  into usage action details.
- Post-restart diagnostics show stable-prefix hash reuse in real room traffic.

Residual caveat: the stable-prefix hash is still only a predictor. The direct billing metric is now
the provider-emitted cache-read/create counters, so final ROI should compare the proxy hit rate
against post-patch Claude usage rows that contain positive `cache_read_input_tokens`.
