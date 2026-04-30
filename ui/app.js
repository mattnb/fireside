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
const attachFileBtn = $('#attach-file-btn');
const meAvatar = $('#me-avatar');
const newRoomBtn = $('#new-room-btn');
const modal = $('#modal');
const newRoomForm = $('#new-room-form');
const newRoomName = $('#new-room-name');
const membersBody = $('#members-body');
const deleteModal = $('#delete-modal');
const deleteRoomNameEl = $('#delete-room-name');
const deleteConfirmBtn = $('#delete-confirm-btn');
const editAgentsModal = $('#edit-agents-modal');
const editAgentsForm = $('#edit-agents-form');
const editAgentsRoomEl = $('#edit-agents-room');
const runModal = $('#run-modal');
const runModalTitle = $('#run-modal-title');
const runModalSub = $('#run-modal-sub');
const runModalBody = $('#run-modal-body');
const presenceBody = $('#presence-body');

const KNOWN_AGENTS = ['claude', 'codex', 'gemini'];
const AVATAR_FALLBACK = { claude: 'C', codex: 'X', gemini: 'G' };
const AGENT_AVATAR = {
  claude: { label: 'Claude', icon: '/assets/agents/claude.svg' },
  codex: { label: 'Codex', icon: '/assets/agents/codex.svg' },
  gemini: { label: 'Google Gemini', icon: '/assets/agents/gemini.svg' },
};

let rooms = [];
let currentRoomId = null;
let ws = null;
let lastMessageAuthor = null;
/* per-room state used to render the members panel */
const roomHumans = new Map(); // roomId -> Set of human authorIds
const thinking = new Set();   // agent ids currently dispatched in current room
const permissionRequests = new Map(); // requestId -> permission request
const roomTasks = new Map(); // roomId -> task[]
const roomRuns = new Map(); // roomId -> agent run[]
const roomArtifacts = new Map(); // roomId -> artifact listing
const roomCollaboration = new Map(); // roomId -> collaboration ledger item[]
const roomActions = new Map(); // roomId -> agent run action[]
const roomYolo = new Map(); // roomId -> YOLO status
let taskFormRoomId = null;
let openRunDetailId = null;

/* ---------- helpers ---------- */

function authorClass(authorKind, authorId) {
  if (authorKind === 'system') return 'system';
  if (KNOWN_AGENTS.includes(authorId)) return authorId;
  return 'me';
}

function setTextAvatar(el, text) {
  el.classList.remove('avatar--agent');
  el.style.removeProperty('--avatar-icon');
  el.textContent = text;
}

function setAgentAvatar(el, agentId) {
  const avatar = AGENT_AVATAR[agentId];
  if (!avatar) {
    setTextAvatar(el, AVATAR_FALLBACK[agentId] || (agentId || '?').slice(0, 1).toUpperCase());
    return;
  }

  el.classList.add('avatar--agent');
  el.style.setProperty('--avatar-icon', `url("${avatar.icon}")`);
  el.title = avatar.label;
  el.setAttribute('aria-label', avatar.label);
  el.textContent = '';

  const icon = document.createElement('span');
  icon.className = 'avatar__icon';
  icon.setAttribute('aria-hidden', 'true');
  el.appendChild(icon);
}

function avatarFor(authorKind, authorId) {
  const div = document.createElement('div');
  div.className = `avatar avatar--${authorClass(authorKind, authorId)}`;
  if (KNOWN_AGENTS.includes(authorId)) setAgentAvatar(div, authorId);
  else if (authorKind === 'system') setTextAvatar(div, '!');
  else setTextAvatar(div, (authorId || '?').slice(0, 1).toUpperCase());
  return div;
}

function avatarSm(agentId) {
  const div = document.createElement('div');
  div.className = `avatar avatar--sm avatar--${agentId}`;
  setAgentAvatar(div, agentId);
  return div;
}

function hydrateStaticAgentAvatars() {
  for (const agentId of KNOWN_AGENTS) {
    document.querySelectorAll(`.avatar--${agentId}`).forEach((avatar) => {
      setAgentAvatar(avatar, agentId);
    });
  }
}

hydrateStaticAgentAvatars();

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

function fmtShortTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fmtDateTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function elapsedLabel(startedAt, completedAt) {
  if (!startedAt) return '';
  const end = completedAt || Date.now();
  return `${Math.max(0, Math.round((end - startedAt) / 1000))}s`;
}

function ageLabel(ms) {
  if (!ms) return '';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function updateLiveTimers() {
  document.querySelectorAll('[data-elapsed-started]').forEach((el) => {
    const startedAt = Number(el.dataset.elapsedStarted || 0);
    const completedAt = Number(el.dataset.elapsedCompleted || 0);
    el.textContent = elapsedLabel(startedAt, completedAt || null);
  });
  document.querySelectorAll('[data-age-created]').forEach((el) => {
    const createdAt = Number(el.dataset.ageCreated || 0);
    el.textContent = ageLabel(createdAt);
  });
}

function oneLine(text, maxChars = 180) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}

function activeTaskFor(roomId) {
  return (
    (roomTasks.get(roomId) || []).find((task) =>
      ['active', 'blocked', 'verifying'].includes(task.status),
    ) || null
  );
}

function upsertById(items, item) {
  const next = items.filter((existing) => existing.id !== item.id);
  next.unshift(item);
  return next;
}

