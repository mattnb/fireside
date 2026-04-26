/* fireside chat client */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const roomList = $('#room-list');
const messageList = $('#message-list');
const channelName = $('#channel-name');
const channelAgents = $('#channel-agents');
const composerForm = $('#composer');
const authorInput = $('#author-input');
const messageInput = $('#message-input');
const sendBtn = $('#send-btn');
const meAvatar = $('#me-avatar');
const newRoomBtn = $('#new-room-btn');
const modal = $('#modal');
const newRoomForm = $('#new-room-form');
const newRoomName = $('#new-room-name');
const membersBody = $('#members-body');

const KNOWN_AGENTS = ['claude', 'codex', 'gemini'];
const AVATAR_LETTER = { claude: 'C', codex: 'X', gemini: 'G' };

let rooms = [];
let currentRoomId = null;
let ws = null;
let lastMessageAuthor = null;
/* per-room state used to render the members panel */
const roomHumans = new Map(); // roomId -> Set of human authorIds
const thinking = new Set();   // agent ids currently dispatched in current room

/* ---------- helpers ---------- */

function authorClass(authorKind, authorId) {
  if (authorKind === 'system') return 'system';
  if (KNOWN_AGENTS.includes(authorId)) return authorId;
  return 'me';
}

function avatarFor(authorKind, authorId) {
  const div = document.createElement('div');
  div.className = `avatar avatar--${authorClass(authorKind, authorId)}`;
  let letter;
  if (authorKind === 'system') letter = '!';
  else if (KNOWN_AGENTS.includes(authorId)) letter = AVATAR_LETTER[authorId];
  else letter = (authorId || '?').slice(0, 1).toUpperCase();
  div.textContent = letter;
  return div;
}

