# Claude Opus 4.7 Synthesis

Synthesis date: 2026-05-03

## Purpose

This document reconciles three independent research passes on Claude Opus 4.7 captured in `eval-claude-opus-47.md`: the original detailed eval, an "Independent Research Update (May 2026)" comparison-table pass, and a third "Independent Synthesis Pass (2026-05-03)" weighted toward critical third-party reviewers. The goal is a single durable view of what is reliably known, where the passes disagree, what single-source findings deserve elevation, and what gaps remain.

Bias note: this synthesis was produced by a Claude Opus 4.7 instance evaluating its own model. Where the three passes converge, that is the safer ground. Single-pass criticisms have been preserved without softening; single-pass praise has been treated more skeptically.

## Reconciled Facts (High Confidence)

These claims are corroborated by two or more passes and can be treated as durable working assumptions.

**Release and surface (all three passes)**
- Released 2026-04-16, generally available across Claude products, the Anthropic API, Amazon Bedrock, Google Vertex AI, and Microsoft Foundry.
- API model id: `claude-opus-4-7`.
- Context window: 1M tokens.
- API pricing: $5 per 1M input tokens, $25 per 1M output tokens — unchanged from Opus 4.6.

**Tokenizer and effective cost (all three passes)**
- New tokenizer increases token consumption on English text. Range cited: ~1.0–1.35x in passes 1 and 2; 12–18% typical and 35% in some workloads in pass 3. The directional claim is consistent: per-token price is flat, effective per-task cost is up.
- Tokenizer reduces token consumption on non-Latin scripts (pass 3 quantifies; pass 1 mentions in passing).

**Reasoning-mode change (passes 1 and 3)**
- Adaptive thinking only; previous extended-thinking controls (`budget_tokens`) removed.
- Pass 3 adds: existing code using `budget_tokens` returns 400, and thinking tokens are hidden by default — concrete migration impact.

