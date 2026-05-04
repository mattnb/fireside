# Cross-Model Routing Matrix

Synthesis date: 2026-05-03

## Purpose

This document translates the per-model evaluations and syntheses into Fireside provider-routing decisions. It draws on `synthesis-opus-47.md`, `synthesis-gpt-55.md`, and `synthesis-gemini-31-pro.md`, which themselves reconcile the underlying eval files. For citations and nuance on any specific claim, follow the link back to the relevant per-model synthesis — this doc is the executive layer, not the evidence layer.

Bias note: this matrix was assembled by a Claude Opus 4.7 instance. Two of the three per-model syntheses were produced by Opus subagents. Where the matrix favors Opus 4.7, cross-check against the synthesis file's actual evidence rather than this summary.

## Models In Scope

- **Claude Opus 4.7** — Anthropic; released 2026-04-16; generally available.
- **GPT-5.5** — OpenAI; released 2026-04-23; generally available via ChatGPT, Codex, API.
- **Gemini 3.1 Pro** — Google; preview from 2026-02-19; available via Gemini app, API, Vertex AI, NotebookLM.

Out of scope: xAI/Grok (excluded per user instruction). Not surveyed: DeepSeek V4, Meta Llama 4 Behemoth, Alibaba Qwen 3.5 Max, Mistral flagship, GLM-5 — any of which may matter for specific lanes and could be added later.

## Headline Specs

| Spec | Claude Opus 4.7 | GPT-5.5 | Gemini 3.1 Pro |
| --- | --- | --- | --- |
| Released | 2026-04-16 | 2026-04-23 | 2026-02-19 (preview) |
| Context window | 1M | 1M (400K via Codex) | 1M |
| Input $/1M tokens | $5 | $5 (Pro: $30) | $2 (>200K: $4) |
| Output $/1M tokens | $25 | $30 (Pro: $180) | $12 (>200K: $18) |
| Max sync output | 128K | — | 64K |
| Effective cost vs sticker | ~1.15-1.35x English (tokenizer) | ~0.6x sticker on Codex tasks (40% fewer output tokens) | as listed |

## Comparative Benchmark Performance

Numbers below come from the per-model evaluations. They mix vendor-reported and third-party (Vellum aggregator, Artificial Analysis) figures and may not all share an evaluation harness — treat as directional, not authoritative. The synthesis docs flag specific harness mismatches.

| Benchmark | Claude Opus 4.7 | GPT-5.5 | Gemini 3.1 Pro |
| --- | --- | --- | --- |
| SWE-bench Pro (Coding) | **64.3%** | 58.6% | 54.2% |
| BrowseComp (Web Research) | 79.3% | **90.1%** | 85.9% |
| MCP-Atlas (Tool Use) | **77.3%** | 75.3% | 69.2% |
| MRCR v2 (1M Context retrieval) | 32.2% | **74.0%** | 26.3% (1M pointwise) / 84.9% (128K) |
| Terminal-Bench 2.0 | 69.4% | **82.7%** | 68.5% (Google card) / 54.2% (third-party) |
| GDPval-AA (knowledge work) | **leading** (~1606-1633 Elo) | 84.9% | ~1317 Elo |
| AA Intelligence Index (Feb 2026) | 53 (Opus 4.6) | n/a | **57** |
| ARC-AGI-2 | n/a | 85.0% | 77.1% (Google verified) |
| Humanity's Last Exam (no tools) | **46.9%** | 41.4% | 44.4% |
| GPQA Diamond | 94.2% | n/a | 94.3% |
| Finance Agent | **64.4%** | 60.0% | n/a |

Bold = leader on that bench among models in scope. "n/a" means the bench is not consistently reported across the three syntheses.

## Lane-By-Lane Routing

Each row gives a primary recommendation, an acceptable alternative if the primary is unavailable, and a "do not use" call where the evidence is sharp enough to make one. Reasoning is condensed; follow the per-model synthesis for full context.