function avatarSm(agentId) {
  const div = document.createElement('div');
  div.className = `avatar avatar--sm avatar--${agentId}`;
  div.textContent = AVATAR_LETTER[agentId] || agentId.slice(0, 1).toUpperCase();
  div.title = agentId;
  return div;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function fmtFullTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* render message body, linkifying @mentions and code spans */
function renderBody(text) {
  const frag = document.createDocumentFragment();
  // Split on triple-backtick fenced blocks first
  const parts = text.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    if (part.startsWith('```') && part.endsWith('```') && part.length >= 6) {
      const pre = document.createElement('pre');
      pre.textContent = part.slice(3, -3).replace(/^\n/, '');
      frag.appendChild(pre);
      continue;
    }
    // Inline code spans + @mentions
    const inlineParts = part.split(/(`[^`]+`|@(?:claude|codex|gemini)\b)/g);
    for (const ip of inlineParts) {
      if (!ip) continue;
      if (ip.startsWith('`') && ip.endsWith('`') && ip.length >= 2) {
        const code = document.createElement('code');
        code.textContent = ip.slice(1, -1);
        frag.appendChild(code);
      } else if (ip.startsWith('@')) {
        const mention = document.createElement('span');
        mention.className = 'mention';
        mention.textContent = ip;
        frag.appendChild(mention);
      } else {
        frag.appendChild(document.createTextNode(ip));
      }
    }
  }
  return frag;
}

/* ---------- rooms ---------- */

function renderRoomList() {
  roomList.innerHTML = '';
  if (rooms.length === 0) {
    const li = document.createElement('li');
    li.style.padding = '8px 10px';
    li.style.color = 'var(--text-faint)';
    li.style.fontSize = '13px';
    li.textContent = 'no rooms yet — light one up';
    roomList.appendChild(li);
    return;
  }
  for (const room of rooms) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'room-pill' + (room.id === currentRoomId ? ' is-active' : '');
    btn.dataset.roomId = room.id;
    btn.innerHTML = `
      <span class="room-pill__hash">#</span>
      <span class="room-pill__name"></span>
      <span class="room-pill__count"></span>
    `;
    btn.querySelector('.room-pill__name').textContent = room.name;
    btn.querySelector('.room-pill__count').textContent = String(room.agents.length || 0);
    btn.addEventListener('click', () => selectRoom(room.id));
    li.appendChild(btn);
    roomList.appendChild(li);
  }
}

function renderChannelHeader(room) {
  if (!room) {
    channelName.textContent = 'no room selected';
    channelAgents.innerHTML = '';
    messageInput.placeholder = 'pick a room first';
    messageInput.disabled = true;
    sendBtn.disabled = true;
    return;
  }
  channelName.textContent = room.name;
  messageInput.placeholder = `message #${room.name}`;
  messageInput.disabled = false;
  sendBtn.disabled = false;

  channelAgents.innerHTML = '';
  for (const id of room.agents) {
    channelAgents.appendChild(avatarSm(id));
  }
}

async function loadRooms() {
  const r = await fetch('/api/rooms').then((r) => r.json());
  rooms = r;
  renderRoomList();
  if (currentRoomId) {
    const stillExists = rooms.some((rm) => rm.id === currentRoomId);
    if (!stillExists) currentRoomId = null;
  }
  if (!currentRoomId && rooms.length > 0) {
    selectRoom(rooms[0].id);
  } else {
    renderChannelHeader(rooms.find((rm) => rm.id === currentRoomId) || null);
    renderMembers();
  }
}

async function selectRoom(roomId) {
  if (!roomId || !rooms.find((r) => r.id === roomId)) return;
  currentRoomId = roomId;
  thinking.clear();
  renderRoomList();
  const room = rooms.find((r) => r.id === roomId);
  renderChannelHeader(room);
  lastMessageAuthor = null;
  messageList.innerHTML = '';
  showLoading();
  let messages = [];
  try {
    messages = await fetch(`/api/rooms/${roomId}/messages`).then((r) => r.json());
  } catch (err) {
    /* swallow — empty state will show */
  }
  messageList.innerHTML = '';
  // Reset & rebuild humans set from history before rendering, so the members
  // panel reflects the full known cast on first render.
  roomHumans.set(roomId, new Set());
  for (const m of messages) {
    if (m.authorKind === 'human') roomHumans.get(roomId).add(m.authorId);
  }
  // Always include the active local user.
  if (authorInput.value) roomHumans.get(roomId).add(authorInput.value);
  if (messages.length === 0) {
    showEmptyState(room);
  } else {
    for (const m of messages) appendMessage(m);
  }
  renderMembers();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', roomId }));
  }
}

function showLoading() {
  messageList.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'empty-state';
  li.style.color = 'var(--text-faint)';
  li.textContent = 'loading…';
  messageList.appendChild(li);
}

/* ---------- members panel ---------- */

function renderMembers() {
  membersBody.innerHTML = '';
  const room = rooms.find((r) => r.id === currentRoomId);
  if (!room) {
    const empty = document.createElement('div');
    empty.className = 'members__empty';
    empty.textContent = 'no room selected';
    membersBody.appendChild(empty);
    return;
  }

  /* agents section */
  const agentsGroup = document.createElement('section');
  agentsGroup.className = 'members__group';
  const agentsHead = document.createElement('header');
  agentsHead.className = 'members__group-head';
  agentsHead.innerHTML = `<span>agents</span><span class="members__group-head__count">${room.agents.length}</span>`;
  agentsGroup.appendChild(agentsHead);
  if (room.agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'members__empty';
    empty.textContent = 'no agents in this room';
    agentsGroup.appendChild(empty);
  } else {
    for (const id of room.agents) {
      agentsGroup.appendChild(memberRow({ kind: 'agent', id }));
    }
  }
  membersBody.appendChild(agentsGroup);

  /* humans section */
  const humans = Array.from(roomHumans.get(currentRoomId) || []);
  // Make sure the active local user is represented even if they haven't posted.
  if (authorInput.value && !humans.includes(authorInput.value)) {
    humans.push(authorInput.value);
  }
  // Stable ordering: alphabetical, with self bubbled to the top.
  humans.sort((a, b) => a.localeCompare(b));
  const self = authorInput.value;
  if (self && humans.includes(self)) {
    humans.splice(humans.indexOf(self), 1);
    humans.unshift(self);
  }

  const humansGroup = document.createElement('section');
  humansGroup.className = 'members__group';
  const humansHead = document.createElement('header');
  humansHead.className = 'members__group-head';
  humansHead.innerHTML = `<span>humans</span><span class="members__group-head__count">${humans.length}</span>`;
  humansGroup.appendChild(humansHead);
  if (humans.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'members__empty';
    empty.textContent = 'just embers and bots';
    humansGroup.appendChild(empty);
  } else {
    for (const id of humans) {
      humansGroup.appendChild(memberRow({ kind: 'human', id, isSelf: id === self }));
    }
  }
  membersBody.appendChild(humansGroup);
}

function memberRow({ kind, id, isSelf }) {
  const row = document.createElement('div');
  row.className = 'member';
  row.dataset.id = id;
  row.dataset.kind = kind;
  row.appendChild(avatarFor(kind, id));

  const info = document.createElement('div');
  info.className = 'member__info';

  const nameEl = document.createElement('span');
  nameEl.className = 'member__name';
  nameEl.textContent = id;
  if (isSelf) {
    const tag = document.createElement('span');
    tag.className = 'member__you';
    tag.textContent = 'you';
    nameEl.appendChild(tag);
  }
  info.appendChild(nameEl);

  const status = document.createElement('span');
  status.className = 'member__status';
  const dot = document.createElement('span');
  dot.className = 'dot';
  let label;
  if (kind === 'agent') {
    if (thinking.has(id)) {
      dot.classList.add('dot--thinking');
      label = 'thinking…';
    } else {
      dot.classList.add('dot--online');
      label = 'ready';
    }
  } else {
    dot.classList.add(isSelf ? 'dot--online' : 'dot--idle');
    label = isSelf ? 'connected' : 'around';
  }
  status.appendChild(dot);
  status.appendChild(document.createTextNode(label));
  info.appendChild(status);

  row.appendChild(info);
  return row;
}

function showEmptyState(room) {
  const li = document.createElement('li');
  li.className = 'empty-state';
  li.innerHTML = `
    <svg class="empty-state__flame" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2c.5 3 2.5 4.6 4 6.4 1.6 1.9 2.5 3.7 2.5 6.1A6.5 6.5 0 0 1 12 21a6.5 6.5 0 0 1-6.5-6.5c0-2.4.9-4.2 2.5-6.1.6-.7 1.2-1.5 1.7-2.4.4 1.7 1.3 2.6 2.3 3 .1-2 0-4-1-7Z" fill="currentColor"/>
    </svg>
    <p class="empty-state__title">the fire’s still warming</p>
    <p class="empty-state__sub">say something to start the conversation in <strong>#${room.name}</strong>. agents listening: ${room.agents.join(', ') || 'none yet'}.</p>
  `;
  messageList.appendChild(li);
}

/* ---------- messages ---------- */

function appendMessage(msg) {
  // Drop empty-state on first real message
  const empty = messageList.querySelector('.empty-state');
  if (empty) empty.remove();

  // Track membership and thinking state derived from the message stream.
  if (msg.roomId === currentRoomId) {
    if (msg.authorKind === 'human') {
      const room = rooms.find((r) => r.id === msg.roomId);
      if (!roomHumans.has(msg.roomId)) roomHumans.set(msg.roomId, new Set());
      roomHumans.get(msg.roomId).add(msg.authorId);
      // Human just spoke — agents in this room are about to be dispatched.
      if (room) for (const a of room.agents) thinking.add(a);
      renderMembers();
    } else if (msg.authorKind === 'agent') {
      // Agent finished — clear its thinking state.
      thinking.delete(msg.authorId);
      renderMembers();
    } else if (msg.authorKind === 'system') {
      // A system failure message about an agent ('claude failed: ...') means
      // that agent's turn ended without a successful reply — clear thinking.
      const failed = /^\(([a-z]+) failed/i.exec(msg.text);
      if (failed && KNOWN_AGENTS.includes(failed[1])) {
        thinking.delete(failed[1]);
      } else {
        // Unknown system message — clear all to avoid sticky spinners.
        thinking.clear();
      }
      renderMembers();
    }
  }

  const li = document.createElement('li');
  li.className = 'msg';

  if (msg.authorKind === 'system') {
    li.classList.add('is-system');
    if (/failed|timed out|error/i.test(msg.text)) li.classList.add('is-error');
    const body = document.createElement('div');
    body.className = 'msg__body';
    body.textContent = msg.text;
    li.appendChild(body);
    messageList.appendChild(li);
    lastMessageAuthor = null;
    scrollToBottom();
    return;
  }

  const grouped = lastMessageAuthor === msg.authorId;
  if (grouped) li.classList.add('is-grouped');

  li.appendChild(avatarFor(msg.authorKind, msg.authorId));

  const main = document.createElement('div');
  main.className = 'msg__main';

  if (!grouped) {
    const head = document.createElement('div');
    head.className = 'msg__head';
    const author = document.createElement('span');
    author.className = 'msg__author';
    author.dataset.id = msg.authorId;
    author.textContent = msg.authorId;
    const time = document.createElement('span');
    time.className = 'msg__time';
    time.title = fmtFullTime(msg.createdAt);
    time.textContent = fmtTime(msg.createdAt);
    head.appendChild(author);
    head.appendChild(time);
    main.appendChild(head);
  }

  const body = document.createElement('div');
  body.className = 'msg__body';
  body.appendChild(renderBody(msg.text));
  main.appendChild(body);

  li.appendChild(main);
  messageList.appendChild(li);
  lastMessageAuthor = msg.authorId;
  scrollToBottom();
}

function scrollToBottom() {
  // Defer to next frame so layout settles before scroll
  requestAnimationFrame(() => {
    messageList.scrollTop = messageList.scrollHeight;
  });
}

/* ---------- composer ---------- */

composerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!currentRoomId) return;
  const text = messageInput.value.trim();
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'postMessage',
      roomId: currentRoomId,
      authorId: authorInput.value || 'human',
      text,
    }),
  );
  messageInput.value = '';
  messageInput.focus();
});

