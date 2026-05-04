# Claude Opus 4.7 Evaluation Notes

Research date: 2026-05-03

Scope: neutral evaluation of Claude Opus 4.7's strong suits, weak points, and practical fit for Fireside provider selection. This is not a model competition document; it records evidence by use case.

## Current Status

Claude Opus 4.7 was released by Anthropic on 2026-04-16 and is Anthropic's most capable generally available Opus model as of this research pass. It is available through Claude products, the Anthropic API, Amazon Bedrock, Google Vertex AI, and Microsoft Foundry.

Core specs from Anthropic:

- API model id: `claude-opus-4-7`.
- Context window: 1M tokens.
- Max synchronous output: 128k tokens.
- Reasoning mode: adaptive thinking only; previous extended-thinking controls are removed for this model.
- API price: $5 per 1M input tokens and $25 per 1M output tokens.
- New tokenizer: same text may use roughly 1.0x to 1.35x as many tokens as older Claude models.

## Evidence Quality

- Official Anthropic launch/docs/model card: high confidence for availability, pricing, specs, supported surfaces, and Anthropic's own benchmark table; medium confidence for relative capability claims because they are vendor-run or partner-provided.
- Artificial Analysis: useful independent benchmark signal for agentic knowledge work, hallucination/abstention behavior, token use, and cost.
- Hands-on reviews and Reddit reports: low-to-medium confidence. Useful for surfacing failure modes, but individual workflows and product surfaces vary heavily.
- Anthropic's 2026-04-23 Claude Code postmortem matters because some early quality complaints were caused by product/harness bugs rather than model weights alone.

## Strong Suits

### Agentic Coding And Difficult Software Tasks

The strongest evidence for Opus 4.7 is in agentic coding and long-running engineering work.

Anthropic's system-card benchmark table reports:

- SWE-bench Verified: 87.6% for Opus 4.7 vs 80.8% for Opus 4.6.
- SWE-bench Pro: 64.3% for Opus 4.7 vs 53.4% for Opus 4.6.
- SWE-bench Multilingual: 80.5% for Opus 4.7 vs 77.8% for Opus 4.6.
- SWE-bench Multimodal: 34.5% for Opus 4.7 vs 27.1% for Opus 4.6.
- Terminal-Bench 2.0: 69.4% for Opus 4.7 vs 65.4% for Opus 4.6, with the caveat that harnesses differ across providers.

Partner quotes in Anthropic's launch post consistently point to stronger multi-step engineering, code review, bug finding, and validation follow-through. These are not independent, but the direction agrees with Anthropic's benchmark table and with a small community Zod benchmark that found Opus 4.7 produced tighter, more on-task patches even when raw test pass rate did not improve.

Fireside implication: Opus 4.7 is a strong candidate for senior engineering, code review, hard debugging, and tasks where the agent should carry work through validation rather than stop at a plan.

### Professional Knowledge Work And Multi-Step Agents

Artificial Analysis reports that Opus 4.7 leads GDPval-AA, its benchmark for economically valuable agentic work across real occupations and industries. In its April 2026 writeup, Artificial Analysis also reports that Opus 4.7 improved over Opus 4.6 on its Intelligence Index while using fewer output tokens to complete that benchmark run.

Anthropic also reports strong gains on OfficeQA, OfficeQA Pro, Finance Agent, MCP-Atlas, and VendingBench. The strongest practical theme is not raw chat quality; it is structured multi-step work that combines documents, tools, and validation.

Fireside implication: useful for mission lanes that require planning plus execution across files, tools, and artifacts. Prefer it for high-value, low-tolerance work where extra latency and cost are justified.

### Vision, UI, Documents, And Figure Analysis

Opus 4.7 accepts higher-resolution images than previous Claude models: up to 2576px on the long edge and about 3.75MP total, compared with 1568px and about 1.15MP for earlier models.

Anthropic reports large gains on:

- LAB-Bench FigQA.
- CharXiv Reasoning.
- ScreenSpot-Pro.
- OSWorld.
- SWE-bench Multimodal.