function basenameFromPath(filePath) {
  return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || 'file';
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
    const inlineParts = part.split(/(`[^`]+`|@file\("[^"]+"\)|@(?:claude|codex|gemini)\b)/g);
    for (const ip of inlineParts) {
      if (!ip) continue;
      if (ip.startsWith('`') && ip.endsWith('`') && ip.length >= 2) {
        const code = document.createElement('code');
        code.textContent = ip.slice(1, -1);
        frag.appendChild(code);
      } else if (ip.startsWith('@file("')) {
        const filePath = ip.slice(7, -2);
        const file = document.createElement('span');
        file.className = 'file-mention';
        file.title = filePath;
        file.textContent = `@file ${basenameFromPath(filePath)}`;
        frag.appendChild(file);
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

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'room-pill__delete';
    delBtn.setAttribute('aria-label', `delete ${room.name}`);
    delBtn.title = 'delete room';
    delBtn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      promptDeleteRoom(room.id);
    });
    btn.appendChild(delBtn);

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
    attachFileBtn.disabled = true;
    return;
  }
  channelName.textContent = room.name;
  messageInput.placeholder = `message #${room.name}`;
  messageInput.disabled = false;
  sendBtn.disabled = false;
  attachFileBtn.disabled = false;

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
  let requests = [];
  let tasks = [];
  let runs = [];
  let artifacts = { files: [] };
  let collaboration = [];
  let actions = [];
  try {
    [messages, requests, tasks, runs, artifacts, collaboration, actions] = await Promise.all([
      fetch(`/api/rooms/${roomId}/messages`).then((r) => r.json()),
      fetch(`/api/rooms/${roomId}/permission-requests`).then((r) => r.json()),
      fetch(`/api/rooms/${roomId}/tasks`).then((r) => r.json()),
      fetch(`/api/rooms/${roomId}/runs`).then((r) => r.json()),
      fetch(`/api/rooms/${roomId}/artifacts`).then((r) => r.json()),
      fetch(`/api/rooms/${roomId}/collaboration`).then((r) => r.json()),
      fetch(`/api/rooms/${roomId}/actions`).then((r) => r.json()),
    ]);
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
  roomTasks.set(roomId, tasks);
  roomRuns.set(roomId, runs);
  roomArtifacts.set(roomId, artifacts);
  roomCollaboration.set(roomId, collaboration);
  roomActions.set(roomId, actions);
  for (const req of requests) permissionRequests.set(req.id, req);
  const timeline = [
    ...messages.map((message) => ({ kind: 'message', createdAt: message.createdAt, message })),
    ...requests.map((request) => ({
      kind: 'permissionRequest',
      createdAt: request.createdAt,
      request,
    })),
  ].sort((a, b) => a.createdAt - b.createdAt);

  if (timeline.length === 0) {
    showEmptyState(room);
  } else {
    for (const item of timeline) {
      if (item.kind === 'message') appendMessage(item.message);
      else appendPermissionRequest(item.request);
    }
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

/* ---------- command center / members panel ---------- */

function commandGroup(title, count) {
  const group = document.createElement('section');
  group.className = 'members__group command-group';
  const head = document.createElement('header');
  head.className = 'members__group-head';
  const label = document.createElement('span');
  label.textContent = title;
  head.appendChild(label);
  if (count !== undefined) {
    const countEl = document.createElement('span');
    countEl.className = 'members__group-head__count';
    countEl.textContent = String(count);
    head.appendChild(countEl);
  }
  group.appendChild(head);
  return group;
}

function emptyCommandText(text) {
  const empty = document.createElement('div');
  empty.className = 'members__empty';
  empty.textContent = text;
  return empty;
}

function renderTaskPanel(room, target = membersBody) {
  const tasks = roomTasks.get(room.id) || [];
  const activeTask = activeTaskFor(room.id);
  const group = commandGroup('mission', tasks.length);

  if (!activeTask && taskFormRoomId !== room.id) {
    group.appendChild(emptyCommandText('no active mission'));
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'command-btn command-btn--primary';
    start.textContent = 'new mission';
    start.addEventListener('click', () => {
      taskFormRoomId = room.id;
      renderMembers();
    });
    group.appendChild(start);
    target.appendChild(group);
    return;
  }

  if (taskFormRoomId === room.id) {
    group.appendChild(taskForm(room));
  }
  if (activeTask) group.appendChild(taskCard(activeTask));
  target.appendChild(group);
}

function taskForm(room) {
  const form = document.createElement('form');
  form.className = 'task-form';
  form.innerHTML = `
    <input name="title" class="task-form__input" placeholder="mission title" required />
    <textarea name="goal" class="task-form__textarea" placeholder="goal"></textarea>
    <div class="path-picker-row">
      <input name="repoPath" class="task-form__input" placeholder="repo or working path" />
      <button type="button" class="command-btn" data-browse-repo>browse</button>
    </div>
    <textarea name="acceptanceCriteria" class="task-form__textarea" placeholder="acceptance criteria"></textarea>
    <div class="task-form__row">
      <select name="capabilityProfile" class="task-form__select">
        <option value="plan">read-only</option>
        <option value="edit">edit</option>
        <option value="full-auto">full auto</option>
      </select>
      <button type="submit" class="command-btn command-btn--primary">create</button>
      <button type="button" class="command-btn" data-cancel>cancel</button>
    </div>
  `;
  const repoInput = form.querySelector('input[name="repoPath"]');
  const browseRepo = form.querySelector('[data-browse-repo]');
  browseRepo.addEventListener('click', async () => {
    const path = await browseForFolder({
      initialPath: repoInput.value,
      button: browseRepo,
    });
    if (path) repoInput.value = path;
  });
  form.querySelector('[data-cancel]').addEventListener('click', () => {
    taskFormRoomId = null;
    renderMembers();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = 'creating';
    try {
      const task = await fetch(`/api/rooms/${room.id}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: String(data.get('title') || '').trim(),
          goal: String(data.get('goal') || '').trim(),
          repoPath: String(data.get('repoPath') || '').trim(),
          acceptanceCriteria: String(data.get('acceptanceCriteria') || '').trim(),
          capabilityProfile: String(data.get('capabilityProfile') || 'plan'),
        }),
      }).then((r) => {
        if (!r.ok) throw new Error(`create mission failed: ${r.status}`);
        return r.json();
      });
      roomTasks.set(room.id, upsertById(roomTasks.get(room.id) || [], task));
      taskFormRoomId = null;
      renderMembers();
    } catch {
      submit.textContent = 'try again';
    } finally {
      submit.disabled = false;
      if (submit.textContent === 'creating') submit.textContent = 'create';
    }
  });
  return form;
}

function taskCard(task) {
  const card = document.createElement('div');
  card.className = `mission-card mission-card--${task.status}`;
  const title = document.createElement('div');
  title.className = 'mission-card__title';
  title.textContent = task.title;
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'mission-card__meta';
  meta.textContent = `${task.status} / ${task.capabilityProfile}`;
  card.appendChild(meta);

  const pathRow = document.createElement('div');
  pathRow.className = 'path-picker-row mission-card__path-row';
  const pathInput = document.createElement('input');
  pathInput.className = 'task-form__input';
  pathInput.placeholder = 'repo or working path';
  pathInput.value = task.repoPath || '';
  const browsePath = document.createElement('button');
  browsePath.type = 'button';
  browsePath.className = 'command-btn';
  browsePath.textContent = 'browse';
  browsePath.addEventListener('click', async () => {
    const path = await browseForFolder({
      initialPath: pathInput.value,
      button: browsePath,
    });
    if (path) pathInput.value = path;
  });
  const savePath = document.createElement('button');
  savePath.type = 'button';
  savePath.className = 'command-btn command-btn--primary';
  savePath.textContent = 'save path';
  savePath.addEventListener('click', () =>
    patchTask(task.roomId, task.id, { repoPath: pathInput.value.trim() }),
  );
  pathRow.append(pathInput, browsePath, savePath);
  card.appendChild(pathRow);

  const goal = document.createElement('div');
  goal.className = 'mission-card__text';
  goal.textContent = task.goal || 'no goal written yet';
  card.appendChild(goal);

  if (task.acceptanceCriteria) {
    const criteria = document.createElement('div');
    criteria.className = 'mission-card__criteria';
    criteria.textContent = task.acceptanceCriteria;
    card.appendChild(criteria);
  }

  const profile = document.createElement('select');
  profile.className = 'task-form__select';
  profile.innerHTML = `
    <option value="plan">read-only</option>
    <option value="edit">edit</option>
    <option value="full-auto">full auto</option>
  `;
  profile.value = task.capabilityProfile || 'plan';
  profile.addEventListener('change', () =>
    patchTask(task.roomId, task.id, { capabilityProfile: profile.value }),
  );
  card.appendChild(profile);

  const summary = document.createElement('textarea');
  summary.className = 'mission-card__summary';
  summary.placeholder = 'task state summary';
  summary.value = task.summary || '';
  card.appendChild(summary);

  const actions = document.createElement('div');
  actions.className = 'mission-card__actions';
  for (const [label, status] of [
    ['active', 'active'],
    ['blocked', 'blocked'],
    ['verify', 'verifying'],
    ['done', 'done'],
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'command-btn';
    btn.textContent = label;
    btn.disabled = task.status === status;
    btn.addEventListener('click', () => patchTask(task.roomId, task.id, { status }));
    actions.appendChild(btn);
  }
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'command-btn command-btn--primary';
  save.textContent = 'save summary';
  save.addEventListener('click', () => patchTask(task.roomId, task.id, { summary: summary.value }));
  actions.appendChild(save);
  card.appendChild(actions);
  return card;
}

async function patchTask(roomId, taskId, patch) {
  const task = await fetch(`/api/rooms/${roomId}/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => {
    if (!r.ok) throw new Error(`update mission failed: ${r.status}`);
    return r.json();
  });
  roomTasks.set(roomId, upsertById(roomTasks.get(roomId) || [], task));
  renderMembers();
  return task;
}

async function browseForFolder({ initialPath = '', button }) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'opening';
  try {
    const result = await fetch('/api/system/folder-picker', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Fireside-Request': '1',
      },
      body: JSON.stringify({ initialPath }),
    }).then((r) => {
      if (!r.ok) throw new Error(`folder picker failed: ${r.status}`);
      return r.json();
    });
    return result.path || '';
  } catch {
    button.textContent = 'failed';
    setTimeout(() => {
      button.textContent = originalLabel;
    }, 1200);
    return '';
  } finally {
    button.disabled = false;
    if (button.textContent === 'opening') button.textContent = originalLabel;
  }
}

async function browseForFile({ initialPath = '', button }) {
  const originalTitle = button.title;
  button.disabled = true;
  button.title = 'Opening file picker';
  try {
    const result = await fetch('/api/system/file-picker', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Fireside-Request': '1',
      },
      body: JSON.stringify({ initialPath }),
    }).then((r) => {
      if (!r.ok) throw new Error(`file picker failed: ${r.status}`);
      return r.json();
    });
    return result.path || '';
  } catch {
    button.title = 'File picker failed';
    setTimeout(() => {
      button.title = originalTitle;
    }, 1200);
    return '';
  } finally {
    button.disabled = false;
    if (button.title === 'Opening file picker') button.title = originalTitle;
  }
}

function dirnameFromPath(filePath) {
  const cleaned = String(filePath || '');
  const index = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'));
  return index > 0 ? cleaned.slice(0, index) : '';
}

function insertComposerReference(reference) {
  const start = messageInput.selectionStart ?? messageInput.value.length;
  const end = messageInput.selectionEnd ?? messageInput.value.length;
  const before = messageInput.value.slice(0, start);
  const after = messageInput.value.slice(end);
  const leading = before && !/\s$/.test(before) ? ' ' : '';
  const trailing = after && !/^\s/.test(after) ? ' ' : '';
  const insert = `${leading}${reference}${trailing}`;
  messageInput.value = `${before}${insert}${after}`;
  const cursor = before.length + insert.length;
  messageInput.focus();
  messageInput.setSelectionRange(cursor, cursor);
}

async function attachFileFixture(roomId, sourcePath) {
  const response = await fetch(`/api/rooms/${roomId}/fixtures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourcePath }),
  });
  if (!response.ok) throw new Error(`attach file failed: ${response.status}`);
  return response.json();
}

function canRemoveArtifact(file) {
  return file.kind === 'fixture' || file.kind === 'draft-artifact';
}

async function removeArtifact(roomId, file, button) {
  button.disabled = true;
  button.title = 'Removing artifact';
  try {
    const response = await fetch(`/api/rooms/${roomId}/artifacts`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: file.kind, path: file.path }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `remove artifact failed: ${response.status}`);
    }
    if (currentRoomId === roomId) await refreshArtifacts(roomId);
  } catch (err) {
    button.disabled = false;
    button.classList.add('is-error');
    button.title = err instanceof Error ? err.message : 'Remove artifact failed';
    setTimeout(() => {
      button.classList.remove('is-error');
      button.title = 'Remove artifact';
    }, 1800);
  }
}

function artifactRemoveButton(roomId, file) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'artifact-row__remove';
  button.textContent = 'x';
  button.title = 'Remove artifact';
  button.setAttribute('aria-label', `Remove ${file.kind} artifact`);
  let confirmTimer = null;

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.confirm !== '1') {
      button.dataset.confirm = '1';
      button.classList.add('is-confirming');
      button.title = 'Click again to remove';
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        button.dataset.confirm = '';
        button.classList.remove('is-confirming');
        button.title = 'Remove artifact';
      }, 2500);
      return;
    }
    if (confirmTimer) clearTimeout(confirmTimer);
    button.dataset.confirm = '';
    button.classList.remove('is-confirming');
    void removeArtifact(roomId, file, button);
  });

  return button;
}

function renderControlPanel(room, target = membersBody) {
  const group = commandGroup('controls');
  if (room.agents.length === 0) {
    group.appendChild(emptyCommandText('add an agent first'));
    target.appendChild(group);
    return;
  }

  const activeTask = activeTaskFor(room.id);
  const controls = document.createElement('div');
  controls.className = 'command-controls';
  const select = document.createElement('select');
  select.className = 'task-form__select';
  for (const agent of room.agents) {
    const option = document.createElement('option');
    option.value = agent;
    option.textContent = agent;
    select.appendChild(option);
  }
  controls.appendChild(select);

  const yoloProfile = document.createElement('div');
  yoloProfile.className = 'yolo-profile';

  const yoloMode = document.createElement('select');
  yoloMode.className = 'task-form__select';
  [
    ['edit', 'edit/write'],
    ['plan', 'read-only'],
    ['full-auto', 'full auto'],
  ].forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    yoloMode.appendChild(option);
  });

  const yoloScope = document.createElement('select');
  yoloScope.className = 'task-form__select';
  [
    ['task', 'mission path'],
    ['cwd', 'fireside cwd'],
    ['custom', 'custom path'],
    ['unrestricted', 'unrestricted'],
  ].forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    yoloScope.appendChild(option);
  });

  const yoloTarget = document.createElement('input');
  yoloTarget.className = 'task-form__input yolo-profile__target';
  yoloTarget.placeholder = 'custom path';

  const yoloTargetRow = document.createElement('div');
  yoloTargetRow.className = 'yolo-profile__target-row';

  const yoloBrowse = document.createElement('button');
  yoloBrowse.type = 'button';
  yoloBrowse.className = 'command-btn yolo-profile__browse';
  yoloBrowse.textContent = 'browse';
  yoloBrowse.addEventListener('click', () => void browseForYoloTarget());
  yoloTargetRow.append(yoloTarget, yoloBrowse);

  const yoloWebLabel = document.createElement('label');
  yoloWebLabel.className = 'yolo-profile__check';
  const yoloWeb = document.createElement('input');
  yoloWeb.type = 'checkbox';
  yoloWebLabel.appendChild(yoloWeb);
  yoloWebLabel.append('web');

  function syncYoloControls() {
    const custom = yoloScope.value === 'custom';
    yoloProfile.classList.toggle('yolo-profile--custom', custom);
    yoloTargetRow.hidden = !custom;
    yoloTarget.disabled = !custom;
    yoloBrowse.disabled = !custom;
    if (!custom) yoloTarget.value = '';
    if (custom && document.activeElement === yoloScope) yoloTarget.focus();
    if (yoloScope.value === 'unrestricted') yoloMode.value = 'full-auto';
  }

  async function browseForYoloTarget() {
    const path = await browseForFolder({
      initialPath: yoloTarget.value,
      button: yoloBrowse,
    });
    if (path) yoloTarget.value = path;
    yoloBrowse.disabled = yoloScope.value !== 'custom';
  }
  yoloScope.addEventListener('change', syncYoloControls);
  syncYoloControls();

  const actions = [
    {
      label: 'plan',
      run: () =>
        postControlMessage(
          `Team, create a concise execution plan for the active mission${activeTask ? ` "${activeTask.title}"` : ''}. Record the agreed strategy and rationale in Mission Control with a /mission-plan block first, then record phase gates with /mission-phase blocks, then break the mission into independent and dependent checklist work items assigned to those phases with /mission-task blocks. Challenge weak assumptions, identify evidence or citations needed, call out open disagreements, and end with the current recommended first action. Stay in planning mode; do not edit files unless a human explicitly approves execution.`,
        ),
    },
    {
      label: 'next step',
      run: () =>
        postControlMessage(
          `@${select.value} please take the next focused execution step on the active mission. Use the task summary and recent context; request permission if you need broader tools.`,
        ),
    },
    {
      label: 'review',
      run: () =>
        postControlMessage(
          `@${select.value} please review the active mission state and latest work. Call out concrete risks, disagreements, and missing verification.`,
        ),
    },
    {
      label: 'sync',
      run: () =>
        postControlMessage(
          `Team, briefly align on the active mission${activeTask ? ` "${activeTask.title}"` : ''}: current state, next action, and who should take it. Stay focused.`,
        ),
    },
    {
      label: 'verify',
      run: async () => {
        if (activeTask) await patchTask(room.id, activeTask.id, { status: 'verifying' });
        postControlMessage(
          `Team, run a verification pass for the active mission. Separate implementation claims from evidence, identify missing tests or review gaps, and end with a pass/fail recommendation.`,
        );
      },
      className: '',
    },
  ];

  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `command-btn ${action.className || ''}`.trim();
    btn.textContent = action.label;
    btn.addEventListener('click', () => void action.run());
    controls.appendChild(btn);
  }

  const yoloBtn = document.createElement('button');
  yoloBtn.type = 'button';
  yoloBtn.className = 'command-btn command-btn--yolo';
  yoloBtn.textContent = 'YOLO';
  yoloBtn.title = 'Let participating agents collaborate for up to 100 total messages.';
  const yoloStatus = roomYolo.get(room.id);
  yoloBtn.disabled = yoloStatus?.active === true;
  yoloBtn.addEventListener('click', () => {
    void startYoloDiscussion({
      mode: yoloMode.value,
      filesystemScope: yoloScope.value,
      target: yoloTarget.value,
      web: yoloWeb.checked,
    });
  });
  const stopYoloBtn = document.createElement('button');
  stopYoloBtn.type = 'button';
  stopYoloBtn.className = 'command-btn command-btn--danger';
  stopYoloBtn.textContent = 'stop';
  stopYoloBtn.title = 'Stop the active YOLO discussion and interrupt in-flight agent turns where possible.';
  stopYoloBtn.addEventListener('click', () => cancelYoloDiscussion());
  yoloProfile.append(yoloMode, yoloScope, yoloWebLabel, yoloBtn, stopYoloBtn, yoloTargetRow);
  group.appendChild(controls);
  group.appendChild(yoloProfile);
  target.appendChild(group);
}

function postControlMessage(text) {
  if (!currentRoomId || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'postMessage',
      roomId: currentRoomId,
      authorId: authorInput.value || 'human',
      text,
    }),
  );
}

function startYoloDiscussion(profile = {}) {
  if (!currentRoomId || !ws || ws.readyState !== WebSocket.OPEN) return;
  roomYolo.set(currentRoomId, { roomId: currentRoomId, active: true });
  renderMembers();
  ws.send(
    JSON.stringify({
      type: 'startYolo',
      roomId: currentRoomId,
      authorId: authorInput.value || 'human',
      profile,
    }),
  );
}

function latestActionForRun(roomId, runId) {
  return (roomActions.get(roomId) || []).find((action) => action.runId === runId) || null;
}

function canDismissRun(roomId, run) {
  if (run.status !== 'running') return false;
  const action = latestActionForRun(roomId, run.id);
  const referenceTime = action?.createdAt || run.startedAt || 0;
  return referenceTime > 0 && Date.now() - referenceTime >= 5 * 60 * 1000;
}

async function dismissRun(roomId, run) {
  const response = await fetch(`/api/rooms/${roomId}/runs/${run.id}/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorId: authorInput.value || 'human' }),
  });
  if (!response.ok) throw new Error(`dismiss run failed: ${response.status}`);
  const updated = await response.json();
  roomRuns.set(roomId, upsertById(roomRuns.get(roomId) || [], updated));
  renderMembers();
}

