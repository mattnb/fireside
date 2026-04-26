// scripts/verify-phase7.cjs
// Phase 7 manual-verification helper: exercises the same flows the browser UI does.
// 1. Creates a room via REST.
// 2. Opens two WebSocket clients, both subscribe.
// 3. Client A posts a human message via WS.
// 4. Both clients should receive the messageAppended broadcast.
// Exits 0 on success, non-zero with diagnostics on failure.

const WsClient = require('ws');

const HOST = process.env.FIRESIDE_HOST || '127.0.0.1';
const PORT = process.env.FIRESIDE_PORT || '8787';
const HTTP = `http://${HOST}:${PORT}`;
const WS_URL = `ws://${HOST}:${PORT}/ws`;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms),
    ),
  ]);
}

function openWs(label) {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(WS_URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(new Error(`${label} ws error: ${err.message}`)));
  });
}

function nextMessageMatching(ws, predicate, label) {
  return new Promise((resolve, reject) => {
    const onMsg = (data) => {
      let evt;
      try {
        evt = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (predicate(evt)) {
        ws.off('message', onMsg);
        resolve(evt);
      }
    };
    ws.on('message', onMsg);
    ws.once('error', (err) => reject(new Error(`${label} ws error: ${err.message}`)));
  });
}

async function main() {
  console.log(`[verify] talking to ${HTTP}`);

  // Step 1: create a room.
  const createRes = await fetch(`${HTTP}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'verify-phase7', agents: [] }),
  });
  if (!createRes.ok) {
    throw new Error(`POST /api/rooms ${createRes.status}: ${await createRes.text()}`);
  }
  const room = await createRes.json();
  console.log(`[verify] created room ${room.id} (${room.name})`);

  // Step 2: open two WS clients.
  const a = await openWs('A');
  const b = await openWs('B');
  console.log('[verify] both ws clients connected');

  // Subscribe both.
  const aSubAck = nextMessageMatching(
    a,
    (e) => e.type === 'subscribed' && e.roomId === room.id,
    'A',
  );
  const bSubAck = nextMessageMatching(
    b,
    (e) => e.type === 'subscribed' && e.roomId === room.id,
    'B',
  );
  a.send(JSON.stringify({ type: 'subscribe', roomId: room.id }));
  b.send(JSON.stringify({ type: 'subscribe', roomId: room.id }));
  await withTimeout(Promise.all([aSubAck, bSubAck]), 2000, 'subscribe ack');
  console.log('[verify] both clients subscribed');

  // Step 3: client A posts a message; both clients should receive messageAppended.
  const aGotMsg = nextMessageMatching(
    a,
    (e) => e.type === 'messageAppended' && e.message.text === 'hi from verifier',
    'A',
  );
  const bGotMsg = nextMessageMatching(
    b,
    (e) => e.type === 'messageAppended' && e.message.text === 'hi from verifier',
    'B',
  );
  a.send(
    JSON.stringify({
      type: 'postMessage',
      roomId: room.id,
      authorId: 'verifier',
      text: 'hi from verifier',
    }),
  );
  const [aEvt, bEvt] = await withTimeout(
    Promise.all([aGotMsg, bGotMsg]),
    5000,
    'message broadcast',
  );

  // Sanity check the message shape — fields the UI relies on.
  for (const [label, evt] of [
    ['A', aEvt],
    ['B', bEvt],
  ]) {
    const m = evt.message;
    if (!m.id || !m.roomId || !m.authorId || !m.authorKind || typeof m.text !== 'string') {
      throw new Error(`${label} got malformed message: ${JSON.stringify(m)}`);
    }
    if (m.authorKind !== 'human') {
      throw new Error(`${label} expected authorKind=human, got ${m.authorKind}`);
    }
  }
  console.log('[verify] both clients received messageAppended; shape OK');
  console.log(`[verify] message: ${JSON.stringify(aEvt.message)}`);

  a.close();
  b.close();
  console.log('[verify] PASS');
}

main().catch((err) => {
  console.error('[verify] FAIL:', err.message);
  process.exit(1);
});
