# Chorus Comparison — Gaps Worth Closing

**Date:** 2026-05-08
**Source:** [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) (v0.7.0 era — npm `@chorus-aidlc/chorus`)
**Method:** Read Chorus's README, docs index, and package layout; cross-checked against fireside's `server/src/` (`orchestration/`, `mission-state/`, `pipelines/`, `routing/`, `permissions.ts`). Chorus content treated as untrusted data — feature extraction only.

## What Chorus is

Agent harness for AI-human collaboration, Next.js + PostgreSQL/Prisma + Tailwind/shadcn. Inspired by AWS's AI-DLC methodology. Multi-tenant, browser-first, MCP-server-shaped. Companies → Project Groups → Projects, OIDC + API key auth, AWS CDK deploy story.

The relevant overlap with fireside: both are agent harnesses that orchestrate multi-agent collaboration with persistent state, run lifecycle, and structured task progression.

## Gaps fireside has that should close

### 1. MCP server surface (highest value)
Chorus exposes ~50 MCP tools at `/api/mcp` (HTTP Streamable Transport, permission-gated). Any MCP client — Claude Code, Cursor, Continue, OpenCode, OpenClaw — can drive Chorus directly. Fireside is MCP-only on the *consumer* side (it shells out to provider CLIs); it doesn't expose itself as MCP.

Closing this would let non-CLI agents *participate* in fireside rooms. Tool surface to consider: `fireside_post_message`, `fireside_create_mission`, `fireside_add_task`, `fireside_request_permission`, `fireside_search`, `fireside_get_transcript`.

### 2. Structured AI-DLC workflow with verify gates
Chorus enforces Idea → (Q&A elaboration) → Proposal → Admin approval → Execute → dual-path Acceptance Criteria (Dev self-checks + Admin verifies independently with pass/fail evidence) → Done. Fireside has missions (`mission-create`/`-phase`/`-plan`/`-task`/`-receipts`) but no proposal-approval gate, AC is a free-text blob, and receipt verification is single-path.

→ Spec drafted at `docs/mission-proposal-verify-gates-2026-05-07.md`.

### 3. Reviewer-role agents
Chorus ships independent `proposal-reviewer` and `task-reviewer` agents that critique work products before they advance. Fireside already runs Claude+Codex+Gemini in parallel — assigning one of them as reviewer per mission phase is a small orchestration tweak that pairs naturally with the dual-path verify gate above.

### 4. Visual Task DAG + Kanban
Chorus has an interactive DAG with cycle detection and a real-time To-Do/In-Progress/To-Verify Kanban with agent presence. Fireside's mission lanes, phases, and dependency refs (`task_checklist_items.dependency_refs`) could feed both views; today they're only visible through the run rail.

### 5. Universal search (Cmd+K)
Across rooms / missions / transcripts / runs / fixtures with scope filters and snippet generation. Fireside has none, and the value compounds as room history grows. Chorus exposes the same backend through MCP (`chorus_search`), so agents can search too.

### 6. Notification center
In-app notifications with per-event preferences and SSE push for run completion, permission requests, mentions, mission state changes. Fireside has the events; the inbox/preferences surface is missing.

### 7. Activity stream / audit trail UI
Fireside has logs and `run-activity.ts`; Chorus surfaces the equivalent as a structured audit stream with session attribution. Cheap UI win on top of data fireside already has.

### 8. Document export (MD / PDF / Word)
Chorus exports proposals/PRDs. Fireside's transcripts and mission summaries are prime export candidates — at minimum MD; PDF nice-to-have for review handoffs.

### 9. One-command install + Claude Code plugin distribution
`npx @chorus-aidlc/chorus` vs fireside's clone-then-build. Chorus also publishes a Claude Code plugin under `plugins/chorus` and skills under `public/chorus-plugin/skills/` so `/plugin marketplace add` wires the in-room Claude agent up automatically. Fireside doesn't ship a plugin or an npm-published binary.

### 10. Per-client setup wizard with verify-connection step
Chorus has Settings → Setup Guide with per-client paths (Claude Code / Codex / OpenCode / OpenClaw / generic MCP) that mints API keys and tests round-trip. Fireside's `verify:clis` is a CLI-only check.

## Out of scope (deliberate misalignments)

These match Chorus's SaaS-shaped posture, which fireside is not:

- Multi-tenancy (Companies / Project Groups / Projects, OIDC+PKCE, API keys, SuperAdmin)
- Redis Pub/Sub for horizontal scaling
- AWS CDK deploy package
- PostgreSQL/Prisma backend — fireside's `better-sqlite3` is the right choice for single-user local

## Top three to start with

If only three: **MCP server surface (#1)**, **proposal/approve/AC verify gates (#2)**, **DAG+Kanban UI (#4)**. They compound — once fireside speaks MCP and has structured verify gates with a visual surface, reviewer agents, search, notifications, and exports all become incremental layers on top.

## Specs in flight

| # | Title | Status |
|---|---|---|
| 2 | Mission Proposal/Approve/Verify Gates | spec at `docs/mission-proposal-verify-gates-2026-05-07.md` |
| 1, 4, 3, 5–10 | (see above) | not yet specced |
