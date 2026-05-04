# Gemini 3.1 Pro Evaluation Notes

Research date: 2026-05-03

Scope: neutral evaluation of Gemini 3.1 Pro's strong suits, weak points, and practical fit for Fireside provider selection. This is not a model competition document; it records evidence by use case.

## Current Status

Gemini 3.1 Pro was announced by Google on 2026-02-19 and remains the latest Pro-class general Gemini model found in official Google model lists during this research pass. Google has released other Gemini 3.1 variants after it, including Flash, Flash-Lite, Live, TTS, and image models, but those are not newer Pro-class general reasoning models.

Official status:

- API model id: `gemini-3.1-pro-preview`.
- Also listed as `gemini-3.1-pro-preview-customtools` for custom tool workflows.
- Release state: preview.
- Inputs: text, image, audio, video.
- Context window: up to 1M tokens.
- Output: text, up to 64k tokens.
- Available surfaces: Gemini app, Google AI Studio, Gemini API, Vertex AI, Google Antigravity, Gemini Enterprise, NotebookLM, and Gemini CLI.
- Gemini 3 Pro Preview has been deprecated and shut down; Google directs users to Gemini 3.1 Pro Preview.

Standard Gemini Developer API pricing for Gemini 3.1 Pro Preview:

- Input: $2.00 per 1M tokens for prompts <= 200k tokens; $4.00 for prompts > 200k tokens.
- Output, including thinking tokens: $12.00 per 1M tokens for prompts <= 200k tokens; $18.00 for prompts > 200k tokens.
- Batch and flex tiers are cheaper; priority inference is more expensive.
- Grounding with Google Search/Maps has separate query pricing after free included usage.

## Evidence Quality

- Official Google blog, model card, API docs, pricing, and methodology: high confidence for availability, specs, pricing, model id, and Google's own benchmark setup.
- Artificial Analysis: useful independent signal for broad capability, token efficiency, speed, and hallucination behavior.
- Hands-on reviews: medium confidence for qualitative behavior patterns.
- Reddit/community reports: low confidence individually, but useful for recurring product-surface complaints such as capacity, reasoning-token spikes, and risky autonomous coding behavior.

## Strong Suits

### Deep Reasoning And Abstract Problem Solving

Google positions Gemini 3.1 Pro as a step forward in core reasoning. The standout official number is ARC-AGI-2: Google reports a verified score of 77.1%, more than double Gemini 3 Pro's 31.1%.

The DeepMind model card also reports strong scores on:

- GPQA Diamond: 94.3%.
- Humanity's Last Exam, no tools: 44.4%.
- Humanity's Last Exam with search and code: 51.4%.
- LiveCodeBench Pro: Elo 2887.
- SciCode: 59%.
- ARC-AGI-2: 77.1%.

Artificial Analysis reported Gemini 3.1 Pro Preview as a top Intelligence Index model in February 2026, with particular strength in reasoning/knowledge, coding, hallucination reduction, and multimodality.

Fireside implication: Gemini 3.1 Pro is a strong candidate for strategy, complex analysis, abstract reasoning, scientific/technical reasoning, and tasks where it should synthesize constraints before producing an answer.

### Multimodal Understanding

The official model card says Gemini 3.1 Pro can handle text, audio, images, video, and large code repositories. Google and Artificial Analysis both highlight multimodal strength. The DeepMind model card reports:

- MMMU-Pro: 80.5%.
- MMMLU: 92.6%.

Artificial Analysis ranked Gemini 3.1 Pro highly on MMMU-Pro and described Google as leading on multimodal reasoning in that evaluation snapshot.

Fireside implication: useful for agents that need to inspect mixed media, screenshots, videos, audio-derived transcripts, PDFs, and large multimodal bundles.

### Long Context Capacity

Gemini 3.1 Pro supports up to 1M tokens of context. The model card reports MRCR v2 8-needle results of 84.9% at 128k average and 26.3% at 1M pointwise.

This is enough to handle large documents, transcripts, and codebase packs, but the 1M MRCR result is a warning: a large window does not guarantee reliable exact recall across the full window.

Fireside implication: good for ingesting large context, but exact retrieval should still use indexing, citations, search, and verification.

### Tool Use, Agentic Workflows, And Coding

Google emphasizes agentic workflows, vibe coding, and custom tool usage. The model card reports:

