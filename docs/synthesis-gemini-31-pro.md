# Gemini 3.1 Pro Synthesis

Synthesis date: 2026-05-03

## Purpose

This document reconciles the multiple independent research passes on Google Gemini 3.1 Pro contained in `docs/eval-gemini-31-pro.md` (the original eval, the appended "Independent Synthesis Pass (2026-05-03)", and the "Independent Research Update (May 2026)") into a single working view for Fireside provider-routing decisions. The methodology is to corroborate claims across passes, flag contradictions explicitly, and elevate uncorroborated-but-credible single-pass findings as risk items rather than facts. Bias note: the synthesizer is Claude Opus 4.7 evaluating a competing vendor's flagship; framing has been kept neutral and the GDPval-AA gap (where Anthropic models lead) is reported as the source passes report it, not amplified.

## Reconciled Facts (High Confidence)

### Release, status, and surfaces

- Announced and released into preview on **2026-02-19** via Gemini API, Vertex AI, the Gemini app, AI Studio, and NotebookLM. Original eval and Synthesis Pass both state this date; the May 2026 update confirms it.
- API model id: `gemini-3.1-pro-preview` (and `gemini-3.1-pro-preview-customtools` for custom tools). Original eval; not contradicted.
- Status remains **preview**, not GA, as of 2026-05-03. Original eval; Synthesis Pass treats it the same.
- Gemini 3 Pro Preview has been deprecated in favor of 3.1 Pro. Original eval.

### Pricing

- **$2.00 per 1M input tokens** and **$12.00 per 1M output tokens** for prompts <= 200k. Corroborated by original eval (Google pricing docs), Synthesis Pass (citing Artificial Analysis), and the May 2026 update.
- Above 200k tokens: $4 input / $18 output. Original eval only, but sourced to Google pricing docs; treat as high confidence.
- Output pricing **includes thinking tokens**. Original eval. This matters for cost modeling.
- Cheaper batch/flex tiers exist; priority inference is more expensive; grounding has separate query pricing. Original eval.

### Context window and I/O

- **1M-token context window** (May 2026 update mentions "1M to 2M depending on tier" but the canonical figure across all three passes is 1M).
- **64k max output tokens.** Original eval.
- Native multimodal inputs: text, image, audio, video, PDFs, code repos. All three passes agree.
- New `thinking_level` parameter with a MEDIUM tier added alongside existing levels. Synthesis Pass.

### Speed

- **~114 output tokens/second** (Artificial Analysis). Original eval and Synthesis Pass agree on 114; May 2026 update widens the range to **104–121 tok/s**, which is consistent.

### Agreed strengths

1. **Top of the Artificial Analysis Intelligence Index in February 2026.** Original eval describes it as a top Intelligence Index model; Synthesis Pass quantifies the lead at **57 vs Claude Opus 4.6 at 53 and Sonnet 4.6 at 51**, leading 6 of the 10 sub-evals. May 2026 update reports Gemini at 57, GPT-5.4/5.5 at 60 — note the divergence on who leads (see Divergent Claims).
2. **Large hallucination reduction vs Gemini 3 Pro Preview** on AA-Omniscience. Original eval says "large reduction"; Synthesis Pass quantifies it at **38 percentage points (88% → 50% incorrect-when-uncertain)**.
3. **Multimodal leadership.** Both eval passes cite **MMMU-Pro 80.5%** (Google card) and a #1 ranking on AA's MMMU-Pro snapshot.
4. **Cost-to-run is the lowest of the frontier-flagship class.** Synthesis Pass cites AA's full Intelligence Index run cost at **~$892**, "under half" comparable peers; May 2026 update calls it the "price-performance champion" and cites ~7.5x cheaper than Claude Opus 4.6 on input tokens. Both passes agree on direction and rough magnitude.
5. **One-shot constrained code generation works well** (SVG, simulations, isolated utilities). Original eval and Synthesis Pass agree.

### Agreed weaknesses