The API docs specifically call out improved `.docx` redlining, `.pptx` editing, slide layout checking, chart/figure analysis, and pixel-level extraction using image-processing tools.

Fireside implication: strong fit for UX review, screenshot analysis, visual bug triage, slide/doc work, and UI reconstruction from images.

### Literal Instruction Following And Pushback

Anthropic says Opus 4.7 follows instructions more literally and does less silent generalization. Several partner reports also mention better pushback, fewer agreeable-but-wrong fallbacks, and stronger honesty about missing data.

This is a strength when prompts are explicit and testable. It is a weakness when older prompts rely on the model inferring implied work.

Fireside implication: prompts should be direct about what to inspect, what to change, what not to change, and what verification is mandatory. Do not rely on old Claude prompt habits where the model inferred broad intent from loose instructions.

### File-Based Memory

Anthropic's docs say Opus 4.7 is better at writing and using file-system-based memory, including scratchpads, notes, and structured memory stores across turns.

Fireside implication: promising for local agent context, mission recaps, and handoff artifacts, but this should still be tested against Fireside's actual agent-context files and broker prompt shape.

## Weak Points And Tradeoffs

### Precise Long-Context Retrieval Is A Real Concern

The most important regression signal is MRCR v2 8-needle at 1M tokens. Secondary summaries of Anthropic's system card report Opus 4.7 at 32.2% vs Opus 4.6 at 78.3%.

This does not mean all long-context tasks are worse. Anthropic points to stronger results on GraphWalks and multi-hop structured reasoning. But MRCR captures a real workflow: disambiguating among many near-identical items in a very large context. If the task is "find the 4th nearly identical occurrence in 800k tokens," Opus 4.7 should be treated as risky until tested locally.

Fireside implication: avoid treating the 1M window as a database. For exact retrieval over long transcripts or documents, use explicit indexing, search, chunking, citations, and verification rather than one giant prompt.

### Cost Can Rise Despite Same Sticker Price

Per-token pricing is unchanged from Opus 4.6, but the new tokenizer can use up to about 35% more tokens on the same text. At higher effort levels, especially in later agentic turns, Opus 4.7 may also produce more thinking/output tokens.

Artificial Analysis reports lower output-token use for its benchmark run, so the cost story is workload-dependent: per-message cost can rise, but end-to-end task cost can fall if the model finishes in fewer turns.

Fireside implication: provider scoring should not assume "same price as 4.6" means same run cost. Measure real Fireside runs by persona and task type.

### Prompt Migration Required

Anthropic documents several behavior changes:

- More literal instruction following.
- Response length calibrated to perceived task complexity.
- Fewer tool calls by default, with more tool use at higher effort.
- More direct and opinionated tone.
- Fewer subagents by default.
- Cybersecurity safeguards can produce refusals for high-risk topics.

Fireside implication: old Claude-oriented system prompts may need tightening. If a task requires exhaustive reading, multi-agent review, or fixed verification, say so explicitly.

### Early Claude Code Quality Reports Were Mixed

Community reaction around release was sharply mixed. Some users reported regressions, higher token burn, tool mistakes, or unfinished work. Anthropic later published a 2026-04-23 postmortem identifying three Claude Code/Cowork/Agent SDK issues:

- Default reasoning effort had been reduced from high to medium for some models and was reverted.
- A caching bug dropped prior thinking after idle sessions and was fixed on 2026-04-10.
- A verbosity-reduction system prompt hurt coding quality for Opus 4.6 and Opus 4.7 and was reverted on 2026-04-20.

Anthropic says the API and inference layer were unaffected by those three issues.

Fireside implication: distinguish model-level evaluation from CLI/product-surface behavior. Fireside should evaluate Opus 4.7 through the actual CLI/API surface it invokes, not assume benchmark behavior transfers unchanged.

### Safety And Cyber Constraints

Opus 4.7 ships with real-time cybersecurity safeguards. Legitimate security work may need Anthropic's Cyber Verification Program. Anthropic's safety summary also notes a few weaker areas, including overly detailed harm-reduction advice for controlled substances in some tests and susceptibility to plausible benign framing in some multi-turn safety scenarios.

