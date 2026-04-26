const $ = (sel) => document.querySelector(sel);
const messageList = $('#message-list');
const roomSelect = $('#room-select');
const composer = $('#composer');
const authorInput = $('#author-input');
const messageInput = $('#message-input');
const newRoomBtn = $('#new-room-btn');

let currentRoomId = null;
let ws = null;

authorInput.value = localStorage.getItem('fireside.author') || 'matt';
authorInput.addEventListener('change', () => localStorage.setItem('fireside.author', authorInput.value));

function appendMessage(msg) {
  const li = document.createElement('li');
  li.className = `msg ${msg.authorKind}`;
  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = msg.authorId + ':';
  li.appendChild(author);
  li.appendChild(document.createTextNode(msg.text));
  messageList.appendChild(li);
  messageList.scrollTop = messageList.scrollHeight;
}

async function loadRooms() {
  const r = await fetch('/api/rooms').then((r) => r.json());
  roomSelect.innerHTML = '';
  for (const room of r) {
    const opt = document.createElement('option');
    opt.value = room.id;
    opt.textContent = `${room.name} (${room.agents.join(', ') || 'no agents'})`;
    roomSelect.appendChild(opt);
  }
  if (r.length > 0) selectRoom(r[0].id);
}

async function selectRoom(roomId) {
  currentRoomId = roomId;
  roomSelect.value = roomId;
  messageList.innerHTML = '';
  const messages = await fetch(`/api/rooms/${roomId}/messages`).then((r) => r.json());
  for (const m of messages) appendMessage(m);
  if (ws) ws.send(JSON.stringify({ type: 'subscribe', roomId }));
}

roomSelect.addEventListener('change', (e) => selectRoom(e.target.value));

newRoomBtn.addEventListener('click', async () => {
  const name = prompt('Room name?');
  if (!name) return;
  const agentsInput = prompt('Agents in this room? (comma-separated: claude,codex,gemini)', 'claude,codex,gemini');
  const agents = agentsInput.split(',').map((s) => s.trim()).filter(Boolean);
  const room = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, agents }),
  }).then((r) => r.json());
  await loadRooms();
  selectRoom(room.id);
});

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!currentRoomId) return;
  const text = messageInput.value.trim();
  if (!text) return;
  ws.send(
    JSON.stringify({
      type: 'postMessage',
      roomId: currentRoomId,
      authorId: authorInput.value || 'human',
      text,
    }),
  );
  messageInput.value = '';
});

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.addEventListener('open', () => {
    if (currentRoomId) ws.send(JSON.stringify({ type: 'subscribe', roomId: currentRoomId }));
  });
  ws.addEventListener('message', (e) => {
    const evt = JSON.parse(e.data);
    if (evt.type === 'messageAppended' && evt.message.roomId === currentRoomId) {
      appendMessage(evt.message);
    }
  });
  ws.addEventListener('close', () => setTimeout(connectWs, 1000));
}

connectWs();
loadRooms();