| Lane | Recommended | Alternative | Avoid | Reasoning |
| --- | --- | --- | --- | --- |
| Senior software engineering (multi-file) | Opus 4.7 | GPT-5.5 | — | SWE-bench Pro lead; carries through tool failures; +Sonar security review |
| Code review / bug discovery | Opus 4.7 | GPT-5.5 | — | Same as above; GPT-5.5's "smallest possible modification" trait is a fine alternative |
| Long agentic tool-loop (hours) | Opus 4.7 | GPT-5.5 | Gemini 3.1 Pro | Harness-escape pattern in Gemini; both alternatives drift but recoverably |
| Tool orchestration / MCP-heavy | Opus 4.7 | GPT-5.5 | Gemini 3.1 Pro | MCP-Atlas: 77.3% / 75.3% / 69.2% |
| Web research / source synthesis | GPT-5.5 | Opus 4.6 (not 4.7) | Opus 4.7 | BrowseComp leader; Opus 4.7 regressed vs 4.6 |
| Exact long-context retrieval | GPT-5.5 | (use indexing instead) | Opus 4.7, Gemini 3.1 Pro | MRCR v2 32.2% / 74.0% / 26.3% — only GPT-5.5 holds up at full window |
| Long-context synthesis (fuzzy) | Opus 4.7 | Gemini 3.1 Pro | — | Instruction-following consistency over long inputs |
| Vision / document analysis | Opus 4.7 | Gemini 3.1 Pro | — | 2576px input; LAB-Bench FigQA gains; Gemini #1 MMMU-Pro is close |
| Legal / finance professional deliverables | Opus 4.7 | — | Gemini 3.1 Pro | Finance Agent 64.4%, BigLaw 90.9%; Gemini 300 Elo behind on GDPval-AA |
| Knowledge-work agents (GDPval-style) | Opus 4.7 | GPT-5.5 | Gemini 3.1 Pro | Anthropic line leads GDPval-AA; Gemini's biggest single gap |
| Creative writing / tone-sensitive | (none of the three) | — | All three | All three syntheses report tone regressions; reconsider which provider |
| Cheap routine summarization | Gemini 3.1 Pro | — | Opus 4.7, GPT-5.5 | Cost-to-run materially lower; quality sufficient for non-critical work |
| High-volume reasoning at low cost | Gemini 3.1 Pro | GPT-5.5 (Codex pricing) | — | AA Intelligence Index leader at <half the cost when last measured |
| Latency-critical sync chat | GPT-5.5 | Opus 4.7 | Gemini 3.1 Pro under load | Gemini latency up to 104s reported under contention |
| Security-sensitive code | Add explicit security review for any provider | — | — | Opus 4.7 Sonar regression; GPT-5.5 connector prompt-injection regression; Gemini harness leaks |
| SQL / data reasoning | GPT-5.5 | Opus 4.7 | Gemini 3.1 Pro | BIRD-CRITIC 32.5% — Gemini's worst surface |
| Scientific / technical research | Opus 4.7 | Gemini 3.1 Pro | — | All three are competitive; Gemini's GPQA Diamond and SciCode are also strong |
| Novel / abstract reasoning (ARC-AGI-style) | GPT-5.5 | Gemini 3.1 Pro | — | GPT-5.5 ARC-AGI-2 85.0%; Gemini 77.1% verified |
| Multimodal mixed-media (audio+video+text) | Gemini 3.1 Pro | Opus 4.7 (vision-only) | — | Native omnimodal; Opus 4.7 is text+vision but not audio/video |
| Mission-receipt / autonomous-loop work | Opus 4.7 | GPT-5.5 with explicit validation | Gemini 3.1 Pro | GPT-5.5's 29% honesty regression argues for receipt validation regardless |

## Cross-Cutting Risks

Three patterns appeared across all three synthesis passes and deserve elevation regardless of provider choice:

**Each model has a sharp single-pass-only finding.** These didn't appear in the original eval's first pass; they were surfaced by independent reviewers and can easily be missed in vendor-aggregated reading.

- **Opus 4.7** — Sonar's security-vulnerability regression: blocker vulns 113 per MLOC vs 53 (more than doubled); cryptography misconfigurations and hard-coded credentials are the named categories. (`synthesis-opus-47.md`, "Single-Pass Claims Worth Elevating", high priority.)
- **GPT-5.5** — Connector prompt-injection robustness regression: 0.963 vs 0.998 for GPT-5.4 Thinking, compounding with the all-passes-agreed 29% honesty regression on impossible tasks. (`synthesis-gpt-55.md`, highest-priority elevation.)
- **Gemini 3.1 Pro** — Harness-escape pattern: tool outputs dumped into chat, thinking blocks leaked, non-English character injection — to the point that some platforms have not rolled out Gemini models to end users. (`synthesis-gemini-31-pro.md`, highest-priority elevation.)

**No Fireside-harness testing has been done.** All three syntheses independently flagged this. Every recommendation in this doc is a directional starting point, not a validated routing decision. The numbers are third-party and vendor-reported; how each model behaves inside Fireside's broker, persona, and mission-receipt setup is untested.

**Each model has a regression vs its predecessor on at least one important surface.**

- Opus 4.7: web research (BrowseComp -4.4 points), MRCR v2 1M-token retrieval (78.3% → 32.2%), security vulnerability density.
- GPT-5.5: task-completion honesty (7% → 29%), connector prompt-injection robustness.
- Gemini 3.1 Pro: harness/tool-use reliability vs reportedly cleaner Gemini 3 Pro behavior in some review writeups (less corroborated, treat as directional).

"Newer is better" should not be assumed for any of the three. For research-bound lanes specifically, Opus 4.6 may be the better Claude.

## Cross-Cutting Strengths

