#!/usr/bin/env node
// Live HTTP smoke test for POST /api/mcp.
//
// Boots a parallel Fireside instance on a free port with FIRESIDE_ENABLE_MCP=1
// and probes:
//   1. tools/list  → expect allowlist-shaped payload
//   2. tools/call mission.task.update with idempotencyKey K → expect "applied"
//      (uses a fresh in-memory DB; the call will surface a domain-level
//      rejection because no mission exists, which still proves the
//      end-to-end dispatch + audit + JSON-RPC envelope path is wired.)
//   3. tools/call same args, same K  → expect "duplicate"
//
// Resolves the smoke test cleanly and exits non-zero on any unexpected shape.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'fireside-mcp-smoke-'));
process.env.FIRESIDE_DATA_DIR = dataDir;
process.env.FIRESIDE_ENABLE_MCP = '1';
process.env.FIRESIDE_PORT = process.env.FIRESIDE_SMOKE_PORT ?? '8798';
process.env.FIRESIDE_HOST = '127.0.0.1';
process.env.FIRESIDE_RESUME_CLI_SESSIONS = '0';
process.env.FIRESIDE_AUTO_COMPACT_ENABLED = '0';

const { start } = await import('../dist/server/src/index.js');

let server;
let exitCode = 0;
const failures = [];

function record(label, ok, detail) {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    exitCode = 1;
    failures.push(label);
  }
}

async function jsonRpc(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, raw: text };
}

async function postJson(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

try {
  server = await start();
  const baseUrl = `http://${server.address.host}:${server.address.port}`;
  const url = `${baseUrl}/api/mcp`;
  console.log(`smoke: target ${url}`);

  // Bootstrap: create a room + mission so tools/call has valid routing context.
  const room = (await postJson(baseUrl, '/api/rooms', {
    name: 'mcp-smoke',
    agents: ['claude'],
  })).body;
  const mission = (await postJson(baseUrl, `/api/rooms/${room.id}/tasks`, {
    title: 'mcp-smoke mission',
  })).body;
  console.log(`smoke: room=${room.id} mission=${mission.id}`);
  const routingHeaders = {
    'x-fireside-room-id': room.id,
    'x-fireside-mission-id': mission.id,
    'x-fireside-agent-id': 'mcp-smoke',
  };

  // 1. tools/list
  {
    const r = await jsonRpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = r.body?.result?.tools;
    const ok = r.status === 200 && Array.isArray(tools) && tools.length >= 1
      && tools.every((t) => typeof t.name === 'string' && typeof t.description === 'string');
    record('tools/list returns allowlist-shaped tools', ok,
      `status=${r.status} count=${Array.isArray(tools) ? tools.length : 'n/a'}`);
    if (ok) {
      const names = tools.map((t) => t.name).join(', ');
      console.log(`       tools: ${names}`);
      const sample = tools[0];
      console.log(`       sample keys: ${Object.keys(sample).sort().join(',')}`);
    }
  }

  // 2 & 3. tools/call applied + duplicate. With routing headers the call
  // creates a real checklist item the first time, then collapses to duplicate
  // on retry — this is the idempotency property the spec promises.
  //
  // The result envelope is MCP-spec-compliant per
  // https://modelcontextprotocol.io/specification/2025-06-18/server/tools §
  // "Tool Result": { content: [{type:"text", text}], isError, structuredContent }.
  // Fireside-specific fields (callId, status, duplicateOfCallId) live under
  // structuredContent for native callers.
  const idemKey = `smoke-${Date.now()}`;
  const callBody = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'mission.task.update',
      idempotencyKey: idemKey,
      arguments: {
        action: 'create',
        title: 'mcp smoke test item',
        status: 'open',
      },
    },
  };

  const first = await jsonRpc(url, callBody, routingHeaders);
  const firstStructured = first.body?.result?.structuredContent ?? null;
  const firstIsError = first.body?.result?.isError ?? null;
  const firstHasContent = Array.isArray(first.body?.result?.content)
    && first.body.result.content[0]?.type === 'text'
    && typeof first.body.result.content[0]?.text === 'string';
  const firstOk = first.status === 200
    && firstHasContent
    && firstIsError === false
    && firstStructured?.status === 'applied';
  record('tools/call applies on first invocation (MCP-shaped result)', firstOk,
    `http=${first.status} isError=${firstIsError} status=${firstStructured?.status ?? 'none'}`);

  const second = await jsonRpc(url, { ...callBody, id: 3 }, routingHeaders);
  const secondStructured = second.body?.result?.structuredContent ?? null;
  const dupOk = second.status === 200
    && second.body?.result?.isError === false
    && secondStructured?.status === 'duplicate'
    && !!secondStructured?.duplicateOfCallId;
  record('tools/call collapses to duplicate on retry', dupOk,
    `http=${second.status} status=${secondStructured?.status ?? 'none'} duplicateOf=${secondStructured?.duplicateOfCallId ?? 'none'}`);

  // 4. unknown method → method not found
  {
    const r = await jsonRpc(url, { jsonrpc: '2.0', id: 4, method: 'totally/bogus' }, routingHeaders);
    const ok = r.status === 200 && r.body?.error?.code === -32601;
    record('unknown method returns -32601', ok,
      `status=${r.status} code=${r.body?.error?.code ?? 'n/a'}`);
  }

  // 5. tool not on allowlist → -32001
  {
    const r = await jsonRpc(url, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'collab.note.add', idempotencyKey: 'smoke-blocked', arguments: {} },
    }, routingHeaders);
    const ok = r.status === 200 && r.body?.error?.code === -32001;
    record('non-allowlisted tool returns -32001', ok,
      `status=${r.status} code=${r.body?.error?.code ?? 'n/a'}`);
  }

  // 6. missing routing context → invalidParams (no header → no roomId)
  {
    const r = await jsonRpc(url, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'mission.task.update',
        idempotencyKey: 'smoke-noroom',
        arguments: { action: 'create', title: 'no-room', status: 'open' },
      },
    });
    const ok = r.status === 200 && r.body?.error?.code === -32602;
    record('missing routing context returns -32602', ok,
      `status=${r.status} code=${r.body?.error?.code ?? 'n/a'}`);
  }

  // 7. spec compliance: standard MCP clients send no `idempotencyKey`. The
  // adapter mints a deterministic key from the (caller, tool, args) tuple, so
  // identical retries collapse exactly like a caller-supplied key.
  {
    const noKeyBody = {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'mission.task.update',
        arguments: {
          action: 'create',
          title: 'mcp smoke no-key item',
          status: 'open',
        },
      },
    };
    const a = await jsonRpc(url, noKeyBody, routingHeaders);
    const b = await jsonRpc(url, { ...noKeyBody, id: 8 }, routingHeaders);
    const aStatus = a.body?.result?.structuredContent?.status ?? null;
    const bStatus = b.body?.result?.structuredContent?.status ?? null;
    const ok = a.status === 200 && b.status === 200
      && aStatus === 'applied' && bStatus === 'duplicate';
    record('tools/call mints idempotency key when caller omits it (spec-compliant clients still get duplicate-collapse)', ok,
      `first=${aStatus ?? 'none'} second=${bStatus ?? 'none'}`);
  }
} catch (err) {
  console.error('smoke: harness error', err);
  exitCode = 2;
} finally {
  if (server) {
    try { await server.shutdown(); } catch { /* ignore */ }
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failures.length) {
  console.log(`\nFAILED: ${failures.join('; ')}`);
} else {
  console.log('\nALL PASS');
}
process.exit(exitCode);
