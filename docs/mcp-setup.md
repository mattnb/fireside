# MCP Endpoint Setup

Fireside exposes an optional Model Context Protocol (MCP) endpoint at
`POST /api/mcp` that forwards JSON-RPC 2.0 calls into the structured agent
tool engine. It is **off by default** and only registered when
`FIRESIDE_ENABLE_MCP=1` is set in the server environment.

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
$env:FIRESIDE_ENABLE_MCP = '1'
npm start
```

```bash
# macOS / Linux
export FIRESIDE_MCP_API_KEY="$(openssl rand -hex 32)"
export FIRESIDE_ENABLE_MCP=1
npm start
```

You can also set both vars in `.env` (see `.env.example`). Treat the value
as a shared secret: anyone holding it can drive the structured tool engine
on your machine over the network.

## Quick Verification

With the server running and `FIRESIDE_ENABLE_MCP=1`:

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

A loopback call without the flag set returns 404 (the route is not
registered). A non-loopback call without the key configured returns 403; a
non-loopback call with a wrong/missing bearer returns 401.

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