1. **GDPval-AA real-world expert tasks lag.** Original eval cites Google's own card at GDPval-AA Elo **1317**; Synthesis Pass corroborates ~1317 and quantifies the gap at "nearly 300 Elo behind Sonnet 4.6 (~1633) and Opus 4.6 (~1606)".
2. **1M-token context does not equal perfect recall.** Both eval passes cite **MRCR v2 26.3% pointwise at 1M, 84.9% average at 128k**.
3. **Repo-scale agentic engineering and terminal-tool loops trail peers.** Original eval gives Terminal-Bench 2.0 68.5%; Synthesis Pass and May 2026 update both give Terminal-Bench 2.0 **54.2%** trailing Claude (~65.4%) and GPT (~77.3%) — see Divergent Claims for the 68.5% vs 54.2% reconciliation.
4. **Preview-status volatility.** Original eval flags it; Synthesis Pass references reasoning-token burn variance and latency spikes in the same vein.
5. **Anecdotal but recurring agentic-coding failure modes.** Original eval ("acting before audit, ignoring saved instructions, looping, hallucinating, destructive changes") and Synthesis Pass ("dumping tool-call outputs into chat, printing thinking blocks, breaking out of harness") are different observations of the same underlying class — tool-use plumbing leaks under autonomous load.

### Agreed benchmark numbers (Google's model card, both passes cite)

- **GPQA Diamond: 94.3%** (leading per AA in Synthesis Pass; corroborated in May 2026 update).
- **ARC-AGI-2 verified: 77.1%**, more than double Gemini 3 Pro's 31.1%. All three passes agree on Google's number; see Divergent Claims for LayerLens conflict.
- **Humanity's Last Exam: 44.4% no tools, 51.4% with search/code.** Original eval; AA reported "leading" in Synthesis Pass.
- **LiveCodeBench Pro Elo 2887.** Original eval.
- **SciCode 59%** (leading per AA). Both passes.
- **SWE-bench Verified: 80.6%.** Original eval and May 2026 update agree.
- **MCP Atlas 69.2%, BrowseComp 85.9%, Tau2-bench Retail 90.8% / Telecom 99.3%.** Original eval; not contradicted.
- **MMMU-Pro 80.5%, MMMLU 92.6%.** Original eval.

## Divergent Claims (Need Reconciliation)

### Terminal-Bench: 68.5% vs 54.2%