**Strongest area: agentic coding (all three passes)**
- SWE-bench Pro: 64.3% — leads vs GPT-5.5 (58.6%) and Gemini 3.1 Pro (54.2%) per cross-vendor roll-ups.
- SWE-bench Verified: 87.6% per Anthropic table, up from 80.8% for Opus 4.6 (passes 1 and 3 corroborate; pass 3 flags an alternate evaluator's numbers — see Divergent Claims).
- Stronger multi-step engineering, code review, and validation follow-through across all three passes.

**Tool use and MCP-Atlas (passes 2 and 3 explicitly; pass 1 directionally)**
- MCP-Atlas: 77.3% — leads cross-vendor.
- Multiple passes cite an `xhigh` effort mode for long-running agentic sessions.

**Vision and document handling (passes 1 and 3)**
- Image resolution support up to 2576px on the long edge (~3.75MP), up from 1568px (~1.15MP).
- Pass 1 specifically calls out improvements on LAB-Bench FigQA, CharXiv Reasoning, ScreenSpot-Pro, OSWorld, SWE-bench Multimodal.

**Literal instruction following (all three passes)**
- More literal, more "opinionated" tone, less silent generalization, better pushback on missing data.
- Pass 1 frames this as a strength when prompts are explicit and a weakness when prompts rely on inferred intent. Pass 2 frames it as "argumentative." Pass 3 frames it as instruction-following consistency. Same behavior, different angles.

**Web research regression (passes 1, 2, and 3 all corroborate)**
- BrowseComp: 79.3% in pass 2's table (vs GPT-5.5 90.1%, Gemini 3.1 Pro 85.9%).
- Pass 3 cites the regression as ~4.4 points vs Opus 4.6 with three concrete degradations: source attribution accuracy declined, contradiction detection weakened, citation specificity dropped.
- Pass 1 frames long-context retrieval rather than browsing specifically, but the implication aligns.

**MRCR v2 weakness on 1M-token retrieval (passes 1 and 2)**
- Opus 4.7 scores 32.2% on MRCR v2 at 512K–1M tokens.
- Pass 1 frames this as an intra-model regression: Opus 4.6 was 78.3% on the same bench. Pass 2 frames it as cross-vendor weakness: GPT-5.5 scores 74.0%, Gemini 3.1 Pro 68.1%. Both framings are correct — it is both a regression vs 4.6 and a cross-vendor weakness.

## Divergent Claims (Need Reconciliation)

These are points where the passes disagree. For each, the most defensible working assumption is offered.

**SWE-bench Verified absolute numbers**
- Anthropic table (passes 1 and 3): 80.8% → 87.6%.
- MindStudio review (cited in pass 3): 71.2% → 78.9%.
- Reconciliation: same direction (improvement), different absolute levels. Likely different evaluator harness or scoring rules. The Anthropic figure is the public reference point; the MindStudio figure is third-party but its harness is undocumented in the source. **Working assumption:** cite Anthropic's 87.6% as the headline, hold the 78.9% as a "your harness may produce lower numbers" caveat. Do not present either number as ground truth without specifying harness.

**Tokenizer cost magnitude**
- Passes 1 and 2: 1.0–1.35x range.
- Pass 3: 12–18% typical, 35% in some workloads.
- Reconciliation: the ranges overlap if interpreted by workload. The 1.0–1.35x range aligns with the 12–35% range. **Working assumption:** budget for ~1.15–1.35x English token cost vs Opus 4.6, with high-effort agentic loops trending toward the upper end.

**Terminal-Bench 2.0 cross-vendor positioning**
- Pass 1 reports 69.4% per Anthropic with the caveat that harnesses differ.
- Pass 3 notes the same bench cited 82.7% for GPT-5.5 in Vellum's roll-up.
- Pass 2's comparison table does not include Terminal-Bench.
- Reconciliation: if both numbers refer to the same harness and scoring, GPT-5.5 leads on this bench. If harnesses differ, the comparison is not apples-to-apples. **Working assumption:** Opus 4.7 is competitive on Terminal-Bench 2.0 but not the leader. Do not cite Opus 4.7 as best-in-class for terminal-tool agentic loops without local validation.

**MRCR v2 baseline framing**
- Pass 1: Opus 4.7 (32.2%) is a regression from Opus 4.6 (78.3%) — i.e., this is a thing that got worse.
- Pass 2: Opus 4.7 (32.2%) trails GPT-5.5 (74.0%) and Gemini 3.1 Pro (68.1%) — i.e., this is a cross-vendor weakness.
- Reconciliation: both framings are accurate and not in conflict. The regression-vs-self framing matters for "should we still use Opus 4.7 for retrieval-heavy work?"; the cross-vendor framing matters for "if not Opus 4.7, what then?" Both should be carried forward.

## Single-Pass Claims Worth Elevating

These are findings only one pass surfaced. They have less corroboration than reconciled facts, but several are operationally important enough to elevate with explicit caveats about confidence.

**[HIGH PRIORITY] Sonar security-vulnerability regression (pass 3 only)**
- Sonar's independent code-quality evaluation reports blocker vulnerabilities at 113 per MLOC, up from 53 (more than doubled). Critical vulnerabilities at 80 per MLOC, up from 56. Primary categories: cryptography misconfigurations and hard-coded credentials.
- Why it matters: this is the most concrete, specific, and structurally rigorous third-party criticism in the entire research corpus. It comes from an evaluator with a clear methodology (4,444 Java tasks, 336,283 LOC). Functional pass rate held essentially flat; the security profile got worse.
- Confidence in elevation: high. The methodology is sound and the magnitude is large. **Operational implication:** Opus 4.7 output should not be merged into security-sensitive code paths without explicit security review.

**[HIGH PRIORITY] Anthropic's "Mythos" concession (pass 3 only)**
- Per Axios (cited via search excerpt), Anthropic conceded at release that Opus 4.7 trails an unreleased internal model code-named "Mythos."
- Why it matters: vendors rarely position a release as deliberately below their internal frontier. The disclosure signals a near-term capability shift.
- Confidence in elevation: medium. The Axios article was inaccessible during pass 3 (403); the headline is corroborated by the search excerpt and by CNBC's "less risky model than Mythos" framing. **Operational implication:** today's routing decision should be reviewable on a 1–2 quarter cadence against a Mythos-class follow-up.

**[HIGH PRIORITY] 2026-04-23 Claude Code postmortem (pass 1 only)**
- Anthropic published a postmortem identifying three Claude Code/Cowork/Agent SDK issues that affected early reception:
  - Default reasoning effort had been reduced from high to medium (reverted).
  - A caching bug dropped prior thinking after idle sessions (fixed 2026-04-10).
  - A verbosity-reduction system prompt hurt coding quality (reverted 2026-04-20).
- Anthropic states the API and inference layer were unaffected.
- Why it matters: separates model-level capability evaluation from product-surface behavior. Fireside should evaluate Opus 4.7 through the actual API surface it invokes, not via Claude Code, and not through any benchmarks taken during the affected window.
- Confidence in elevation: high. Vendor postmortem with specific dates and revert timeline.

**[MEDIUM PRIORITY] Sonar code-conciseness and complexity findings (pass 3 only)**
- 40% less code for the same functional pass rate.
- Cognitive complexity 171.22 per kLOC (up from 132.1).
- Cyclomatic complexity 240.63 per kLOC.
- Comment density 3.8% (down from 8.2%).
- Why it matters: efficiency gain is real but comes with denser, less commented code that costs more to review per line. This is a hidden trade-off when budgeting code-review lanes.
- Confidence in elevation: high. Same Sonar methodology as the security finding.

**[MEDIUM PRIORITY] BigLaw Bench 90.9% (pass 3 only)**
- Per Harvey, Opus 4.7 scores 90.9% at high effort on BigLaw Bench, with reasoning calibration on legal review tables specifically called out.
- Why it matters: most legal-domain claims are vendor-flavored. A specific bench number from a partner with a documented use case is more grounded than generic "good at legal work."
- Confidence in elevation: medium. Harvey is a partner, not a fully independent evaluator; treat it as vendor-adjacent rather than vendor-self-report.

**[MEDIUM PRIORITY] USAMO 2026 mathematics ~70% (pass 2 only)**
- Pass 2 says Opus 4.7 trails the GPT-5 series in high-level competitive mathematics, scoring ~70% on USAMO 2026.
- Why it matters: directional signal that Opus 4.7 is not the strongest pick for advanced quantitative reasoning.
- Confidence in elevation: low. No evaluator cited, no evaluator-specific link in pass 2. Treat as a hypothesis to validate, not a conclusion.

**[LOW PRIORITY] File-based memory improvements (pass 1 only)**
- Pass 1 cites Anthropic docs claiming better file-system-based memory, scratchpads, and multi-turn note use.
- Why it matters: relevant to Fireside's mission-receipt and handoff-artifact patterns.
- Confidence in elevation: low — single-source vendor claim. Worth testing on actual Fireside artifacts before relying on it.

**[LOW PRIORITY] Cybersecurity safeguard refusals (pass 1 only)**
- Pass 1 notes real-time cybersecurity safeguards may produce refusals for legitimate security work; Anthropic's Cyber Verification Program may be required.
- Why it matters: relevant if Fireside has security-flavored personas.
- Confidence in elevation: medium for the directional claim, low for predicting specific refusal triggers without testing.

## Gaps Still Uncovered

None of the three passes addressed:

- **Real Fireside-harness behavior.** All numbers are third-party benchmarks or vendor numbers. How Opus 4.7 behaves inside Fireside's specific broker/persona/mission-receipt setup is untested.
- **Latency under Fireside-realistic load.** Pass 3 mentions "slightly higher than 4.6" but no Fireside-specific measurements exist.
- **Behavior against Opus 4.6 baseline on Fireside-specific tasks.** Several passes hint that 4.6 may be the better choice for some lanes (notably web research). A direct A/B on Fireside missions has not been run.
- **Mythos timeline.** Anthropic has signaled that 4.7 is below an internal frontier but has not disclosed when Mythos ships. Routing decisions should anticipate but cannot plan around it.
- **English-cost multiplier on actual Fireside workload mix.** The 1.15–1.35x range is generic. Fireside's English-heavy, agentic-loop-heavy mix may sit at the upper end or beyond.
- **Specific cybersecurity safeguard triggers.** Pass 1 flags possible refusal but does not enumerate triggers; Fireside's security-flavored work has not been tested against Opus 4.7 policy boundaries.
- **Persona-tone compatibility.** Multiple passes flag tone regressions (more mechanical, over-formatted, less warm). Fireside has personas with specific voice expectations; how those interact with the new tone is untested.

## Routing Recommendation For Fireside

**Default to Opus 4.7 for:**
- Senior-engineering work: hard, multi-file implementation, refactors with strong correctness requirements.
- Code review and bug discovery on complex codebases.
- Long-running agentic debugging that needs to carry through tool failures.
- Professional knowledge-work deliverables in legal/finance lanes.
- Vision-heavy work: UX review, screenshot analysis, slide/document editing, dense UI navigation.
- Long-context missions where instruction-following consistency matters more than exact retrieval.

**Route elsewhere for:**
- Web research and source synthesis. On current evidence, Opus 4.6 is the better Claude for this lane (BrowseComp regressed). GPT-5.5 leads BrowseComp at 90.1% per pass 2's table.
- Exact retrieval over very large contexts (>200k tokens of similar items). MRCR v2 1M-token weakness is severe; use indexing/search/citations instead.
- Creative writing and tone-sensitive personas. Multiple passes report regression here.
- Cheap routine summarization. Cost-benefit does not favor Opus 4.7 vs lighter models.
- Latency-critical synchronous chat. Latency is up vs 4.6.

**Add guardrails when routing to Opus 4.7:**
- **Security review on generated code.** The Sonar finding is sharp enough that any lane producing cryptographic, authentication, secrets-handling, or path-manipulation code should pass through explicit security review before merge.
- **Receipt-driven validation in autonomous loops.** The "literal instruction following" trait amplifies the cost of vague specs; require explicit verification receipts per task.
- **Distinguish CLI behavior from API behavior.** Per the 2026-04-23 postmortem, several quality complaints traced to Claude Code/Cowork/Agent SDK bugs rather than the model. Fireside's evaluation should target the actual API surface it uses.
- **Budget effective cost, not sticker cost.** Scale per-token cost by ~1.15–1.35x for English-dominant lanes when comparing to Opus 4.6 budgets.
- **Migrate `budget_tokens` callers.** Anything that referenced the old extended-thinking controls returns 400.

## Open Questions For Local Validation

The following should be answered with Fireside-specific test runs before final routing decisions are committed:

- **Opus 4.7 vs Opus 4.6 on a representative Fireside coding mission.** Run both. Compare receipt completeness, tool-error rate, and final correctness. Validates the "carries through tool failures" claim and the SWE-bench number direction in-harness.
- **Opus 4.7 vs Opus 4.6 on a representative Fireside research mission.** The web-research regression is the most clearly documented downside; verify it manifests in Fireside's research lanes.
- **Sonar-style security audit on Fireside-generated code.** Pick one Opus 4.7-driven lane that produces persisted code, run a structured security pass, and quantify blocker/critical vulnerability density on the actual output.
- **English-cost multiplier on real Fireside workload.** Measure tokens-per-mission on Opus 4.7 vs the Opus 4.6 baseline for a representative sample. Confirm the multiplier sits within the 1.15–1.35x estimate or recalibrate budgets.
- **Persona tone compatibility.** For personas with explicit voice expectations (warm, conversational, narrative), run a side-by-side and have a human evaluate whether the tone regression is operationally significant.
- **Cybersecurity safeguard interaction with Fireside's security-flavored work.** If Fireside has any security personas, audit how Opus 4.7 handles their typical prompts. Identify any refusal patterns before they surface in production.
- **Track Mythos availability.** Add a calendar checkpoint to revisit routing if/when an Opus successor ships.
