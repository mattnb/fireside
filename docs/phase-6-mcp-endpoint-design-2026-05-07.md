# Phase 6 — MCP Endpoint Design

Status: design pass (research). 2026-05-07.
Phase id: `gpH3wY87ogiysi`. Lane: `TkS2yuIPb0u1Iq`.

This memo answers Phase 6's three questions:

1. Default-on or feature-flagged?
2. Trust model — local-only, API key, or both?
3. How does the MCP adapter share the existing tool engine without
   duplicating handler logic?

It ships a typed `mcp-adapter.ts` skeleton that the Milestone 6
implementation will plug a Fastify route into. No HTTP route is
registered in this phase — gating that work behind a deliberate flag
flip is the whole point of question 1.

---

## 1. Feature-flag decision

**Decision: default OFF. Enable only when `FIRESIDE_ENABLE_MCP=1`.**

### Why default off

- Today's HTTP surface has **zero authentication** on any route. Every
  `/api/*` route under `server/src/http-server.ts` trusts the caller.
  Fireside is a single-tenant desktop app and binds to `127.0.0.1` by
  default (`config.host`), so loopback-only is the implicit trust
  boundary.
- Operators do override `FIRESIDE_HOST` (we have no enforcement that
  it stays loopback). The moment someone binds to `0.0.0.0` for LAN
  testing or a remote dev tunnel, every MCP-enabled tool becomes a
  remote write API. `mission.task.update`, `permission.request`, and
  `collab.note.add` mutate durable state — that is exactly the wrong
  surface to ship default-on.
- A flag flip is the cheapest possible pre-flight check. If the
  operator has explicitly set `FIRESIDE_ENABLE_MCP=1`, they have read
  one line of release notes and accepted responsibility for what they
  are exposing. If they have not, the endpoint stays off, no
  configuration mistakes possible.
- Default-off also keeps the cost of the rollout linear: we can land
  the adapter, point a single internal client at it via the flag,
  iterate on the schema, and turn it on for everyone later. No
  rollback drama.

### When to flip default-on

When **all** of these are true:

- Every `/api/*` route has a baseline auth check (today: none).
- We have an answer for "what does the MCP endpoint accept as a
  caller identity, and how is that bound to a `RoomAgentProfile`?"
- We have observability on the endpoint (rate/latency/error/denial
  counts) and a kill switch independent of restart.

Until then, the flag stays.

---

## 2. Trust model

**Decision: layered, in this order.**

| Condition                                 | Required to call `/api/mcp`                           |
| ----------------------------------------- | ----------------------------------------------------- |
| `FIRESIDE_ENABLE_MCP` not set / not `"1"` | Endpoint returns 404. Not registered.                 |
| Enabled, request from loopback            | Allowed. No further auth.                             |
| Enabled, non-loopback request, no key set | 403. Endpoint refuses non-loopback by default.        |
| Enabled, non-loopback, `FIRESIDE_MCP_API_KEY` set, header matches | Allowed.                                              |
| Enabled, non-loopback, key set, header missing or wrong | 401.                                                  |

In code:

```
preHandler:
  if (!config.enableMcp) -> 404
  if (isLoopback(req.ip)) -> ok
  if (!config.mcpApiKey) -> 403 "non-loopback requires FIRESIDE_MCP_API_KEY"
  if (req.headers.authorization !== `Bearer ${config.mcpApiKey}`) -> 401
  -> ok
```

### Why layered, not API-key only

- For the common case (the operator running Fireside on their own
  machine, pointing one local MCP client at it), an API key is just
  friction. The loopback gate already proves locality.
- For the long tail (LAN / remote tunnel), explicit opt-in via a
  shared bearer token is the lowest-friction option that still says
  "this is a write API." We could later add per-client keys; one
  shared key is enough to unblock the design.
- Refusing to expose the endpoint over non-loopback **without** a key
  is the safety net. It prevents the obvious "I changed
  `FIRESIDE_HOST` for one demo and forgot to change it back" footgun.

### What we explicitly punt

- Per-room API keys. Phase 6 ships one key for the whole server. If
  multi-tenant isolation matters later, each `RoomAgentProfile` can
  carry a token; the dispatch already takes a per-call context object,
  so the change is local.
- mTLS, OAuth, OIDC. Out of scope for a desktop app's loopback-first
  endpoint. If we ever ship Fireside as a hosted product the answer
  changes; this design does not preclude that, it just doesn't pay
  for it now.
- Anti-abuse (rate limiting, replay protection). Single-tenant tool
  with idempotency keys baked into the engine — `executeToolCall`'s
  prior-call lookup already collapses retries. Adding a token bucket
  is a Phase 7 concern.

---

## 3. Adapter shape

**Decision: one file, one entry point, zero new handler code.**