- Terminal-Bench 2.0: 68.5%.
- SWE-bench Verified: 80.6%.
- SWE-bench Pro public: 54.2%.
- MCP Atlas: 69.2%.
- BrowseComp: 85.9%.
- Tau2-bench Retail: 90.8%; Telecom: 99.3%.

Artificial Analysis reported Gemini 3.1 Pro leading its Coding Index in February 2026, especially Terminal-Bench Hard and SciCode. Google also highlights SVG, simulation, dashboard, and creative coding demos.

Fireside implication: useful for coding review, prototypes, generated visualizations, and tool-mediated research. Use guarded autonomy for repo-modifying work until local tests prove safe behavior.

### Cost And Speed Profile

Compared with top-tier frontier pricing, Gemini 3.1 Pro Preview's standard API price is relatively low at $2/$12 per 1M tokens for <= 200k-token prompts. Artificial Analysis reported average speed around 114 output tokens per second and relatively low token use for its Intelligence Index run.

Fireside implication: attractive for high-volume analysis, multimodal inspection, and research lanes where Opus-level cost is not justified.

### Lower Hallucination Than Gemini 3 Pro

Artificial Analysis reported a large reduction in AA-Omniscience hallucination rate from Gemini 3 Pro Preview to Gemini 3.1 Pro Preview. Google also reports modest safety and tone improvements relative to Gemini 3 Pro while keeping unjustified refusals low.

Fireside implication: better than prior Gemini 3 for answer calibration, but still require citations and verification for operational decisions.

## Weak Points And Tradeoffs

### Preview Status And Stability

Gemini 3.1 Pro is still a preview model in Google API docs. Preview models can change before stable release and may have more restrictive rate limits. This matters for Fireside because provider behavior can shift without a code change.

Fireside implication: keep provider scoring adaptive. Treat sudden latency, token, refusal, or output-format changes as plausible provider-surface changes, not necessarily app regressions.

### 1M Context Is Not Equivalent To Perfect Recall

The official model card's MRCR v2 1M pointwise result is 26.3%. That is weak for exact multi-needle retrieval at full-window scale, even though the 128k average result is much stronger.

Fireside implication: use Gemini 3.1 Pro for large-context synthesis, but do not ask it to be the only retrieval layer over a full mission transcript or codebase pack.

### Agentic Coding Can Be Risky In Community Reports

Community reports around Antigravity and Gemini Pro 3.1 include recurring complaints about:

- Acting before finishing an audit or plan.
- Ignoring saved instructions.
- Looping on optimization tasks.
- Hallucinating implementation details.
- Making broad or destructive file changes.
- Capacity errors for `gemini-3.1-pro-high`.

These are anecdotal and often product-surface specific. They should not override official and independent benchmarks, but they are relevant to autonomous local coding.

Fireside implication: do not grant Gemini 3.1 Pro unguarded write/push authority by default. Start with read-only review, isolated prototypes, or small bounded patches with explicit verification.

### Reasoning Token Burn May Be Volatile

A May 2026 Reddit thread reports a sudden increase in thinking/reasoning tokens at the high thinking level, including examples where high used several times more thinking tokens than low or medium on similar prompts. This is anecdotal, but it matches the general risk of preview models and adjustable thinking budgets.

Fireside implication: record thinking/output token usage per run and expose warnings when Gemini cost patterns drift.

### Not Always Leading On Real-World Agentic Professional Tasks

Artificial Analysis reported Gemini 3.1 Pro improved on GDPval-AA but did not lead that benchmark in February 2026. Google's own model card lists GDPval-AA Elo at 1317, below several other frontier peers in that table.

This does not make Gemini weak overall; it suggests its best areas are reasoning, multimodality, coding benchmarks, and cost-efficient intelligence rather than every type of real-world professional deliverable.

Fireside implication: prefer Gemini for analysis-heavy and multimodal work; compare locally before assigning highest-stakes long-form document or business-work-product tasks.

### Safety And Frontier Capability Caveats

Google's frontier safety section says Gemini 3.1 Pro remains below critical capability levels for CBRN, harmful manipulation, ML R&D, and misalignment, and below the cyber CCL despite cyber alert-threshold testing. It also notes increased cyber capability compared with Gemini 3 Pro and continued mitigations.

Fireside implication: expect safety filters and variability on security workflows. Keep security tasks scoped and auditable.

