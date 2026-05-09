# MCP Endpoint Setup

Fireside exposes a Model Context Protocol (MCP) endpoint at `POST /api/mcp`
that forwards JSON-RPC 2.0 calls into the structured agent tool engine. The
route is registered automatically on every server start; there is no enable
flag.

## Trust Contract

Fireside is single-tenant and local-first. The MCP endpoint reflects that:

- **Loopback callers** (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) are trusted
  by virtue of being on the same host. They reach the tool engine with no
  `Authorization` header. This is the common case — Claude Code, Cursor, or
  a script running on the same machine.
- **Non-loopback callers** (anything else, including LAN, tunnels, or
  reverse proxies that do not preserve a loopback `req.ip`) MUST present
  `Authorization: Bearer <FIRESIDE_MCP_API_KEY>`. If the env var is not set,
  every non-loopback request is rejected with HTTP 403 — there is no
  "anonymous remote" mode.

The bearer authenticates the caller; it does not carry identity claims.
Caller attribution comes from optional headers:

- `x-fireside-agent-id` (defaults to `mcp-client`)
- `x-fireside-room-id` (defaults to empty)
- `x-fireside-mission-id` (defaults to none)

These are recorded on the audit row for each tool call.

## Generating the Key

There is no built-in CLI to generate or rotate the key. Pick any reasonable
secret generator and put the result in the server environment:

```powershell
# Windows / PowerShell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:FIRESIDE_MCP_API_KEY = -join ($bytes | ForEach-Object { $_.ToString('x2') })
npm start
```

```bash
# macOS / Linux
export FIRESIDE_MCP_API_KEY="$(openssl rand -hex 32)"
npm start
```

You can also set the key in `.env` (see `.env.example`). Treat the value as
a shared secret: anyone holding it can drive the structured tool engine on
your machine over the network.

## Quick Verification

With the server running:

```bash
# loopback — no auth header needed
curl -sS http://127.0.0.1:8787/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

```bash
# remote — must present the bearer
curl -sS https://your-host/api/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $FIRESIDE_MCP_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A non-loopback call without the key configured returns 403; a non-loopback
call with a wrong/missing bearer returns 401.

## Tool Calls

`tools/call` follows the MCP spec
([2025-06-18 schema](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)).
A successful response wraps engine output in the standard MCP result envelope:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [{ "type": "text", "text": "applied: updated checklist item …" }],
    "isError": false,
    "structuredContent": {
      "callId": "…",
      "toolName": "mission.task.update",
      "status": "applied",
      "summary": "applied: updated checklist item …",
      "duplicateOfCallId": null,
      "result": { "applied": 1, "progressed": 0 }
    }
  }
}
```

`structuredContent` carries Fireside-specific fields (`callId`, `status`,
`duplicateOfCallId`, `result`) for native callers. Standard MCP clients can
ignore it and read the human-readable text from `content[0].text`.

Tool *execution* failures (rejected, denied, timeout) are reported per the
spec inside the result envelope with `isError: true`, **not** as JSON-RPC
errors. Only protocol-level failures (unknown method, malformed params,
unknown room, denied tool) come back as JSON-RPC `error` objects.

### Idempotency

Idempotency keys are an MCP extension, not part of the standard request
shape. The adapter accepts them in two locations:

1. `params.idempotencyKey` — Fireside-native callers.
2. `params._meta.idempotencyKey` — MCP convention for protocol metadata.

If the caller supplies neither, the adapter mints a deterministic key from
the canonical `(agentId, roomId, toolName, arguments)` tuple, hashed with
SHA-256. Standard MCP clients that send no key still get duplicate-collapse:
identical retries fold into a single applied call.

```bash
# spec-compliant call (no idempotencyKey; the server mints one)
curl -sS http://127.0.0.1:8787/api/mcp \
  -H 'content-type: application/json' \
  -H 'x-fireside-room-id: <room>' \
  -d '{
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{"name":"mission.task.update","arguments":{"action":"create","title":"hello","status":"open"}}
  }'
```

## Out of Scope

The current implementation is intentionally minimal:

- **No key rotation or multi-key support.** A single static secret matches
  the single-tenant trust model. If you need rotation without downtime,
  that is future work.
- **No multi-client identity.** All authenticated callers share the same
  trust level; per-caller identity is supplied via the `x-fireside-*`
  headers and recorded for audit, not enforced.
- **No transport-level mTLS or IP allowlisting.** If you expose the
  endpoint beyond loopback, terminate TLS at a reverse proxy and treat the
  bearer as the only auth signal.

For the broader design, see
[docs/phase-6-mcp-endpoint-design-2026-05-07.md](phase-6-mcp-endpoint-design-2026-05-07.md).