function renderActiveWorkPanel(room, target = membersBody) {
  const activeRuns = (roomRuns.get(room.id) || []).filter((run) => run.status === 'running');
  if (activeRuns.length === 0) return;

  const group = commandGroup('working', activeRuns.length);
  for (const run of activeRuns.slice(0, 5)) {
    const action = latestActionForRun(room.id, run.id);
    const card = document.createElement('article');
    card.className = `work-card ${canDismissRun(room.id, run) ? 'work-card--stale' : ''}`.trim();
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'work-row';
    row.addEventListener('click', () => void openRunDetail(run.id));

    const top = document.createElement('div');
    top.className = 'work-row__top';
    const agent = document.createElement('span');
    agent.className = 'work-row__agent';
    agent.textContent = run.agentId;
    const elapsed = document.createElement('span');
    elapsed.className = 'work-row__elapsed';
    elapsed.dataset.elapsedStarted = String(run.startedAt);
    elapsed.textContent = elapsedLabel(run.startedAt, null);
    top.append(agent, elapsed);

    const meta = document.createElement('div');
    meta.className = 'work-row__meta';
    meta.textContent = `${run.permissionMode} / ${run.estimatedPromptTokens}t / started ${fmtShortTime(run.startedAt)}`;

    const signal = document.createElement('div');
    signal.className = 'work-row__signal';
    if (action) {
      const age = document.createElement('span');
      age.dataset.ageCreated = String(action.createdAt);
      age.textContent = ageLabel(action.createdAt);
      signal.append(
        document.createTextNode(`${action.label} / `),
        age,
      );
    } else {
      signal.textContent = 'waiting for first broker signal';
    }

    if (action?.detail) {
      const detail = document.createElement('div');
      detail.className = 'work-row__detail';
      detail.textContent = oneLine(action.detail, 160);
      row.append(top, meta, signal, detail);
    } else {
      row.append(top, meta, signal);
    }
    card.appendChild(row);
    if (canDismissRun(room.id, run)) {
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'work-dismiss';
      dismiss.textContent = 'dismiss';
      dismiss.title = 'Dismiss stale running cue';
      dismiss.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        dismiss.disabled = true;
        dismiss.textContent = 'dismissing';
        void dismissRun(room.id, run).catch(() => {
          dismiss.disabled = false;
          dismiss.textContent = 'try again';
        });
      });
      card.appendChild(dismiss);
    }
    group.appendChild(card);
  }
  target.appendChild(group);
}