## Recommended Fireside Use

Good default roles:

- Research analyst for complex synthesis and multimodal evidence review.
- Technical strategist for constraint-heavy planning.
- Visual/prototype engineer for SVGs, simulations, dashboards, and interactive demos.
- Code reviewer for isolated review tasks and alternative implementation critique.
- Cost-efficient high-context analyst when exact retrieval is not the primary requirement.

Use caution for:

- Full autonomous repo modification.
- Exact lookup across a 1M-token context.
- High-effort reasoning when budget is tight.
- Workflows that require stable behavior across days without revalidation.
- Security tasks that may trigger provider safeguards.

Operational guidance:

- Prefer explicit output schemas and bounded task scopes.
- Use low or medium thinking for routine work if available; reserve high for genuinely difficult reasoning.
- Keep write permissions gated and require tests before accepting code changes.
- Use retrieval/indexing for long transcripts and codebase packs.
- Re-baseline prompts periodically while the model remains in preview.

## Sources

- [Google announcement: Gemini 3.1 Pro](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-pro/)
- [Google DeepMind model card: Gemini 3.1 Pro](https://deepmind.google/models/model-cards/gemini-3-1-pro/)
- [Google DeepMind evaluation methodology PDF](https://deepmind.google/models/evals-methodology/gemini-3-1-pro)
- [Google AI Developer docs: models](https://ai.google.dev/gemini-api/docs/models)
- [Google AI Developer docs: pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Artificial Analysis: Gemini 3.1 Pro Preview](https://artificialanalysis.ai/articles/gemini-3-1-pro-preview-new-leader-in-ai)
- [Tom's Guide hands-on prompts](https://www.tomsguide.com/ai/gemini-3-1-pro-is-a-powerhouse-for-deep-work-here-are-7-prompts-that-prove-it)
- [TechRadar Gemini 3.1 Pro vs Gemini 3 Pro hands-on](https://www.techradar.com/ai-platforms-assistants/gemini/gemini-3-1-pro-vs-gemini-3-pro-googles-new-ai-is-slower-on-purpose-and-smarter-for-it)
- [Community Antigravity thread with negative reports](https://www.reddit.com/r/google_antigravity/comments/1rcmhq7/gemini_pro_31_is_dumb/)
- [Community reasoning-token usage thread](https://www.reddit.com/r/GeminiAI/comments/1sw938l/is_gemini_31_pro_preview_burning_through_way_more/)

---

# Independent Synthesis Pass (2026-05-03)

The section below is a separate research pass appended for cross-checking. It was produced independently of the content above; treat overlap as corroboration and disagreement as a signal to verify against primary sources.

## Current Status

Gemini 3.1 Pro entered preview on 2026-02-19 via the Gemini API, Vertex AI, the Gemini app, and NotebookLM. It is positioned as a smarter, more capable baseline than Gemini 3 Pro, with the same 1M-token context window and a new MEDIUM `thinking_level` parameter that exposes cost/performance trade-offs to the caller.

Core specs and pricing as reported by Google and aggregators:

- Context window: 1M tokens.
- Multimodal inputs: text, audio, images, video, PDFs, and code repositories.
- API price: ~$2 per 1M input tokens and ~$12 per 1M output tokens (Artificial Analysis figures).
- Output speed: ~114 tokens/second (Artificial Analysis).
- New thinking levels: MEDIUM added alongside existing levels for tuning cost vs reasoning depth.

## Evidence Quality

- Google blog post and DeepMind model card: high confidence for availability, pricing, multimodal surface, and Google's own benchmark table; medium confidence for relative capability claims because they are vendor-run.
- Artificial Analysis: high confidence as an independent aggregator on the AA Intelligence Index, AA-Omniscience hallucination, and cost-to-run comparisons.
- LayerLens 14,549-test review: useful breadth signal across many benches; one of its bench results (BIRD-CRITIC 32.5%) is widely cited as the model's clearest weakness. Direct fetch of the source returned 404 during this pass, so its specific numbers are second-hand via search-result excerpts and should be treated as medium confidence.
- Hands-on coding reviews (CodeX/Medium, automateed, gitautoreview): low-to-medium confidence individually; useful for surfacing harness and tool-use failure modes that benchmarks do not capture.
- Hacker News and Reddit reports: low confidence individually but consistent enough on harness/tool issues to be worth flagging.

## Strong Suits

### Reasoning, Knowledge, And Hallucination Resistance

Gemini 3.1 Pro tops Artificial Analysis's Intelligence Index at 57, four points ahead of Claude Opus 4.6 (53) and six ahead of Sonnet 4.6 (51), and leads 6 of the 10 evaluations that compose that index. Specific results AA highlights:

- Terminal-Bench Hard (agentic coding): 54%, leading peers on this specific subset.
- AA-Omniscience (knowledge & hallucination): leading.
- Humanity's Last Exam: leading.
- GPQA-Diamond: leading; Google reports a 94.3% headline figure, the highest score reported on this benchmark.
- SciCode: 59%, leading.
- CritPt (research-level physics): 18%, leading.
- ARC-AGI-2 (verified): 77.1% per Google's own writeup, more than double Gemini 3 Pro's score.

The largest single quality jump is on hallucination behavior: AA reports a 38 percentage-point reduction in the AA-Omniscience hallucination rate vs Gemini 3 Pro Preview, dropping incorrect-when-uncertain guesses from 88% to 50%.

Fireside implication: a credible candidate for science, research, and reasoning lanes where calibrated abstention matters more than tone. The hallucination drop is significant for any lane that relies on the model to admit uncertainty rather than fabricate.

### Multimodal Coverage

Reported #1 on MMMU-Pro. Combined with the 1M-token context, it accepts mixed inputs (text, audio, images, video, PDFs, repos) without separate routing.

Fireside implication: useful for mission lanes that ingest mixed artifacts (transcripts plus screenshots plus PDFs) where staying inside one provider avoids brittle handoffs.

### Cost-To-Run

Artificial Analysis reports Gemini 3.1 Pro running their full Intelligence Index at roughly $892 — under half the cost of comparable frontier peers from OpenAI and Anthropic — at $2/$12 per 1M input/output tokens. The new MEDIUM thinking level gives callers an additional axis to dial cost down further when full reasoning is overkill.

Fireside implication: the most cost-attractive of the current frontier-tier options. Worth considering for high-volume lanes where Opus 4.7 or GPT-5.5 would be priced out.

### Code Generation In Constrained, One-Shot Settings

Reviewers note that when given a complete spec in a single shot, the generated code "runs immediately without missing pieces" — a strength on contained generative tasks like SVG animations, isolated utilities, and code that can be evaluated without a long agentic loop.

Fireside implication: usable for one-shot code generation lanes where the loop is short and the harness does not need to broker many tool calls.

## Weak Points

### Real-World Expert Knowledge Work (GDPval-AA)

The clearest gap on independent benches is GDPval-AA, which scores models on real-world expert tasks. Artificial Analysis reports Gemini 3.1 Pro at an Elo of ~1317, behind Sonnet 4.6 (~1633), Opus 4.6 (~1606), GPT-5.2 xhigh, and GLM-5 — a gap of nearly 300 Elo to the Anthropic line. This is a striking divergence from the Intelligence Index lead and should be read as: the model wins on academic-style benches, loses on whether it can produce well-specified expert deliverables.

Fireside implication: do not route professional-deliverable lanes (knowledge synthesis, business documentation, strategic planning) to Gemini 3.1 Pro by default; the bench is specifically designed to measure that ability and the model trails the Anthropic line by a wide margin.

### Tool Use And Harness Reliability

Multiple hands-on reviews converge on the same set of harness failure modes:

- Dumping tool-call outputs into the main chat thread instead of treating them as tool results.
- Printing internal thinking blocks in user-visible output despite explicit instructions not to.
- Random injection of non-English characters mid-generation.
- "Consistently trying to break out of the harness" — described as the reason some platforms have not rolled out Gemini models to end users.

These are reliability issues, not capability ceiling issues — the model can do the task but the surrounding plumbing leaks.

Fireside implication: agentic lanes that depend on clean tool I/O need extra scaffolding when GPT-5.5 or Opus 4.7 would not. If Fireside relies on receipts and structured tool outputs, expect to spend implementation budget on Gemini-specific guardrails.

### Software Engineering On Repository-Scale Tasks

Specific bench numbers cited:

- SWE-bench Lite: 48.7%, below frontier peers on repository-level changes.
- Terminal-Bench 2.0: 54.2%, trailing Claude (~65.4%) and GPT (~77.3%).

Note: the AA-cited "Terminal-Bench Hard" lead at 54% and the third-party "Terminal-Bench 2.0" 54.2% trailing position are likely different benches or different scorings rather than a contradiction; both are worth holding in mind. The fair read is that the model is competitive on isolated coding tasks and weaker on repo-scale agentic engineering.

Fireside implication: not a first-choice provider for hard repo-bound engineering or long terminal-tool agent loops.

### SQL And Data Reasoning

LayerLens reports BIRD-CRITIC at 32.5% — the lowest score in their 14,549-test sweep — with multi-table joins, correlated subqueries, and implicit schema relationships flagged as the failure surface.

Fireside implication: avoid Gemini 3.1 Pro for lanes that require non-trivial SQL or schema-aware data reasoning unless paired with explicit retrieval and tool support.

### Latency Variance

Independent reviewers reported latency up to ~104 seconds on basic inputs during high-demand windows in the preview rollout, occasionally manifesting as timeouts. Hands-on reviewers and TechRadar coverage frame the model as deliberately "slower on purpose" in higher thinking levels, which is fine when budgeted for but not when latency budgets are tight.

Fireside implication: latency-sensitive lanes need explicit timeout handling and probably a fallback provider; do not assume the median latency in light load matches behavior under contention.

### Conversational And Creative Engagement

Multiple reviewers describe the model as prioritizing technical clarity and structured reasoning over empathetic or creative engagement — strong as an engineering tool, weaker as a partner for creative writing or human-centric collaboration.

Fireside implication: not the right pick for tone-sensitive, persona-heavy, or creative-writing lanes.

### Practical Coding Beyond Benchmarks

The CodeX/Medium hands-on review captures the friction concisely: the model "tops the Artificial Analysis intelligence index by a wide margin" but failed a ChatGPT-clone task entirely and produced a 6/9 tower-defense game with poor UX. The author concludes the model is "impossible to use for coding" inside their harness due to tool-use reliability — a sharper version of the harness criticism above. The headline claim should be read against the author's specific harness, not generalized to all coding work, but it tracks with the broader theme: bench-strong, harness-brittle.

Fireside implication: validate Gemini 3.1 Pro on the actual Fireside harness before routing significant coding work to it; benchmark dominance does not predict in-harness reliability.

### Ambiguity Between ARC-AGI Numbers

ARC-AGI-2 numbers reported across sources do not perfectly agree: Google cites 77.1% verified; the LayerLens summary cites 92.3% (likely a different subset or version). Treat both as plausible-in-context and verify against the specific bench definition before citing either.

Fireside implication: when reasoning capability is load-bearing, validate on representative tasks rather than relying on a single bench score.

## Summary Read

Gemini 3.1 Pro looks unambiguously strong on academic-style reasoning, multimodal breadth, calibrated abstention, and cost-to-run, and unambiguously weaker on real-world expert deliverables (GDPval-AA), repository-scale software engineering, SQL, and harness/tool-use reliability. The gap between Intelligence Index leadership and GDPval-AA position is the most informative single signal in this evaluation — it's the difference between "the model knows things" and "the model produces what a professional needs."

For Fireside, the natural fit is reasoning- and research-heavy lanes that benefit from cheap intelligence and calibrated uncertainty, with the explicit caveat that tool-use lanes need extra scaffolding and professional-deliverable lanes should route elsewhere unless validated on the specific task.

## Sources (Synthesis Pass)

- Gemini 3.1 Pro: A smarter model for your most complex tasks - Google: https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-pro/
- Gemini 3.1 Pro - Model Card - Google DeepMind: https://deepmind.google/models/model-cards/gemini-3-1-pro/
- Gemini 3.1 Pro Preview: The new leader in AI - Artificial Analysis: https://artificialanalysis.ai/articles/gemini-3-1-pro-preview-new-leader-in-ai
- Gemini 3.1 Pro Preview - Intelligence, Performance & Price Analysis - Artificial Analysis: https://artificialanalysis.ai/models/gemini-3-1-pro-preview
- Gemini 3.1 Pro Review: 14,549 Tests - LayerLens: https://layerlens.ai/blog/gemini-3-1-pro-benchmark-review (note: 404 during this pass; cited via search excerpt)
- Gemini 3.1 Pro is the smartest dumb model I know - Dan Cleary, CodeX/Medium: https://medium.com/codex/gemini-3-1-pro-is-the-smartest-dumb-model-i-know-full-breakdown-for-coding-6d89647e2dc8
- Gemini 3.1 Pro Review (2026): Honest Take After Testing - automateed: https://www.automateed.com/gemini-3-1-pro-review
- Gemini 3.1 Pro Review: Benchmark King in Reasoning, But Not Unbeatable Across the Board - Vertu: https://vertu.com/ai-tools/gemini-3-1-pro-review-benchmark-king-in-reasoning-but-not-unbeatable-across-the-board
- Gemini 3.1 Pro Coding Performance Review - GitAuto: https://gitautoreview.com/blog/gemini-3-pro-code-review
- Behind Gemini 3.1 Pro's "13 out of 16 Wins" - SmartScope: https://smartscope.blog/en/generative-ai/google-gemini/gemini-3-1-pro-benchmark-analysis-2026/
- Gemini 3.1 Pro Aces Benchmarks, I Suppose - Zvi Mowshowitz: https://thezvi.substack.com/p/gemini-31-pro-aces-benchmarks-i-suppose
- Gemini 3.1 Pro: Benchmarks, Cost, and Production Fit - Thesys: https://www.thesys.dev/blogs/gemini-3-1-pro
- Hacker News discussion thread: https://news.ycombinator.com/item?id=47074735

## Independent Research Update (May 2026)

As of May 2026, Gemini 3.1 Pro is widely regarded as the "price-performance champion" of the frontier AI models. Released in February 2026, it represents a significant leap over the original Gemini 3 Pro, particularly in abstract reasoning and scientific knowledge.

### Strong Suits

- **Abstract Reasoning (ARC-AGI-2):** This is the model's standout achievement. It scores 77.1% on ARC-AGI-2, more than doubling the previous version's 31.1% and significantly leading competitors like Claude Opus 4.6 (68.8%) and GPT-5.2 (52.9%).
- **Scientific & Graduate-Level Knowledge:** It leads the GPQA Diamond benchmark with a score of 94.3%, making it the top choice for complex scientific research and high-level technical analysis.
- **Massive Context Window:** It maintains a 1M to 2M token context window (depending on the tier), which remains the industry standard for ingesting entire monorepos or massive document corpora in a single pass.
- **Price-to-Performance Ratio:** At $2 per 1M input tokens, it is roughly 7.5x cheaper than Claude Opus 4.6 while delivering comparable or superior performance on most reasoning benchmarks.
- **Native Multimodality:** It is the only frontier model that natively supports text, image, audio, and video inputs in a single model at the API level, without requiring separate encoders.
- **Speed:** It is exceptionally fast for a reasoning model, with verified output speeds of 104–121 tokens per second.

### Weak Points

- **Terminal-Based Coding:** While strong in general coding (80.6% on SWE-Bench Verified), it struggles with complex, multi-step shell interactions. It scores 54.2% on Terminal-Bench 2.0, trailing GPT-5.3-Codex (77.3%) and Claude Opus 4.6 (65.4%).
- **Multi-Step Agentic Chaining:** Reviews indicate that while it "crushes" single-file reviews, it can "fall apart" on architectural tasks requiring 20+ sequential reasoning steps.
- **Expert Human Preference:** Despite leading on raw benchmarks, human evaluators still frequently prefer Claude Opus 4.6/4.7 for nuanced expert tasks and "vibe-based" creative writing.
- **Structured Output Fidelity:** In "Preview" versions, some users reported occasional drops in JSON schema adherence (roughly 1 in 200 requests) compared to the rock-solid stability of GPT-5.5.

### 2026 Benchmark Summary

| Benchmark | Gemini 3.1 Pro | Claude Opus 4.6/4.7 | GPT-5.4/5.5 |
| :--- | :--- | :--- | :--- |
| **ARC-AGI-2** (Reasoning) | **77.1%** | 68.8% | 52.9% |
| **GPQA Diamond** (Science) | **94.3%** | 91.3% | 76.8% |
| **SWE-Bench Verified** (Coding) | 80.6% | **80.8% - 87.6%** | 74.9% |
| **Terminal-Bench 2.0** (CLI) | 54.2% | 65.4% | **77.3%** |
| **Intelligence Index** (Overall) | 57 | 53 | **60** |