The MCP transport is JSON-RPC 2.0 over `POST /api/mcp`. The MCP
adapter exposes two methods that map directly onto registry calls:

| MCP method   | Behavior                                                      |
| ------------ | ------------------------------------------------------------- |
| `tools/list` | Read `defaultToolRegistry.list()`, emit `name`, `summary`, `inputSchema`, `requiredPermissions`. |
| `tools/call` | Convert params → `AgentToolCall`, call `executeToolCall`, return outcome. |

This is the same shape the Anthropic / Anthropic-compatible MCP
clients ship today. No new handler logic; the adapter is purely a
translation layer between JSON-RPC envelopes and `AgentToolCall`
objects, mirroring how `hidden-command-adapter.ts` is the translation
layer for hidden blocks.

### Where the boundary lives

```
HTTP request
   ↓
Fastify route /api/mcp                ← Milestone 6 implementation
   ↓ JSON.parse, auth check
dispatchMcpRequest(request, ctx)      ← shipped this phase
   ↓ method dispatch
   tools/list  → registry.list()
   tools/call  → executeToolCall({...}) ← existing engine, unchanged
   ↓
JSON-RPC response
   ↓
HTTP response
```

The Fastify integration deliberately stays out of `mcp-adapter.ts`.
That file knows nothing about Fastify or auth; it parses JSON-RPC
envelopes and turns them into engine calls. Milestone 6 wires it into
`http-server.ts` behind the feature flag and runs the auth pre-handler.

### Tool exposure surface

Phase 6 exposes the **read-and-write subset** that already exists:

- `mission.task.update`, `mission.task.add_note`
- `mission.phase.create/update/complete/reopen`
- `mission.plan.create/update/activate/archive`

It does **not** expose:

- `permission.request` — the human-approval UX is human-in-the-loop;
  exposing it over MCP without a UI hook to surface the pending
  approval would silently strand the request. Milestone 4 ships this
  internally first; we revisit MCP exposure once the UI ack path is
  clear.
- `agent.*` and `agent.coordinate` — until per-caller identity is
  modelled, "set your status" and "request a turn" don't have a
  meaningful subject. We refuse rather than guess.

That keeps the first MCP call surface narrow enough to dogfood without
opening footguns. The `tools/list` filter that enforces this is one
allowlist constant in the adapter.

### Idempotency

MCP clients are expected to send their own `idempotencyKey` per
`tools/call`. If they don't, the adapter rejects with a structured
error rather than minting one — the engine relies on idempotency keys
being meaningful, and a server-minted key from a non-broker source
(no `runId`, no `messageId`) defeats the duplicate-collapse semantic.
This matches how the spec describes idempotency at the tool boundary.

### Source tagging

Calls arrive with `source: 'mcp'`. The `agent_tool_calls.source` enum
already includes `'mcp'`, so audit + run-detail UI render these calls
distinctly without code changes.

---

## 4. Test plan (Milestone 6)

Unit:

- `dispatchMcpRequest` happy path: `tools/list` returns the allowlist
  shape; `tools/call` for `mission.task.update` produces an applied
  outcome with the same audit row a hidden-command call would.
- Method dispatch errors: unknown method → JSON-RPC `-32601`, malformed
  params → `-32602`, internal failures → `-32000` with the engine's
  error message.
- Allowlist enforcement: `tools/call` for a denied tool name
  (`agent.set_status`, `permission.request`) returns
  `application/error` with reason "tool not exposed via MCP".
- Idempotency-key required: `tools/call` without a key → JSON-RPC
  invalid-params with a clear message.

Integration (Milestone 6 only):

- `FIRESIDE_ENABLE_MCP=1` registers the route; absence does not.
- Loopback request without auth: 200.
- Non-loopback without key: 403.
- Non-loopback with key header: 200.
- Source tag on the audit row: `'mcp'`.

Replay:

- Stored MCP transcript replays through `dispatchMcpRequest` and
  produces the same audit ledger as the original run, with no Fastify
  involvement.

---

## 5. Recommended sequencing

1. Land the `mcp-adapter.ts` skeleton + dispatch unit tests (this
   phase, done).
2. Milestone 6: wire `POST /api/mcp` in `http-server.ts` behind
   `config.enableMcp`, with the layered auth pre-handler. New env
   vars: `FIRESIDE_ENABLE_MCP`, `FIRESIDE_MCP_API_KEY`. Document both
   in `config.ts`.
3. Milestone 6: dogfood with one Anthropic MCP client. If the
   Anthropic protocol revs (it has been moving; verify against
   current spec at https://modelcontextprotocol.io/specification),
   adjust envelope shape only — engine call path doesn't change.
4. Phase 7: revisit per-caller identity once we know what consumers
   need from `agent.*` and `permission.request` over MCP.