Original eval reports **Terminal-Bench 2.0: 68.5%** as a strength (citing Google's model card). Synthesis Pass reports **Terminal-Bench 2.0: 54.2%**, trailing Claude and GPT (citing third-party reviews). The Synthesis Pass also flags a separate "Terminal-Bench Hard 54%" *lead* per AA, then notes it is "likely a different bench or different scoring."

**Reconciliation:** these are almost certainly different scorings of overlapping bench families — Terminal-Bench Hard is the AA-curated subset (where Gemini leads at ~54%), Terminal-Bench 2.0 is the broader bench (where Gemini trails at ~54.2%), and the 68.5% figure on the Google model card is plausibly Google's own scoring methodology on Terminal-Bench 2.0 with their preferred harness and tool budget. Without access to all three definitions side-by-side this cannot be fully reconciled.

**Working assumption:** trust the **independent third-party 54.2%** for repo-scale terminal work in Fireside routing decisions. Vendor-run benches with vendor-preferred harnesses systematically overshoot real-world tool-use reliability, and the Synthesis Pass's 54.2% is consistent with the broader theme of "harness-brittle" surfaced by multiple hands-on reviewers. **Validate locally** before treating either number as load-bearing.

### ARC-AGI-2: 77.1% vs 92.3%

Google's writeup and the original eval cite **77.1% verified**. The LayerLens summary cited in the Synthesis Pass reports **92.3%**.

**Reconciliation:** the Synthesis Pass itself flags this as "likely a different subset or version" and notes the LayerLens source returned 404 during the research pass (cited via search excerpt only). The 77.1% is the verified figure on the canonical ARC-AGI-2 bench; the 92.3% is plausibly an unverified run, a different prompting setup, or a different bench subset.

**Working assumption:** use **77.1%** as the citable figure. Do not propagate 92.3% in Fireside routing logic without verifying the LayerLens source.

### Intelligence Index leadership: Gemini 57 (leads) vs GPT-5.4/5.5 60 (leads)

Synthesis Pass (Feb 2026 AA snapshot) reports Gemini 3.1 Pro **leading** the Intelligence Index at 57. May 2026 update reports the same Gemini score (57) but puts GPT-5.4/5.5 ahead at **60**.

**Reconciliation:** these are temporal — the AA Intelligence Index moves as new models are added. Gemini led in February 2026 at release; by May 2026 GPT-5.5 had surpassed it. Both can be true; neither is contradicted by the other once dated.

**Working assumption:** as of May 2026, **GPT-5.4/5.5 leads the Intelligence Index, with Gemini 3.1 Pro a close second**. For Fireside, the meaningful signal is "Gemini is on the same tier as the leader, at materially lower cost," not who is #1 in a given week.

### GDPval-AA Elo for Anthropic peers

Synthesis Pass cites **Sonnet 4.6 ~1633, Opus 4.6 ~1606** ahead of Gemini 3.1 Pro (~1317). Note Sonnet ranking ahead of Opus is unusual and worth flagging — it could be an AA scoring artifact. Original eval does not provide peer GDPval-AA numbers, so this is not directly contradicted, but it is also not corroborated.

**Working assumption:** the **directional gap (~300 Elo behind the Anthropic line)** is reliable; the Sonnet-above-Opus ordering should be verified before being used to argue Sonnet is the better deliverable model.

## Single-Pass Claims Worth Elevating

### 1. BIRD-CRITIC SQL: 32.5% — the model's worst result in a 14,549-test sweep

**Source:** Synthesis Pass, citing LayerLens (which 404'd at fetch time).
**Why it matters:** if Fireside has any lane that touches SQL, multi-table joins, correlated subqueries, or schema-aware data reasoning, this is a hard contraindication for routing to Gemini 3.1 Pro without retrieval scaffolding.
**Synthesizer confidence:** **medium**. The single-source-via-search-excerpt provenance is weak, but the failure mode (multi-table joins, correlated subqueries, implicit schema relationships) is consistent with how transformer LLMs typically fail on SQL. Treat as a guardrail until validated.

### 2. Latency up to ~104 seconds on basic inputs in high-demand windows

**Source:** Synthesis Pass, attributed to "independent reviewers."
**Why it matters:** Fireside has latency-sensitive lanes (compose-aware UI, real-time mission updates). A worst-case 100x median latency under contention breaks SLO assumptions silently.
**Synthesizer confidence:** **medium**. Anecdotal but consistent with preview-state capacity issues across all vendors and consistent with original eval's "capacity errors for `gemini-3.1-pro-high`" community report. Treat as a real risk; require explicit timeout/fallback handling.

### 3. Tool-call output dumped into chat thread; thinking blocks leaked into user-visible output

**Source:** Synthesis Pass (multiple hands-on reviewers convergent).
**Why it matters:** Fireside's transcript and receipts architecture depends on clean separation between tool I/O and assistant output. If Gemini leaks thinking blocks or tool payloads into the visible message, the persona surface and the receipt trail both corrupt.
**Synthesizer confidence:** **high** for the existence of the problem (multiple independent reviewers converged), **medium** for severity in Fireside's specific harness (must be locally tested).

### 4. "Consistently trying to break out of the harness" cited as a deployment blocker by some platforms

**Source:** Synthesis Pass, attributed to hands-on reviewers.
**Why it matters:** the strongest single-source claim about agentic reliability. If platforms with significant Gemini engineering investment refuse to ship 3.1 Pro to end users over harness containment, that is a heavy signal for any Fireside lane that exposes Gemini directly.
**Synthesizer confidence:** **medium-high**. The claim is qualitative and unattributed to a specific platform, but it converges with the tool-call-dumping and thinking-block-leakage observations from independent reviewers. **Highest-priority single-pass claim** for Fireside operators because it questions the basic premise of putting Gemini on agentic lanes without aggressive scaffolding.

### 5. Structured Output Fidelity: ~1 in 200 JSON schema violations vs GPT-5.5

**Source:** May 2026 update only.
**Why it matters:** Fireside routes a lot of provider output through schema-validated channels (mission events, plan updates, receipts). A 0.5% schema-break rate is operationally manageable but materially worse than GPT-5.5's "rock-solid" stability.
**Synthesizer confidence:** **low-medium**. The "1 in 200" figure is suspiciously round and the May 2026 update doesn't cite a source for it. Treat as a hypothesis to validate, not a fact.

### 6. Conversational/creative engagement weakness for tone-sensitive lanes

**Source:** Synthesis Pass (multiple reviewers).
**Why it matters:** Fireside has persona-heavy lanes where the agent's voice matters. If Gemini reads as clinical/technical even on warm-tone personas, that is a routing-relevant trait.
**Synthesizer confidence:** **medium**. Subjective by nature; multiple reviewers cite it but it could also be prompt-tuning sensitivity.

### 7. "Multi-step agentic chaining falls apart on tasks needing 20+ sequential reasoning steps"

**Source:** May 2026 update only.
**Why it matters:** Fireside missions can chain many steps. If the model degrades materially past a sequential-step threshold, that defines a routing boundary.
**Synthesizer confidence:** **low**. The "20+" number is uncited; it is a useful directional warning but the threshold itself should not be propagated as fact.

## Gaps Still Uncovered

- **Real Fireside-harness behavior.** All of the harness-brittleness claims are from external reviewers with their own harnesses. No pass tests Gemini 3.1 Pro inside Fireside's actual broker, transcript, receipts, and mission-update plumbing.
- **Latency under realistic Fireside load.** AA's 114 tok/s and the 104-second worst-case anecdote bracket a wide range. No pass measures p50/p95/p99 latency for representative Fireside payloads (mid-size mission contexts, multi-tool calls, persona switching).
- **Persona-specific failure modes.** The "clinical tone" criticism is broad. Fireside has named personas with distinct voice expectations; no pass evaluates whether Gemini's tone is acceptable for any specific persona.
- **Context-window degradation curve.** MRCR v2 is reported at 128k average and 1M pointwise, but the slope between those is not characterized. Fireside's actual use likely lands between 100k and 500k — the recall behavior in that mid-range is unknown.
- **Comparison against Fireside's existing baseline (Opus 4.7).** No pass directly compares Gemini against the model already in production. Routing decisions hinge on lane-by-lane wins/losses against the incumbent, not on aggregate Intelligence Index leadership.
- **JSON schema adherence rate measured, not guessed.** The "~1 in 200" figure is unverified. Fireside has the data to measure this directly via existing schema validators.
- **Receipt and mission-event format compliance under tool use.** The harness-leakage claims are general; whether Gemini specifically corrupts Fireside's receipt format under tool-call pressure is untested.
- **Long-running mission stability.** Anecdotal "looping on optimization tasks" and "ignoring saved instructions" are not characterized for long-running mission patterns specifically.

## Routing Recommendation For Fireside

**Default posture:** Gemini 3.1 Pro is a **secondary provider**, useful for specific lanes where its strengths dominate. Do not make it the default for any persona until the harness gaps in "Gaps Still Uncovered" are closed with local data.

### Route to Gemini 3.1 Pro

- **Research and synthesis lanes** that ingest large multimodal bundles (PDFs, images, transcripts, video) and produce calibrated written output. The hallucination-reduction and multimodal leadership both pay off here, and the cost differential vs Opus is meaningful at high volume.
- **Abstract reasoning / scientific-knowledge lanes** (GPQA Diamond 94.3%, ARC-AGI-2 77.1%). For mission steps that need genuine reasoning over a defined problem, Gemini is competitive at a fraction of the cost.
- **One-shot constrained code generation** — SVG, animations, isolated utilities, short generative coding tasks where the harness loop is short and there is a clean success criterion.
- **High-volume background analysis** where Opus 4.7 cost is not justified and the lane can absorb a 0.5% schema-violation rate.
- **Cost-tier overflow** — when an Opus-tier mission has analysis steps that don't need Opus reasoning, Gemini is the cheaper substitute at ~7.5x lower input cost.

### Do NOT route to Gemini 3.1 Pro (without local validation)

- **Repo-scale agentic engineering** — Terminal-Bench trails peers, harness-break reports converge, "20+ step chaining falls apart" anecdote stacks.
- **Professional-deliverable lanes** (knowledge synthesis as a final artifact, business documentation, strategic plans) — GDPval-AA gap of ~300 Elo behind the Anthropic line is the clearest single signal in the eval.
- **SQL or schema-aware data reasoning** — BIRD-CRITIC 32.5% (single-source) is enough to avoid this lane until validated.
- **Tone-sensitive persona lanes** — creative writing, empathetic personas, human-centric collaboration. Multiple reviewers converge on the model being clinical.
- **Latency-budgeted real-time lanes** — the 100-second worst-case anecdote and "slower on purpose at higher thinking levels" framing make Gemini a poor fit for compose-as-you-type, real-time mission updates, or any sub-second SLO.
- **Exact retrieval over a full 1M-token context** — MRCR 26.3% pointwise at 1M means even Google admits the long tail of recall is unreliable. Use indexing/RAG instead.
- **Security-sensitive workflows** — frontier safety section flags increased cyber capability and active mitigations; expect filter variability.

### Guardrails to add when routing to Gemini

1. **Cap thinking-level usage.** Default to LOW or MEDIUM; gate HIGH behind explicit reasoning-required signals. The reasoning-token-burn anecdote and the cost model both reward this.
2. **Schema-validate every structured output.** Fireside already does this for some channels; extend to all Gemini-handled receipts, mission events, and plan updates. Reject and retry on schema violations rather than letting them propagate.
3. **Sanitize tool-call output.** Add a post-processing layer that strips any leaked thinking blocks (`<thinking>`, `<reasoning>`, etc.) and detects tool-call payloads in main message bodies.
4. **Fallback provider on timeout.** Set explicit timeouts at p95 + safety margin; on timeout, fall back to Opus 4.7 or GPT-5.5 rather than retrying Gemini.
5. **Read-only by default for any code-touching lane.** No write/push authority without explicit per-task elevation and test verification.
6. **Re-baseline weekly while the model is in preview.** Provider-side behavior changes on preview models are a known risk; monitor schema-violation rate, latency p95, and refusal rate as observability signals.
7. **Track thinking-token spend per call.** The reasoning-token-burn variance is reported as anecdotal but real; alert on outliers rather than absorbing the cost silently.

## Open Questions For Local Validation

- What is Gemini 3.1 Pro's **JSON schema adherence rate** on Fireside's actual receipt and mission-event schemas across a representative 1k-call sample? (Validates or refutes the "1 in 200" claim.)
- What is the **p50/p95/p99 latency** for Fireside's typical mid-size context (50k-200k tokens) with HIGH, MEDIUM, and LOW thinking levels?
- Does Gemini **leak thinking blocks or tool-call payloads** into the visible message body when routed through Fireside's broker? At what rate?
- How does Gemini perform on **Fireside's incumbent persona prompts vs Opus 4.7**? Specifically: does the "clinical tone" criticism manifest in Fireside's persona surface, and on which personas?
- What is Gemini's **MRCR-equivalent recall** at the context sizes Fireside actually uses (likely 100k-500k), not just the published 128k and 1M endpoints?
- For **multi-step missions** (5+ steps, 10+ steps, 20+ steps), does Gemini's success rate degrade meaningfully vs Opus 4.7 on the same plan?
- On **Fireside's actual SQL-touching lanes** (if any), does the BIRD-CRITIC weakness manifest, or does Fireside's retrieval scaffolding mask it?
- What is the **cost per completed mission** end-to-end (not per token) when routing analysis steps to Gemini vs Opus? The token-cost math is clear; the mission-cost math depends on retry rate.
- Does Gemini's **Tool use API** integrate cleanly with Fireside's existing tool-call abstraction, or does it require a Gemini-specific adapter layer?
- How does Gemini handle **Fireside's mission-event schema** (plan updates, phase updates, task updates, receipts) — does it produce valid events under tool-use load, and does it produce them in the expected order?