function cancelYoloDiscussion() {
  if (!currentRoomId || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'cancelYolo',
      roomId: currentRoomId,
      authorId: authorInput.value || 'human',
    }),
  );
}

function renderRunsPanel(room, target = membersBody) {
  const runs = (roomRuns.get(room.id) || []).filter((run) => run.status !== 'running');
  const group = commandGroup('completed runs', runs.length);
  if (runs.length === 0) {
    group.appendChild(emptyCommandText('no completed runs yet'));
    target.appendChild(group);
    return;
  }
  for (const run of runs.slice(0, 7)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `run-row run-row--${run.status}`;
    row.innerHTML = `
      <div class="run-row__top">
        <span class="run-row__agent"></span>
        <span class="run-row__status"></span>
      </div>
      <div class="run-row__meta"></div>
    `;
    row.querySelector('.run-row__agent').textContent = run.agentId;
    row.querySelector('.run-row__status').textContent = run.status;
    row.querySelector('.run-row__meta').textContent =
      `${elapsedLabel(run.startedAt, run.completedAt)} / ${run.estimatedPromptTokens}t / ${run.permissionMode}`;
    if (run.error) row.title = run.error;
    row.addEventListener('click', () => void openRunDetail(run.id));
    group.appendChild(row);
  }
  target.appendChild(group);
}