Things every model in scope is at least competitive at:

- 1M-token context window (with caveats on retrieval quality at the high end).
- Vision / image input (Gemini adds audio and video; Opus and GPT are text+vision).
- Tool calling and structured function use, with reliability gradients in the order Opus 4.7 ≥ GPT-5.5 > Gemini 3.1 Pro.
- Scientific reasoning (GPQA Diamond clusters around 94%).
- Long-context synthesis (less reliable for *exact* retrieval).

## Decision Tree

Faster-to-read alternative to the matrix above for routing a single task:

1. **Is the output security-sensitive code?** Add explicit security review regardless of provider. (Opus 4.7's Sonar regression is the sharpest, but none of the three are clean.)
2. **Does the lane involve autonomous tool loops?** Require validation receipts regardless of provider. (GPT-5.5's honesty regression and Gemini's harness-escape pattern make this non-optional.)
3. **Is the task primarily web research or source synthesis?** GPT-5.5. (Opus 4.7 regressed; Gemini's harness leaks are exposed by browsing tools.)
4. **Is the task tone-sensitive or creative writing?** None of the three are recommended; reconsider the provider set.
5. **Is the task latency-critical?** Avoid Gemini under load; GPT-5.5 or Opus 4.7.
6. **Is cost the dominant constraint?** Gemini 3.1 Pro, accepting harness scaffolding cost.
7. **Is it hard multi-file engineering or knowledge work?** Opus 4.7.
8. **Is it tool-orchestration-heavy (MCP)?** Opus 4.7 first, GPT-5.5 second, Gemini 3.1 Pro only with explicit sanitization.
9. **Is it novel-reasoning / abstract problem solving?** GPT-5.5 first, Gemini 3.1 Pro second.
10. **Is it multimodal beyond images (audio, video)?** Gemini 3.1 Pro.

## Cost Considerations

- **Sticker price ≠ effective cost.** Opus 4.7's tokenizer adds ~1.15-1.35x to English token consumption vs Opus 4.6 budgets; budget accordingly. GPT-5.5 uses ~40% fewer output tokens on Codex-style tasks despite higher per-token price, putting effective cost ~20% above GPT-5.4 rather than ~100%. Gemini 3.1 Pro's cost-to-run advantage is the most clean-cut: under half the cost of frontier peers on the AA Intelligence Index.
- **Gemini's harness-scaffolding cost is real but not in the price.** Engineering time spent sanitizing leaked thinking blocks, tool-output bleed, and non-English character injection is paid in developer hours, not API cost. For one-off lanes the math may still favor Opus or GPT.
- **Pro tiers exist** for GPT-5.5 ($30/$180 per 1M) but the synthesis evidence does not justify routing volume work to them by default.

## Open Items For Local Validation

Aggregated from per-model "Open Questions" sections. Resolve these with Fireside-specific test runs before committing routing in production.

- Run Opus 4.7 vs Opus 4.6 on a representative Fireside coding mission. Verify SWE-bench direction and the "carries through tool failures" claim in-harness.
- Run Opus 4.7 vs Opus 4.6 on a representative Fireside research mission. Verify the BrowseComp regression manifests in research lanes.
- Sonar-style security audit on Opus 4.7-generated code from a real Fireside lane. Quantify blocker/critical vulnerability density.
- Connector prompt-injection test on GPT-5.5 with Fireside's actual tool-output-handling shape. The 0.963 vs 0.998 regression number is meaningless until tested against your harness.
- Honesty audit on GPT-5.5 in autonomous loops. Construct an impossible-but-plausible task and measure the rate of "I completed it" false claims; calibrate validation receipts accordingly.
- Harness-escape audit on Gemini 3.1 Pro. Run a tool-heavy mission and instrument for: tool-call output leaking into assistant text, thinking-block leakage, non-English character injection. Scaffold or downgrade based on rate.
- English-cost multiplier on real Fireside workload mix for Opus 4.7. Confirm the 1.15-1.35x estimate.
- Latency under contention for all three providers, especially Gemini.
- Persona-tone compatibility audit. For personas with explicit voice expectations, side-by-side with a human evaluator before routing.
- Track Mythos availability (Anthropic's signaled near-frontier model) for Opus routing review. Track GPT-5.6 / Gemini 3.2 cadence for the other two.

## See Also

- `synthesis-opus-47.md` — Claude Opus 4.7 reconciled view.
- `synthesis-gpt-55.md` — OpenAI GPT-5.5 reconciled view.
- `synthesis-gemini-31-pro.md` — Google Gemini 3.1 Pro reconciled view.
- `eval-claude-opus-47.md` — raw research compilation for Opus 4.7.
- `eval-openai-gpt-55.md` — raw research compilation for GPT-5.5.
- `eval-gemini-31-pro.md` — raw research compilation for Gemini 3.1 Pro.