/* ---------- author identity ---------- */

function setAuthor(name) {
  authorInput.value = name;
  meAvatar.textContent = (name || '?').slice(0, 1).toUpperCase();
  localStorage.setItem('fireside.author', name);
  // Reflect the rename in the members panel of the current room.
  if (currentRoomId) {
    if (!roomHumans.has(currentRoomId)) roomHumans.set(currentRoomId, new Set());
    roomHumans.get(currentRoomId).add(name);
    renderMembers();
  }
}

setAuthor(localStorage.getItem('fireside.author') || 'matt');
authorInput.addEventListener('input', () => setAuthor(authorInput.value));
authorInput.addEventListener('blur', () => {
  if (!authorInput.value.trim()) setAuthor('matt');
});

/* ---------- modal: new room ---------- */

function openModal() {
  modal.hidden = false;
  newRoomName.value = '';
  newRoomName.focus();
  // restore default checks
  $$('.agent-toggle input').forEach((el) => {
    el.checked = true;
  });
}

function closeModal() {
  modal.hidden = true;
}

newRoomBtn.addEventListener('click', openModal);
modal.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.matches('[data-close]')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeModal();
});

newRoomForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = newRoomName.value.trim();
  if (!name) return;
  const agents = Array.from($$('input[name="agent"]:checked')).map((el) => el.value);
  const submitBtn = newRoomForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'creating…';
  try {
    const room = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, agents }),
    }).then((r) => r.json());
    closeModal();
    await loadRooms();
    selectRoom(room.id);
  } catch (err) {
    submitBtn.textContent = 'try again';
  } finally {
    submitBtn.disabled = false;
    if (submitBtn.textContent === 'creating…') submitBtn.textContent = 'light it up';
  }
});

/* ---------- websocket ---------- */

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.addEventListener('open', () => {
    if (currentRoomId) ws.send(JSON.stringify({ type: 'subscribe', roomId: currentRoomId }));
  });
  ws.addEventListener('message', (e) => {
    let evt;
    try {
      evt = JSON.parse(e.data);
    } catch {
      return;
    }
    if (evt.type === 'messageAppended' && evt.message.roomId === currentRoomId) {
      appendMessage(evt.message);
    }
  });
  ws.addEventListener('close', () => setTimeout(connectWs, 1000));
  ws.addEventListener('error', () => {
    /* error fires before close; close handler reconnects */
  });
}

/* ---------- boot ---------- */

connectWs();
loadRooms();