function renderActionsPanel(room, target = membersBody) {
  const actions = roomActions.get(room.id) || [];
  const group = commandGroup('actions', actions.length);
  if (actions.length === 0) {
    group.appendChild(emptyCommandText('no action timeline yet'));
    target.appendChild(group);
    return;
  }
  for (const action of actions.slice(0, 9)) {
    const row = document.createElement('div');
    row.className = `action-row action-row--${action.status}`;
    const top = document.createElement('div');
    top.className = 'action-row__top';
    const label = document.createElement('span');
    label.className = 'action-row__label';
    label.textContent = action.label;
    const status = document.createElement('span');
    status.className = 'action-row__status';
    status.textContent = action.status;
    top.append(label, status);
    const meta = document.createElement('div');
    meta.className = 'action-row__meta';
    meta.textContent = `${action.agentId} / ${action.kind} / ${fmtShortTime(action.createdAt)}`;
    row.append(top, meta);
    if (action.detail) {
      const detail = document.createElement('div');
      detail.className = 'action-row__detail';
      detail.textContent = oneLine(action.detail, 180);
      row.appendChild(detail);
    }
    group.appendChild(row);
  }
  target.appendChild(group);
}

function collaborationRank(item) {
  if (item.status === 'blocked') return 0;
  if (item.status === 'open' && item.kind === 'challenge') return 0;
  if (item.status === 'open' && item.kind === 'proposal') return 1;
  if (item.kind === 'decision') return 2;
  if (item.kind === 'evidence') return 3;
  return 4;
}

function renderCollaborationPanel(room, target = membersBody) {
  const items = roomCollaboration.get(room.id) || [];
  const group = commandGroup('alignment', items.length);
  if (items.length === 0) {
    group.appendChild(emptyCommandText('no proposals, challenges, or evidence yet'));
    target.appendChild(group);
    return;
  }

  const visible = [...items]
    .sort((a, b) => collaborationRank(a) - collaborationRank(b) || b.createdAt - a.createdAt)
    .slice(0, 8);
  for (const item of visible) {
    const row = document.createElement('div');
    row.className = `ledger-row ledger-row--${item.kind} ledger-row--${item.status}`;
    const head = document.createElement('div');
    head.className = 'ledger-row__head';
    const kind = document.createElement('span');
    kind.className = 'ledger-row__kind';
    kind.textContent = item.kind;
    const status = document.createElement('span');
    status.className = 'ledger-row__status';
    status.textContent = item.status;
    head.append(kind, status);
    const title = document.createElement('div');
    title.className = 'ledger-row__title';
    title.textContent = item.title;
    const meta = document.createElement('div');
    meta.className = 'ledger-row__meta';
    const confidence = item.confidence ? ` / ${item.confidence}` : '';
    const evidence = item.evidence?.length ? ` / ${item.evidence.length} evidence` : '';
    meta.textContent = `${item.agentId}${confidence}${evidence}`;
    row.append(head, title, meta);
    if (item.target) {
      const targetEl = document.createElement('div');
      targetEl.className = 'ledger-row__target';
      targetEl.textContent = item.target;
      row.appendChild(targetEl);
    }
    if (item.body) {
      const body = document.createElement('div');
      body.className = 'ledger-row__body';
      body.textContent = oneLine(item.body, 220);
      row.appendChild(body);
    }
    group.appendChild(row);
  }
  target.appendChild(group);
}

function metricCell(label, value) {
  const cell = document.createElement('div');
  cell.className = 'run-detail__metric';
  const key = document.createElement('div');
  key.className = 'run-detail__metric-key';
  key.textContent = label;
  const val = document.createElement('div');
  val.className = 'run-detail__metric-value';
  val.textContent = value || 'none';
  cell.append(key, val);
  return cell;
}

function runDetailSection(title, node) {
  const section = document.createElement('section');
  section.className = 'run-detail__section';
  const head = document.createElement('h3');
  head.className = 'run-detail__heading';
  head.textContent = title;
  section.appendChild(head);
  section.appendChild(node);
  return section;
}

function preBlock(text, emptyText = 'empty') {
  const pre = document.createElement('pre');
  pre.className = 'run-detail__pre';
  pre.textContent = text && text.length > 0 ? text : emptyText;
  return pre;
}

function messageExcerpt(message, emptyText) {
  const wrap = document.createElement('div');
  wrap.className = 'run-detail__message';
  if (!message) {
    wrap.textContent = emptyText;
    return wrap;
  }
  const meta = document.createElement('div');
  meta.className = 'run-detail__message-meta';
  meta.textContent = `${message.authorId} / ${message.authorKind} / ${fmtDateTime(message.createdAt)}`;
  const body = document.createElement('div');
  body.className = 'run-detail__message-body';
  body.textContent = oneLine(message.text, 900);
  wrap.append(meta, body);
  return wrap;
}

function renderRunSignals(diagnostics) {
  const signals = diagnostics?.signals || [];
  if (signals.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'run-detail__empty';
    empty.textContent = 'no structured CLI events detected';
    return empty;
  }
  const list = document.createElement('div');
  list.className = 'run-detail__signals';
  for (const signal of signals) {
    const row = document.createElement('div');
    row.className = `run-detail__signal run-detail__signal--${signal.kind}`;
    const label = document.createElement('div');
    label.className = 'run-detail__signal-label';
    label.textContent = signal.label;
    const detail = document.createElement('div');
    detail.className = 'run-detail__signal-detail';
    detail.textContent = signal.detail || signal.kind;
    row.append(label, detail);
    list.appendChild(row);
  }
  return list;
}

function renderRunActions(actions) {
  if (!actions || actions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'run-detail__empty';
    empty.textContent = 'no action timeline recorded';
    return empty;
  }
  const list = document.createElement('div');
  list.className = 'run-detail__signals';
  for (const action of actions) {
    const row = document.createElement('div');
    row.className = `run-detail__signal run-detail__signal--${action.status}`;
    const label = document.createElement('div');
    label.className = 'run-detail__signal-label';
    label.textContent = `${fmtShortTime(action.createdAt)} / ${action.kind} / ${action.label}`;
    const detail = document.createElement('div');
    detail.className = 'run-detail__signal-detail';
    detail.textContent = action.detail || action.status;
    row.append(label, detail);
    list.appendChild(row);
  }
  return list;
}

