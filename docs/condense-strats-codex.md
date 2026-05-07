# Fireside Token Condensing Strategies

Research note from Codex, 2026-05-06. No implementation changes were made for this pass.

## Summary

Fireside's token burn is not primarily caused by the visible chat transcript. The larger multiplier is resumed provider context. The live prompt is already bounded, but each agent's resumed CLI session can carry prior prompt, tool, and provider context forward until it is compacted or reset.

In recent local data:

- Recent live prompts were usually 14k-18k chars, roughly 3.5k-4.5k estimated prompt tokens.
- Across the latest 300 stored prompts, the average prompt was about 14k chars.
- Of that average prompt, about 11.6k chars were scaffolding, state, and protocol, while about 2.4k chars were transcript.
- Over the last 48 hours, provider-reported usage was roughly 32x-34x the live prompt estimate for Claude/Codex turns.
- Some Claude turns had a roughly 3.7k estimated prompt but provider context usage near 998k tokens because the resumed CLI session was carrying prior context.

The key conclusion: reducing the live prompt matters, but session lifecycle policy is probably the biggest token-saving lever.

## Highest-Value Strategies

### 1. Use Stateless Worker Turns

Use resumable CLI sessions selectively instead of universally.

Recommended policy:

- Lead/coordinator agents keep resumable sessions, because they benefit from continuity.
- Assigned implementation/review workers default to ephemeral turns, especially in YOLO work-lane execution.
- Workers receive the mission state, assigned work lane, current phase, relevant dependencies, and recent handoff context from Fireside's deterministic state rather than from provider memory.
- After a worker completes a lane, prefer resetting/discarding that provider session unless the next lane explicitly depends on its local investigation context.

Expected impact: high. This attacks the 32x-34x provider-context multiplier directly.

Tradeoff: agents lose some local conversational continuity. Fireside must make Mission Control, receipts, and context artifacts reliable enough to be the source of truth.

### 2. Make Prompt Content Role- and Turn-Specific

The current active-mission prompt injects broadly useful but expensive universal instructions. Workers often do not need the full mission-create schema, roster management protocol, broad collaboration protocol, full active plan body, and all hidden block examples on every turn.

Recommended policy:

- Coordinator/PM turns get planning, phase, checklist, and collaboration protocol.
- Assigned worker turns get only the mission-task and mission-receipt schemas unless they are explicitly expected to update plans or phases.
- Temporary-agent roster protocol only appears for engineering-manager and QA-lead turns that can actually spawn/dismiss temporary agents.
- Mission-create protocol only appears when no active mission exists and the latest message appears to request mission scaffolding.
- Work-lane turns receive the assigned lane and the minimal state needed to complete or block it.

Expected impact: medium to high. In recent prompts, scaffolding/state/protocol averaged far more than transcript.

Tradeoff: under-injecting protocol can reduce state-update compliance. This should be paired with stronger post-run reconciliation and targeted repair prompts.

### 3. Suppress Low-Value Agent Invocations

A meaningful fraction of turns spend a full prompt just for the agent to emit nothing useful. Recent data showed 69 of 500 turn outcomes were "agent declined to add a chat message," averaging around 4k estimated prompt tokens each before provider-session amplification.

Recommended policy:

- Do not invoke an agent unless there is a direct mention, assigned work lane, blocker requiring that agent, explicit handoff, or coordinator need.
- Treat "coordination pulse with no lane" as a scarce action, not a default per-round behavior.
- Route no-lane pulses to the team lead first rather than all eligible agents.
- If an agent repeatedly returns empty/no-op in the same mission phase, suppress future opportunistic turns until new evidence, a direct tag, or a lane appears.

Expected impact: medium. It reduces wasted turns and also reduces resumed-session growth.

Tradeoff: excessive suppression can make agents appear inert. The UI should expose why an agent was not invoked.

### 4. Replace Repeated Protocol Blocks With Protocol References

The prompt repeats hidden command schemas frequently. Once agents are operating reliably, the prompt can reference a stable protocol version and include only the relevant schema.

Recommended policy:

- Introduce a compact protocol reference such as "Fireside mission protocol vN is active."
- Include full schemas only for the hidden block types the agent is likely to need this turn.
- Keep repair prompts capable of re-injecting a full schema when a provider emits malformed hidden blocks.

Expected impact: medium. This will save less than stateless execution but applies to every turn.

Tradeoff: some models may drift if schema examples are not present. This is safest after the reply parsing and repair loop are strong.

### 5. Prefer Reset Over Compact For Some Agents

Auto-compaction exists, but compaction preserves continuity. For worker agents, preserving continuity can be less valuable than wiping accumulated context.

Recommended policy:

- Use compaction for leads and long investigations.
- Use session reset for completed work-lane workers.
- Use lower auto-compact thresholds for expensive/large-context models.
- Add a policy flag like `sessionPolicy: persistent | compacting | ephemeral | reset-after-lane`.

Expected impact: high for YOLO rooms with many repeated worker turns.

Tradeoff: reset requires the next prompt to be self-sufficient. Mission Control state must be concise and current.

## Useful Measurements From The Current System

Recent prompt split from the latest 300 stored prompts:

| Metric | Approximate value |
| --- | ---: |
| Average prompt size | 14,010 chars |
| Average prompt scaffolding/state/protocol | 11,591 chars |
| Average transcript body | 2,407 chars |
| Average live messages | 2.5 |

Recent provider-to-live-prompt ratio over the last 48 hours:

| Provider | Runs | Provider tokens | Live prompt estimate | Ratio |
| --- | ---: | ---: | ---: | ---: |
| Codex | 91 | 12.2M | 365k | 33.6x |
| Claude | 204 | 26.1M | 804k | 32.5x |

This means cutting 25% off the live prompt helps, but it does not solve the main quota burn if provider sessions remain large and persistent.

## Recommended Implementation Order

1. Add a per-agent/per-turn session policy.
2. Default YOLO work-lane workers to ephemeral or reset-after-lane sessions.
3. Keep team leads/coordinators persistent with compaction.
4. Split prompt assembly into role/turn-specific slices.
5. Suppress no-op-prone opportunistic invocations.
6. Add prompt section accounting to run diagnostics so future changes can be measured by section.
7. Gradually replace repeated full protocol schemas with compact protocol references.

## Practical Target

The practical target is not to make every turn tiny. The target is to ensure that a worker doing one checklist lane does not carry the entire room's long-running provider session history unless that continuity is explicitly valuable.