Fireside implication: for security personas, expect occasional refusal or blocked work. For high-autonomy agents, keep permission gates and audit trails active.

## Recommended Fireside Use

Good default roles:

- Senior software engineer for difficult, multi-file implementation.
- Code reviewer for bug discovery and design critique.
- Debugger for long-running, tool-heavy diagnosis.
- UX/image/document analyst when visual details matter.
- High-value planner/executor when the task is worth higher cost.

Use caution for:

- Exact retrieval over very large contexts.
- Cheap routine chat or summarization.
- Long sessions with loose instructions.
- Security workflows that may cross Anthropic policy boundaries.
- Any autonomous mode without local permission checks.

Operational guidance:

- Start hard coding/agent tasks at `high` or `xhigh` effort where available.
- Keep critical instructions explicit and repeated in handoff artifacts.
- Use search/indexing over giant-context recall for exact lookups.
- Track effective cost per completed task, not only per-token price.
- Retest existing Claude prompts before assigning production work to 4.7.

## Sources

- [Anthropic launch post: Introducing Claude Opus 4.7](https://www.anthropic.com/news/claude-opus-4-7)
- [Anthropic model overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Anthropic docs: What's new in Claude Opus 4.7](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)
- [Anthropic Transparency Hub](https://www.anthropic.com/transparency)
- [Claude Opus 4.7 system card PDF](https://cdn.sanity.io/files/4zrzovbb/website/037f06850df7fbe871e206dad004c3db5fd50340.pdf)
- [Artificial Analysis: Opus 4.7](https://artificialanalysis.ai/articles/opus-4-7-everything-you-need-to-know/)
- [Anthropic postmortem: recent Claude Code quality reports](https://www.anthropic.com/engineering/april-23-postmortem)
- [Tom's Guide hands-on test](https://www.tomsguide.com/ai/i-tested-anthropics-new-claude-opus-4-7-and-its-the-first-ai-that-actually-reasons-through-tasks)
- [All Things How review](https://allthings.how/claude-opus-4-7-review-is-it-actually-better-than-opus-4-6/)
- [Community Zod benchmark thread](https://www.reddit.com/r/ClaudeCode/comments/1so9spv/i_ran_opus_47_vs_old_opus_46_vs_new_opus_46_on_28/)

## Independent Research Update (May 2026)

Based on industry reports and benchmarks as of May 2026, Claude 4.7 Opus maintains its position as a high-precision model optimized for complex engineering and agentic workflows, though it faces notable trade-offs in efficiency and specialized reasoning.

### Strong Suits

- **Premier Software Engineering:** Claude 4.7 Opus currently leads the SWE-bench Pro (64.3%), outperforming GPT-5.5 (58.6%) and Gemini 3.1 Pro (54.2%). It is widely regarded as the industry standard for resolving real-world GitHub issues that require reasoning across multiple files and complex architectures.
- **Agentic Reliability & Tool Use:** The model introduces an `xhigh` effort mode specifically designed for long-running agentic sessions. It leads the MCP-Atlas benchmark (77.3%), demonstrating superior coordination when using multiple tools via the Model Context Protocol.
- **High-Resolution Vision:** With a 3x increase in resolution (supporting up to 2,576px), it excels at "computer use" tasks, such as accurately navigating dense user interfaces and extracting structured data from complex technical diagrams.
- **Strict Instruction Following:** Reviews note the model is more "opinionated" and literal. It frequently self-verifies its output before responding, which reduces the need for human oversight in high-stakes environments.

### Weak Points And Tradeoffs

- **The "Tokenizer Tax":** While the per-token price remains stable, the new tokenizer is significantly less efficient. Users report a 1.0x to 1.35x increase in token consumption for the same input compared to the previous version (Opus 4.6).
- **Declining Web Research Performance:** Performance on the BrowseComp benchmark dropped to 79.3%, trailing both GPT-5.5 Pro (90.1%) and Gemini 3.1 Pro (85.9%). It is currently not considered the optimal choice for live web synthesis tasks.
- **Context Retrieval Failures:** On the MRCR v2 benchmark (measuring "needle-in-a-haystack" retrieval at 512K–1M tokens), it scores only 32.2%, falling far behind GPT-5.5's 74.0%. This suggests a significant struggle with information density at extreme context lengths.
- **Mathematical Reasoning:** It trails the GPT-5 series in high-level competitive mathematics, scoring ~70% on USAMO 2026 problems, making it less suitable for advanced quantitative research.
- **UX & Verbosity:** There is significant developer backlash regarding its "argumentative" nature. Its strict literal adherence and increased verbosity can lead to friction in creative or flexible prompting scenarios.

---

# Independent Synthesis Pass (2026-05-03)

The section below is a separate research pass appended for cross-checking. It was produced independently of the content above; treat overlap as corroboration and disagreement as a signal to verify against primary sources.

Author note: this pass was produced by a Claude Opus 4.7 instance evaluating its own model. To counter likely self-favoring bias, weights were tilted toward third-party evaluators (Sonar, Artificial Analysis, Vellum), critical hands-on reviews (MindStudio "what got worse", Vibe Coding regression piece), and Anthropic's own admissions of regressions and ceiling. Vendor framing is identified as such; criticisms are reported without softening.

## Current Status

Claude Opus 4.7 was released on 2026-04-16 and is generally available across Claude products, the Claude API, Amazon Bedrock, Google Vertex AI, and Microsoft Foundry. Anthropic has publicly conceded (per Axios reporting) that Opus 4.7 trails an unreleased internal model code-named "Mythos," which is meaningful context: even Anthropic does not position 4.7 as the absolute frontier, just the strongest generally-available Opus.

Core specs and pricing as reported by Anthropic and aggregators:

- API model id: `claude-opus-4-7`.
- Context window: 1M tokens.
- API price: $5 per 1M input tokens and $25 per 1M output tokens (unchanged from Opus 4.6).
- New tokenizer: roughly 12-18% more tokens for typical English workloads (per MindStudio), with one critical review citing 35% more tokens; this is an effective price increase even though headline per-token pricing held flat.
- Tokenizer reduces token counts by 20-35% for non-Latin scripts (Mandarin, Japanese, Korean, Arabic, Hindi).
- Adaptive thinking only; previous extended-thinking controls (`budget_tokens`) removed - existing code that used them now returns 400 errors.
- Thinking tokens hidden by default - billing-relevant change worth verifying against current invoices.

## Evidence Quality

- Anthropic launch post and model card: high confidence for availability, pricing, surface area, and Anthropic's own benchmark table; medium confidence for relative capability claims because they are vendor-run.
- Sonar code-quality evaluation: high confidence as an independent evaluator with a structured methodology (4,444 Java tasks, 336,283 LOC); their security-vulnerability finding is the most concrete regression in this evaluation pass and should be weighed accordingly.
- Artificial Analysis aggregator: high confidence on Intelligence Index positioning and head-to-head comparisons.
- Vellum benchmark roll-up: medium-to-high confidence; it cites Anthropic's own numbers but cross-references them against peer models.
- MindStudio review (specifically "What Got Worse" framing): medium-to-high confidence as a hands-on review willing to surface regressions; some of its bench numbers (notably SWE-bench Verified at 71.2 -> 78.9) diverge from the Anthropic-cited 80.8 -> 87.6 and should be treated as a different scoring/evaluator rather than a contradiction. Both numbers indicate improvement; the absolute level is unsettled.
- Vibe Coding "worst release Anthropic has ever shipped" piece: low-to-medium confidence as an opinion piece, but the specific breaking changes it cites (budget_tokens 400, tokenizer 35%, hidden thinking tokens) are concrete and verifiable against the API.
- Axios reporting on the Mythos concession: medium confidence as second-hand via search excerpt; direct fetch returned 403 during this pass, so the headline claim is corroborated but not directly verified.

## Strong Suits

### Agentic Coding And Multi-Step Engineering

Anthropic's strongest framing for Opus 4.7 is agentic engineering work, and third-party evidence broadly supports it:

- SWE-bench Verified: 87.6% (Anthropic table) - up from 80.8% on Opus 4.6.
- SWE-bench Pro: 64.3% - reported at the top of frontier comparisons in Vellum's roll-up (vs GPT-5.5 at 58.6% and Gemini 3.1 Pro at 54.2% on the same bench).
- Terminal-Bench 2.0: 69.4% (Anthropic table) - with the caveat that harnesses differ across providers; the same bench cited 82.7% for GPT-5.5 in Vellum's roll-up, so Opus 4.7 is competitive but not the leader on this specific bench.
- CursorBench: cleared 70% versus Opus 4.6's 58% (Anthropic-cited).
- Plus 14% on complex multi-step workflows over Opus 4.6 at fewer tokens and one-third the tool errors (Anthropic-cited).
- MindStudio reports task-abandonment rates dropped roughly 60% vs Opus 4.6 in their internal testing - i.e., the model carries through tool failures rather than stopping.
- First model reported to pass implicit-need tests (Anthropic-cited).

Fireside implication: a strong candidate for senior-engineering, code-review, and hard-debugging lanes where the agent must carry work through validation rather than stop at a plan. The "carries through tool failures" trait is specifically valuable for receipt-driven autonomous lanes.

### Code Conciseness And Bug Density

Sonar's independent evaluation across 4,444 Java tasks is the most useful third-party data point on what the code actually looks like:

- Functional pass rate: 82.52% (essentially unchanged from Opus 4.6 Thinking's 82.55%).
- Code volume: 40% less code for the same functional pass rate.
- Blocker bugs: 74 per MLOC (improved from 83).
- Critical bugs: 48 per MLOC (unchanged).
- Concurrency/threading bugs: 131 per MLOC (improved from 157).

Fireside implication: when correctness measured by tests is the primary outcome, Opus 4.7 delivers comparable functional quality at meaningfully lower code volume - a real efficiency gain.

### Professional Knowledge Work

- Finance Agent: 64.4%, state-of-the-art per multiple aggregators.
- BigLaw Bench (per Harvey): 90.9% at high effort, with reasoning calibration noted as the qualitative improvement (correctly distinguishing assignment provisions from change-of-control provisions, etc.).
- GDPval-AA: leading per Artificial Analysis's roll-up across 44 occupations (per the GPT-5.5 evaluation pass for context, this is the bench where Gemini 3.1 Pro trails the Anthropic line by ~300 Elo).

Fireside implication: useful for high-value, low-tolerance professional-deliverable lanes where the cost is justified by output quality. Particularly defensible for legal and finance lanes where the bench evidence is direct.

### Vision And Document Handling

Opus 4.7 accepts higher-resolution images than previous Claude models (up to 2576px on the long edge, ~3.75MP total, vs 1568px and ~1.15MP previously). MindStudio describes professional artifact output (interfaces, slides, docs) as more "tasteful and creative" than Opus 4.6 - subjective, but matches the Anthropic-cited gains on LAB-Bench FigQA and CharXiv Reasoning.

Fireside implication: usable for mission lanes that ingest mixed artifacts including high-detail screenshots, charts, and PDFs without separate routing.

### Long-Context And Instruction-Following

Vellum's roll-up specifically calls out that Opus 4.7 holds an advantage on extended-context tasks and instruction-following consistency vs GPT-5.4. The 1M-token window is shared territory with peers; the differentiator per third-party reviewers is consistency across that window rather than headline size.

Fireside implication: appropriate for long-running missions with strict instruction adherence requirements - briefings, multi-stage reviews, evidence-bound deliverables.

## Weak Points

### Web Research / BrowseComp Regression

The most clearly documented regression vs Opus 4.6:

- BrowseComp: dropped 4.4 points vs Opus 4.6 (per Vellum and multiple aggregators).
- MindStudio specifically identifies three concrete degradations vs 4.6: source attribution accuracy declined, contradiction detection between sources weakened, citation specificity lower.
- In autonomous web-browsing workflows, Opus 4.7 reportedly runs more redundant queries and takes more tool calls to complete the same task vs Opus 4.6.

This is a real trade-off that MindStudio attributes to training-data shifts toward agentic coding. It is not a small effect - on a research-bound mission, 4.6 is the better model on this evidence.

Fireside implication: for web-research-heavy lanes (deep research, source-aggregation briefings, contradictions analysis), Opus 4.6 is plausibly the better Claude model and worth keeping in rotation. Do not assume "newer = better" on this surface.

### Security Vulnerability Density - Sonar's Sharpest Finding

Sonar's evaluation flags this as a regression area, and it is the most pointed third-party criticism in this pass:

- Total vulnerability density: 0.29 per kLOC.
- Blocker vulnerabilities: 113 per MLOC (up from 53 - more than double).
- Critical vulnerabilities: 80 per MLOC (up from 56).
- Primary categories: cryptography misconfigurations (57 per MLOC) and hard-coded credentials (45 per MLOC).

Sonar explicitly recommends "rigorous security reviews and automated verification during code generation" - this is unusually direct language for a code-quality evaluator and should not be skipped.

Fireside implication: for any lane that takes Opus 4.7 output to production without explicit security review (cryptography, secrets handling, auth flows, path manipulation), add explicit guardrails or downgrade the routing. The functional pass rate held; the security profile got worse.

### Cognitive Complexity Of Generated Code

Sonar also reports:

- Cognitive complexity: 171.22 per kLOC (up from 132.1 on Opus 4.6 Thinking).
- Cyclomatic complexity: 240.63 per kLOC.
- Comment density: 3.8% (down from 8.2%).

The shorter-code efficiency gain comes with denser, more nested, less commented code. Reviewing each line is harder despite fewer total lines.

Fireside implication: the "40% less code" win has a hidden cost - human or LLM reviewers reading the diff need to spend more effort per line. Worth modeling explicitly when budgeting code-review lanes.

### Tokenizer Cost Increase For English

- MindStudio: ~12-18% more tokens for typical English workloads.
- Vibe Coding piece: 35% more tokens, framed as undisclosed pricing impact.

These are not in conflict if interpreted as different workload mixes (the 35% figure likely reflects heavier reliance on certain token classes). Either way, headline per-token pricing held but effective cost rose for English-dominant lanes.

Fireside implication: when budgeting Opus 4.7 vs alternatives, scale Anthropic's quoted per-token price by ~1.15-1.35x for realistic English workloads. The non-Latin tokenizer win is real but does not apply if Fireside is mostly English.

### API Breaking Changes

- `budget_tokens` parameter removed - existing code returns 400.
- Thinking tokens hidden by default - billing-relevant change.
- Adaptive-thinking-only design removes the previous explicit thinking-budget controls.

These are concrete migration costs, not capability issues.

Fireside implication: any Fireside code that targeted the Opus 4.6 thinking interface needs to be checked. If billing reconciliation depends on visible thinking-token counts, that pipeline needs explicit attention.

### Creative Writing And Conversational Tone

Multiple reviewers report:

- Long-form prose became more mechanical, with the model reaching for bullet points and headers where earlier versions sustained flowing narrative.
- Loss of the conversational warmth that distinguished earlier Claude models.
- Over-formatted outputs.

Anthropic does not claim creative-writing gains in this release, and reviewers consistently report no meaningful improvement.

Fireside implication: not the right pick for tone-sensitive, creative, or long-form narrative lanes. Earlier Claude generations or another provider may serve that surface better.

### Latency

Reviewers report latency slightly higher than Opus 4.6. Not severe but worth noting against the cost picture.

Fireside implication: for latency-critical synchronous lanes, validate response-time budgets explicitly rather than assuming parity with 4.6.

### Anthropic's Own Capability Concession

Per Axios reporting (search excerpt; direct article fetch returned 403), Anthropic conceded at release that Opus 4.7 trails an unreleased internal "Mythos" model. The framing is unusual: vendors rarely position a release as deliberately below their internal frontier, so the disclosure is informative.

Fireside implication: Opus 4.7 is the strongest generally-available Opus today, but Anthropic has signaled a near-term ceiling. Provider-routing decisions made today should expect a Mythos-class follow-up to shift the picture.

### Bench-Number Divergences

Two specific divergences worth keeping in mind when citing numbers:

- SWE-bench Verified: Anthropic table 80.8% -> 87.6%; MindStudio 71.2% -> 78.9%. Same direction, different absolute levels - probably different evaluators or settings.
- Terminal-Bench 2.0: Anthropic table 69.4% for Opus 4.7; the same bench in Vellum's roll-up cites 82.7% for GPT-5.5. Likely consistent if both vendors report on the same harness, but the Anthropic positioning of "competitive but not leading" on this surface is the safer read than "leading."

Fireside implication: when grounding routing decisions in bench numbers, prefer cross-vendor aggregator tables (Vellum, Artificial Analysis) over single-vendor self-reports, and be specific about which scoring is being cited.

## Summary Read

Opus 4.7 looks unambiguously strong on agentic coding, professional knowledge work (legal/finance), code conciseness on functional benches, and instruction-following over long contexts. The clearest regressions are on web research (BrowseComp drop of ~4.4 points plus three concrete degradations cited by MindStudio), generated-code security density (Sonar's blocker vulnerabilities more than doubled), and English tokenizer cost (~15-35% more tokens depending on workload). Creative writing and conversational tone did not improve and reviewers report regressions there too.

For Fireside, the natural fit is engineering-heavy and high-stakes professional-deliverable lanes with explicit security review, with deliberate routing of web-research and creative-writing lanes elsewhere - potentially even back to Opus 4.6 for research surfaces specifically. Anthropic's own concession that an internal Mythos model exceeds 4.7 is a useful signal that today's routing decision should be reviewable against a near-term capability shift.

## Sources (Synthesis Pass)

- Introducing Claude Opus 4.7 - Anthropic: https://www.anthropic.com/news/claude-opus-4-7
- Claude Opus 4.7 - Anthropic: https://www.anthropic.com/claude/opus
- What's new in Claude Opus 4.7 - Claude API Docs: https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7
- Claude Opus 4.7 Benchmarks Explained - Vellum: https://www.vellum.ai/blog/claude-opus-4-7-benchmarks-explained
- Claude Opus 4.7 Review: What Actually Changed and What Got Worse - MindStudio: https://www.mindstudio.ai/blog/claude-opus-4-7-review
- Claude Opus 4.7: An evaluation review and metrics benchmarks - Sonar: https://www.sonarsource.com/blog/claude-opus-4-7-evaluation
- Claude Opus 4.7 (max) - Intelligence, Performance and Price Analysis - Artificial Analysis: https://artificialanalysis.ai/models/claude-opus-4-7
- Opus 4.7 is the worst release Anthropic has ever shipped - Vibe Coding/Medium: https://medium.com/vibe-coding/opus-4-7-is-the-worst-release-anthropic-has-ever-shipped-12772c21ca1e
- Claude Opus 4.7 Backlash Explained - MerchMind: https://merchmindai.net/blog/en/post/claude-opus-4-7-feedback-analysis
- Anthropic releases Claude Opus 4.7, concedes it trails unreleased Mythos - Axios: https://www.axios.com/2026/04/16/anthropic-claude-opus-model-mythos (note: 403 during this pass; cited via search excerpt)
- Anthropic releases Claude Opus 4.7, a less risky model than Mythos - CNBC: https://www.cnbc.com/2026/04/16/anthropic-claude-opus-4-7-model-mythos.html
- Claude Opus 4.7 is generally available - GitHub Changelog: https://github.blog/changelog/2026-04-16-claude-opus-4-7-is-generally-available/
- Introducing Claude Opus 4.7 model in Amazon Bedrock - AWS: https://aws.amazon.com/blogs/aws/introducing-anthropics-claude-opus-4-7-model-in-amazon-bedrock/
- Claude Opus 4.7 Reviewed: Strengths, Weaknesses, and a Practical Verdict - Medium: https://medium.com/@kanishks772/claude-opus-4-7-reviewed-strengths-weaknesses-and-a-practical-verdict-6ef163a547fe