function renderRunDetail(detail) {
  const run = detail.run;
  openRunDetailId = run.id;
  runModalTitle.textContent = `${run.agentId} run`;
  runModalSub.textContent =
    `${run.status} / ${elapsedLabel(run.startedAt, run.completedAt)} / ${run.estimatedPromptTokens}t / ${run.permissionMode}`;
  runModalBody.innerHTML = '';

  const metrics = document.createElement('div');
  metrics.className = 'run-detail__grid';
  metrics.append(
    metricCell('status', run.status),
    metricCell('agent', run.agentId),
    metricCell('started', fmtDateTime(run.startedAt)),
    metricCell('completed', run.completedAt ? fmtDateTime(run.completedAt) : 'running'),
    metricCell('duration', elapsedLabel(run.startedAt, run.completedAt)),
    metricCell('permission', run.permissionMode),
    metricCell('prompt', `${run.promptChars} chars / ${run.estimatedPromptTokens} tokens`),
    metricCell('live context', `${run.liveMessages} messages / ${run.contextArtifacts} artifacts`),
    metricCell('session', run.cliSessionId || 'none'),
    metricCell('task', run.taskId || 'none'),
  );
  runModalBody.appendChild(metrics);

  if (
    run.permissionSource ||
    run.permissionTarget ||
    run.permissionReason ||
    run.permissionFilesystemScope ||
    run.permissionWeb
  ) {
    const permission = document.createElement('div');
    permission.className = 'run-detail__kv';
    [
      ['source', run.permissionSource],
      ['target', run.permissionTarget],
      ['target status', targetStatusText(run)],
      ['capabilities', capabilityText(run.permissionCapabilities)],
      ['provider', run.permissionProviderProfile],
      ['scope', run.permissionFilesystemScope],
      ['web', run.permissionWeb ? 'requested' : 'not requested'],
      ['reason', run.permissionReason],
    ].forEach(([key, value]) => {
      if (!value) return;
      permission.appendChild(metricCell(key, value));
    });
    runModalBody.appendChild(runDetailSection('permission', permission));
  }

  runModalBody.appendChild(
    runDetailSection('trigger', messageExcerpt(detail.triggerMessage, 'trigger message unavailable')),
  );
  runModalBody.appendChild(
    runDetailSection(
      run.error ? 'error' : 'reply',
      run.error
        ? preBlock(run.error)
        : messageExcerpt(detail.replyMessage, run.replyText || 'no visible reply'),
    ),
  );
  runModalBody.appendChild(runDetailSection('signals', renderRunSignals(detail.diagnostics)));
  runModalBody.appendChild(runDetailSection('timeline', renderRunActions(detail.actions)));
  runModalBody.appendChild(runDetailSection('prompt', preBlock(run.promptText, 'prompt not stored')));
  runModalBody.appendChild(runDetailSection('stdout', preBlock(run.stdout)));
  runModalBody.appendChild(runDetailSection('stderr', preBlock(run.stderr)));
}

async function openRunDetail(runId) {
  if (!currentRoomId) return;
  openRunDetailId = runId;
  runModal.hidden = false;
  runModalTitle.textContent = 'agent run';
  runModalSub.textContent = '';
  runModalBody.innerHTML = '';
  runModalBody.appendChild(emptyCommandText('loading run'));
  try {
    const detail = await fetch(`/api/rooms/${currentRoomId}/runs/${runId}`).then((r) => {
      if (!r.ok) throw new Error(`run detail failed: ${r.status}`);
      return r.json();
    });
    if (openRunDetailId === runId) renderRunDetail(detail);
  } catch (err) {
    runModalBody.innerHTML = '';
    runModalBody.appendChild(preBlock(err instanceof Error ? err.message : String(err), 'failed'));
  }
}

function closeRunModal() {
  runModal.hidden = true;
  openRunDetailId = null;
}

function renderArtifactsPanel(room, target = membersBody) {
  const listing = roomArtifacts.get(room.id);
  const files = listing?.files || [];
  const group = commandGroup('artifacts', files.length);
  if (files.length === 0) {
    group.appendChild(emptyCommandText('no context artifacts yet'));
    target.appendChild(group);
    return;
  }
  for (const file of files.slice(0, 7)) {
    const row = document.createElement('div');
    row.className = `artifact-row artifact-row--${file.kind}`;
    const head = document.createElement('div');
    head.className = 'artifact-row__head';
    const name = document.createElement('div');
    name.className = 'artifact-row__name';
    name.textContent = file.kind;
    head.appendChild(name);
    if (canRemoveArtifact(file)) head.appendChild(artifactRemoveButton(room.id, file));
    const pathEl = document.createElement('div');
    pathEl.className = 'artifact-row__path';
    pathEl.textContent = file.path;
    const meta = document.createElement('div');
    meta.className = 'artifact-row__meta';
    meta.textContent = `${fmtBytes(file.size)} / ${fmtShortTime(file.updatedAt)}`;
    row.appendChild(head);
    row.appendChild(pathEl);
    row.appendChild(meta);
    group.appendChild(row);
  }
  target.appendChild(group);
}

function renderMembers() {
  presenceBody.innerHTML = '';
  membersBody.innerHTML = '';
  const room = rooms.find((r) => r.id === currentRoomId);
  if (!room) {
    const empty = document.createElement('div');
    empty.className = 'members__empty';
    empty.textContent = 'no room selected';
    presenceBody.appendChild(empty.cloneNode(true));
    membersBody.appendChild(empty);
    return;
  }

  const peopleColumn = document.createElement('div');
  peopleColumn.className = 'members__column members__column--status';
  const contextColumn = document.createElement('div');
  contextColumn.className = 'members__column members__column--context';
  const missionColumn = document.createElement('div');
  missionColumn.className = 'members__column members__column--mission';

  /* agents section */
  const agentsGroup = document.createElement('section');
  agentsGroup.className = 'members__group';
  const agentsHead = document.createElement('header');
  agentsHead.className = 'members__group-head members__group-head--clickable';
  agentsHead.setAttribute('role', 'button');
  agentsHead.setAttribute('tabindex', '0');
  agentsHead.setAttribute('aria-label', 'edit agents in this room');
  agentsHead.innerHTML = `
    <span>agents <span class="members__group-head__edit">edit</span></span>
    <span class="members__group-head__count">${room.agents.length}</span>
  `;
  agentsHead.addEventListener('click', () => openEditAgentsModal());
  agentsHead.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openEditAgentsModal();
    }
  });
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
  peopleColumn.appendChild(agentsGroup);

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
  peopleColumn.appendChild(humansGroup);

  renderActiveWorkPanel(room, peopleColumn);
  renderArtifactsPanel(room, contextColumn);
  renderRunsPanel(room, contextColumn);
  renderTaskPanel(room, missionColumn);
  renderControlPanel(room, missionColumn);
  renderCollaborationPanel(room, missionColumn);

  presenceBody.appendChild(peopleColumn);
  membersBody.appendChild(contextColumn);
  membersBody.appendChild(missionColumn);
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

function isHiddenSystemMessage(text) {
  return (
    /^Permission (approved|denied) for /i.test(text) ||
    /^\([a-z]+ started approved /i.test(text) ||
    /^\([a-z]+ finished the .* follow-up without a visible chat message\.\)$/i.test(text)
  );
}

function appendMessage(msg) {
  const hideFromChat = msg.authorKind === 'system' && isHiddenSystemMessage(msg.text);
  // Drop empty-state on first real message
  if (!hideFromChat) {
    const empty = messageList.querySelector('.empty-state');
    if (empty) empty.remove();
  }

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
      } else if (isHiddenSystemMessage(msg.text)) {
        // Permission lifecycle notices are represented by permission cards
        // and run actions; do not clear active spinners for them.
      } else {
        // Unknown system message — clear all to avoid sticky spinners.
        thinking.clear();
      }
      renderMembers();
    }
  }

  const li = document.createElement('li');
  li.className = 'msg';

  if (hideFromChat) return;

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

function permissionModeLabel(mode) {
  if (mode === 'full-auto') return 'full auto';
  if (mode === 'edit') return 'edit/write';
  return 'read-only';
}

function permissionRequestLabel(req) {
  if (req.requestedMode && req.requestedMode !== req.mode) {
    if (['bash', 'shell', 'command', 'run-command', 'git', 'commit', 'git-commit'].includes(req.requestedMode)) {
      return `${req.requestedMode} command`;
    }
    return `${req.requestedMode} (${permissionModeLabel(req.mode)})`;
  }
  return permissionModeLabel(req.mode);
}

function capabilityText(capabilities) {
  return Array.isArray(capabilities) && capabilities.length > 0
    ? capabilities.join(', ')
    : 'none';
}

function targetStatusText(item) {
  const kind = item.targetKind || item.permissionTargetKind || 'unknown';
  const exists =
    'targetExists' in item ? item.targetExists : item.permissionTargetExists;
  if (exists === true) return `exists (${kind})`;
  if (exists === false) return `missing (${kind})`;
  return kind;
}

function permissionFact(label, value) {
  const row = document.createElement('div');
  row.className = 'permission-card__fact';
  const key = document.createElement('span');
  key.className = 'permission-card__fact-key';
  key.textContent = label;
  const val = document.createElement('span');
  val.className = 'permission-card__fact-value';
  val.textContent = value || 'none';
  row.append(key, val);
  return row;
}

function appendPermissionRequest(req) {
  permissionRequests.set(req.id, req);
  if (req.roomId !== currentRoomId) return;

  const existing = messageList.querySelector(`[data-permission-request-id="${req.id}"]`);
  if (existing) existing.remove();

  const empty = messageList.querySelector('.empty-state');
  if (empty) empty.remove();

  thinking.delete(req.agentId);
  renderMembers();

  const li = document.createElement('li');
  li.className = `msg permission-request permission-request--${req.status}`;
  li.dataset.permissionRequestId = req.id;
  li.appendChild(avatarFor('agent', req.agentId));

  const card = document.createElement('div');
  card.className = 'permission-card';

  const head = document.createElement('div');
  head.className = 'permission-card__head';

  const title = document.createElement('div');
  title.className = 'permission-card__title';
  title.textContent = `${req.agentId} requests ${permissionRequestLabel(req)} permission`;
  head.appendChild(title);

  const status = document.createElement('span');
  status.className = `permission-card__status permission-card__status--${req.status}`;
  status.textContent = req.status;
  head.appendChild(status);
  card.appendChild(head);

  const target = document.createElement('div');
  target.className = 'permission-card__target';
  target.textContent = req.target;
  card.appendChild(target);

  const reason = document.createElement('div');
  reason.className = 'permission-card__reason';
  reason.textContent = req.reason;
  card.appendChild(reason);

  const facts = document.createElement('div');
  facts.className = 'permission-card__facts';
  facts.appendChild(permissionFact('effective', capabilityText(req.capabilities)));
  facts.appendChild(permissionFact('target', targetStatusText(req)));
  if (req.providerProfile) facts.appendChild(permissionFact('provider', req.providerProfile));
  if (req.requestedMode && req.requestedMode !== req.mode) {
    facts.appendChild(permissionFact('normalized from', req.requestedMode));
  }
  card.appendChild(facts);

  const foot = document.createElement('div');
  foot.className = 'permission-card__foot';
  if (req.status === 'pending') {
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'permission-card__btn permission-card__btn--deny';
    deny.textContent = 'Deny';
    deny.addEventListener('click', () => decidePermissionRequest(req, 'denied'));

    const allow = document.createElement('button');
    allow.type = 'button';
    allow.className = 'permission-card__btn permission-card__btn--allow';
    allow.textContent = 'Allow';
    allow.addEventListener('click', () => decidePermissionRequest(req, 'approved'));

    foot.appendChild(deny);
    foot.appendChild(allow);
  } else {
    const decided = document.createElement('span');
    decided.className = 'permission-card__decided';
    const by = req.decidedBy ? ` by ${req.decidedBy}` : '';
    decided.textContent = `${req.status}${by}`;
    foot.appendChild(decided);
  }
  card.appendChild(foot);

  li.appendChild(card);
  messageList.appendChild(li);
  lastMessageAuthor = null;
  scrollToBottom();
}

async function decidePermissionRequest(req, decision) {
  const card = messageList.querySelector(`[data-permission-request-id="${req.id}"]`);
  card?.querySelectorAll('button').forEach((button) => {
    button.disabled = true;
  });

  try {
    const response = await fetch(
      `/api/rooms/${req.roomId}/permission-requests/${req.id}/decision`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          decidedBy: authorInput.value || 'human',
        }),
      },
    );
    if (!response.ok) throw new Error(`permission decision failed: ${response.status}`);
    const updated = await response.json();
    appendPermissionRequest(updated);
  } catch (err) {
    card?.querySelectorAll('button').forEach((button) => {
      button.disabled = false;
    });
  }
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

attachFileBtn.addEventListener('click', async () => {
  if (!currentRoomId) return;
  const roomId = currentRoomId;
  const activeTask = activeTaskFor(roomId);
  const initialPath =
    activeTask?.repoPath || localStorage.getItem('fireside.lastFileDirectory') || '';
  const sourcePath = await browseForFile({ initialPath, button: attachFileBtn });
  if (!sourcePath) return;
  localStorage.setItem('fireside.lastFileDirectory', dirnameFromPath(sourcePath));
  attachFileBtn.disabled = true;
  attachFileBtn.title = 'Attaching file';
  try {
    const fixture = await attachFileFixture(roomId, sourcePath);
    if (currentRoomId === roomId) {
      insertComposerReference(`@file("${fixture.storedPath}")`);
      await refreshArtifacts(roomId);
    }
  } catch {
    attachFileBtn.title = 'Attach failed';
    setTimeout(() => {
      attachFileBtn.title = 'Attach file';
    }, 1200);
  } finally {
    attachFileBtn.disabled = false;
    if (attachFileBtn.title === 'Attaching file') attachFileBtn.title = 'Attach file';
  }
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

setAuthor(localStorage.getItem('fireside.author') || 'human');
authorInput.addEventListener('input', () => setAuthor(authorInput.value));
authorInput.addEventListener('blur', () => {
  if (!authorInput.value.trim()) setAuthor('human');
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
  if (e.key === 'Escape') {
    if (!modal.hidden) closeModal();
    if (!deleteModal.hidden) closeDeleteModal();
    if (!editAgentsModal.hidden) closeEditAgentsModal();
    if (!runModal.hidden) closeRunModal();
  }
});

/* ---------- modal: delete room ---------- */

let pendingDeleteRoomId = null;

function promptDeleteRoom(roomId) {
  const room = rooms.find((r) => r.id === roomId);
  if (!room) return;
  pendingDeleteRoomId = roomId;
  deleteRoomNameEl.textContent = '#' + room.name;
  deleteModal.hidden = false;
  // Focus the cancel button so Enter doesn't accidentally fire the danger action.
  const cancel = deleteModal.querySelector('[data-close]');
  if (cancel instanceof HTMLElement) cancel.focus();
}

function closeDeleteModal() {
  deleteModal.hidden = true;
  pendingDeleteRoomId = null;
}

deleteModal.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.matches('[data-close]')) closeDeleteModal();
});

deleteConfirmBtn.addEventListener('click', async () => {
  if (!pendingDeleteRoomId) return;
  const roomId = pendingDeleteRoomId;
  deleteConfirmBtn.disabled = true;
  deleteConfirmBtn.textContent = 'erasing…';
  try {
    const r = await fetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new Error(`delete failed: ${r.status}`);
    // The WS roomDeleted event will reconcile state. Close the modal now.
    closeDeleteModal();
  } catch (err) {
    deleteConfirmBtn.textContent = 'try again';
    deleteConfirmBtn.disabled = false;
    return;
  }
  deleteConfirmBtn.disabled = false;
  deleteConfirmBtn.textContent = 'erase it';
});

/* ---------- modal: edit agents ---------- */

function openEditAgentsModal() {
  const room = rooms.find((r) => r.id === currentRoomId);
  if (!room) return;
  editAgentsRoomEl.textContent = '#' + room.name;
  // Set checkbox state from current room agents.
  $$('#edit-agents-form input[name="edit-agent"]').forEach((el) => {
    el.checked = room.agents.includes(el.value);
  });
  editAgentsModal.hidden = false;
  // Focus first checkbox for keyboard accessibility.
  const first = editAgentsModal.querySelector('input[type="checkbox"]');
  if (first instanceof HTMLElement) first.focus();
}

function closeEditAgentsModal() {
  editAgentsModal.hidden = true;
}

editAgentsModal.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.matches('[data-close]')) closeEditAgentsModal();
});

runModal.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.matches('[data-close]')) closeRunModal();
});

editAgentsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentRoomId) return;
  const agents = Array.from($$('#edit-agents-form input[name="edit-agent"]:checked')).map(
    (el) => el.value,
  );
  const submitBtn = editAgentsForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'saving…';
  try {
    const r = await fetch(`/api/rooms/${currentRoomId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents }),
    });
    if (!r.ok) throw new Error(`PATCH failed: ${r.status}`);
    closeEditAgentsModal();
    // The roomUpdated WS event will reconcile state — but if the WS round-trip
    // is sluggish, refresh local rooms now so the panel reflects it immediately.
    const updatedRoom = await r.json();
    rooms = rooms.map((rm) => (rm.id === updatedRoom.id ? updatedRoom : rm));
    renderRoomList();
    renderChannelHeader(updatedRoom);
    // Drop any thinking spinners for agents that were just removed.
    for (const id of [...thinking]) {
      if (!updatedRoom.agents.includes(id)) thinking.delete(id);
    }
    renderMembers();
  } catch (err) {
    submitBtn.textContent = 'try again';
  } finally {
    submitBtn.disabled = false;
    if (submitBtn.textContent === 'saving…') submitBtn.textContent = 'save';
  }
});

function handleRoomUpdated(room) {
  rooms = rooms.map((rm) => (rm.id === room.id ? room : rm));
  renderRoomList();
  if (currentRoomId === room.id) {
    renderChannelHeader(room);
    // If an agent was removed mid-thinking, drop them from the spinner set.
    for (const id of [...thinking]) {
      if (!room.agents.includes(id)) thinking.delete(id);
    }
    renderMembers();
  }
}

function handleRoomDeleted(roomId) {
  rooms = rooms.filter((r) => r.id !== roomId);
  roomHumans.delete(roomId);
  roomTasks.delete(roomId);
  roomRuns.delete(roomId);
  roomArtifacts.delete(roomId);
  roomCollaboration.delete(roomId);
  roomActions.delete(roomId);
  roomYolo.delete(roomId);
  for (const [id, request] of permissionRequests.entries()) {
    if (request.roomId === roomId) permissionRequests.delete(id);
  }
  if (currentRoomId === roomId) {
    currentRoomId = null;
    if (rooms.length > 0) {
      selectRoom(rooms[0].id);
    } else {
      messageList.innerHTML = '';
      lastMessageAuthor = null;
      renderChannelHeader(null);
      renderMembers();
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.innerHTML = `
        <p class="empty-state__title">no rooms left</p>
        <p class="empty-state__sub">create a new one to start a conversation.</p>
      `;
      messageList.appendChild(empty);
    }
  }
  renderRoomList();
}

function handlePermissionRequestCreated(request) {
  permissionRequests.set(request.id, request);
  if (request.roomId === currentRoomId) appendPermissionRequest(request);
}

function handlePermissionRequestUpdated(request) {
  permissionRequests.set(request.id, request);
  if (request.roomId !== currentRoomId) return;
  appendPermissionRequest(request);
  thinking.add(request.agentId);
  renderMembers();
}

async function refreshArtifacts(roomId) {
  try {
    const artifacts = await fetch(`/api/rooms/${roomId}/artifacts`).then((r) => r.json());
    roomArtifacts.set(roomId, artifacts);
    if (roomId === currentRoomId) renderMembers();
  } catch {
    /* artifact refresh is best-effort */
  }
}

function handleTaskUpdated(task) {
  roomTasks.set(task.roomId, upsertById(roomTasks.get(task.roomId) || [], task));
  if (task.roomId === currentRoomId) renderMembers();
}

function handleAgentRunUpdated(run) {
  roomRuns.set(run.roomId, upsertById(roomRuns.get(run.roomId) || [], run));
  if (run.status === 'running') thinking.add(run.agentId);
  else thinking.delete(run.agentId);
  if (run.roomId === currentRoomId) {
    renderMembers();
    if (run.status !== 'running') void refreshArtifacts(run.roomId);
    if (!runModal.hidden && openRunDetailId === run.id && run.status !== 'running') {
      void openRunDetail(run.id);
    }
  }
}

function handleCollaborationItemCreated(item) {
  roomCollaboration.set(item.roomId, upsertById(roomCollaboration.get(item.roomId) || [], item));
  if (item.roomId === currentRoomId) renderMembers();
}

function handleAgentRunActionCreated(action) {
  roomActions.set(action.roomId, upsertById(roomActions.get(action.roomId) || [], action));
  if (action.roomId === currentRoomId) {
    renderMembers();
    if (!runModal.hidden && openRunDetailId === action.runId) {
      void openRunDetail(action.runId);
    }
  }
}

function handleYoloStatusUpdated(status) {
  roomYolo.set(status.roomId, status);
  if (status.roomId === currentRoomId) renderMembers();
}

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
    } else if (evt.type === 'roomDeleted') {
      handleRoomDeleted(evt.roomId);
    } else if (evt.type === 'roomUpdated') {
      handleRoomUpdated(evt.room);
    } else if (evt.type === 'permissionRequestCreated') {
      handlePermissionRequestCreated(evt.request);
    } else if (evt.type === 'permissionRequestUpdated') {
      handlePermissionRequestUpdated(evt.request);
    } else if (evt.type === 'taskUpdated') {
      handleTaskUpdated(evt.task);
    } else if (evt.type === 'agentRunUpdated') {
      handleAgentRunUpdated(evt.run);
    } else if (evt.type === 'collaborationItemCreated') {
      handleCollaborationItemCreated(evt.item);
    } else if (evt.type === 'agentRunActionCreated') {
      handleAgentRunActionCreated(evt.action);
    } else if (evt.type === 'yoloStatusUpdated') {
      handleYoloStatusUpdated(evt.status);
    } else if (evt.type === 'artifactsUpdated' && evt.roomId === currentRoomId) {
      void refreshArtifacts(evt.roomId);
    }
  });
  ws.addEventListener('close', () => setTimeout(connectWs, 1000));
  ws.addEventListener('error', () => {
    /* error fires before close; close handler reconnects */
  });
}

/* ---------- boot ---------- */

setInterval(updateLiveTimers, 1000);
connectWs();
loadRooms();
