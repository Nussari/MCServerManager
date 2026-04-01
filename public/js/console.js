const socket = io();
const params = new URLSearchParams(window.location.search);
const serverId = params.get('id');

if (!serverId) {
  window.location.href = '/';
}

const nameEl = document.getElementById('server-name');
const badgeEl = document.getElementById('status-badge');
const infoEl = document.getElementById('server-info');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnEdit = document.getElementById('btn-edit');
const consoleOutput = document.getElementById('console-output');
const commandInput = document.getElementById('command-input');
const sendBtn = document.getElementById('send-btn');
const scrollBtn = document.getElementById('scroll-btn');

let autoScroll = true;
let currentStatus = 'stopped';

socket.emit('join-server', { serverId });

socket.on('status-change', (info) => {
  currentStatus = info.status;
  nameEl.textContent = info.name;
  document.title = `${info.name} - MC Manager`;

  badgeEl.textContent = info.status;
  badgeEl.className = `status-badge ${info.status}`;

  infoEl.innerHTML = [
    `Port: ${esc(String(info.port))}`,
    `Template: ${esc(info.templateName)}`,
    `RAM: ${esc(info.minRam)} / ${esc(info.maxRam)}`,
    info.status === 'running' ? `Players: ${esc(String(info.playerCount))}` : null,
    info.startedAt ? `Started: ${esc(new Date(info.startedAt).toLocaleTimeString())}` : null,
  ].filter(Boolean).map(t => `<span>${t}</span>`).join('');

  updateButtons();
});

socket.on('output-history', (lines) => {
  consoleOutput.innerHTML = '';
  for (const entry of lines) appendLine(entry);
  scrollToBottom();
});

socket.on('output', (entry) => {
  appendLine(entry);
  if (autoScroll) scrollToBottom();
});

function appendLine({ line, stream, timestamp }) {
  const div = document.createElement('div');
  div.className = `console-line ${stream}`;

  const ts = document.createElement('span');
  ts.className = 'timestamp';
  ts.textContent = new Date(timestamp).toLocaleTimeString();

  div.appendChild(ts);
  div.appendChild(document.createTextNode(line));
  consoleOutput.appendChild(div);

  while (consoleOutput.children.length > 1000) {
    consoleOutput.removeChild(consoleOutput.firstChild);
  }
}

consoleOutput.addEventListener('scroll', () => {
  const threshold = 50;
  const atBottom = consoleOutput.scrollHeight - consoleOutput.scrollTop - consoleOutput.clientHeight < threshold;
  autoScroll = atBottom;
  scrollBtn.classList.toggle('visible', !atBottom);
});

scrollBtn.onclick = () => {
  scrollToBottom();
  autoScroll = true;
  scrollBtn.classList.remove('visible');
};

function scrollToBottom() {
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function sendCommand() {
  const cmd = commandInput.value.trim();
  if (!cmd) return;
  socket.emit('send-command', { serverId, command: cmd });
  commandInput.value = '';
}

commandInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendCommand();
});

sendBtn.onclick = sendCommand;

btnStart.onclick = () => {
  btnStart.disabled = true;
  socket.emit('start-server', { serverId }, (res) => {
    btnStart.disabled = false;
    if (!res.ok) alert('Failed to start: ' + res.error);
  });
};

btnStop.onclick = () => {
  if (!confirm('Stop this server?')) return;
  btnStop.disabled = true;
  socket.emit('stop-server', { serverId }, (res) => {
    btnStop.disabled = false;
    if (!res.ok) alert('Failed to stop: ' + res.error);
  });
};


function updateButtons() {
  const isRunning = currentStatus === 'running';
  const isStopped = currentStatus === 'stopped' || currentStatus === 'crashed';

  btnStart.style.display = isStopped ? '' : 'none';
  btnStop.style.display = isRunning ? '' : 'none';
  commandInput.disabled = !isRunning;
  sendBtn.disabled = !isRunning;
}

// --- Edit Modal ---
const editModalOverlay = document.getElementById('edit-modal-overlay');
const editForm = document.getElementById('edit-server-form');
const editFormError = document.getElementById('edit-form-error');

btnEdit.onclick = () => {
  socket.emit('get-server-settings', { serverId }, (res) => {
    if (!res.ok) { alert('Failed to load settings: ' + res.error); return; }
    populateEditForm(res.settings);
    editFormError.textContent = '';
    editModalOverlay.classList.add('active');
  });
};

document.getElementById('cancel-edit').onclick = closeEditModal;

document.getElementById('btn-delete').onclick = () => {
  if (!confirm('Delete this server? This will remove all server files.')) return;
  socket.emit('delete-server', { serverId }, (res) => {
    if (res.ok) {
      window.location.href = '/';
    } else {
      alert('Failed to delete: ' + res.error);
    }
  });
};
editModalOverlay.onclick = (e) => { if (e.target === editModalOverlay) closeEditModal(); };

function closeEditModal() {
  editModalOverlay.classList.remove('active');
}

function populateEditForm(s) {
  document.getElementById('edit-name').value = s.name;
  document.getElementById('edit-motd').value = s.motd;
  document.getElementById('edit-difficulty').value = s.difficulty;
  document.getElementById('edit-gamemode').value = s.gamemode;
  document.getElementById('edit-hardcore').checked = s.hardcore;
  document.getElementById('edit-pvp').checked = s.pvp;
  document.getElementById('edit-port').value = s.port;
  document.getElementById('edit-maxplayers').value = s.maxPlayers;
  document.getElementById('edit-viewdist').value = s.viewDistance;
  document.getElementById('edit-simdist').value = s.simulationDistance;
  document.getElementById('edit-whitelist').checked = s.whitelist;

  // Parse maxRam to GB for dropdown (e.g. "4096M" -> 4)
  const ramMatch = s.maxRam.match(/^(\d+)M$/);
  const ramGB = ramMatch ? Math.round(parseInt(ramMatch[1]) / 1024) : 1;
  const ramSelect = document.getElementById('edit-maxram');
  const clampedRam = Math.max(1, Math.min(8, ramGB));
  ramSelect.value = String(clampedRam);
}

editForm.onsubmit = (e) => {
  e.preventDefault();
  editFormError.textContent = '';

  const ramValue = document.getElementById('edit-maxram').value;
  const data = {
    serverId,
    name: document.getElementById('edit-name').value.trim(),
    motd: document.getElementById('edit-motd').value,
    difficulty: document.getElementById('edit-difficulty').value,
    gamemode: document.getElementById('edit-gamemode').value,
    hardcore: document.getElementById('edit-hardcore').checked,
    maxRam: `${parseInt(ramValue) * 1024}M`,
    pvp: document.getElementById('edit-pvp').checked,
    port: document.getElementById('edit-port').value,
    maxPlayers: document.getElementById('edit-maxplayers').value || undefined,
    viewDistance: document.getElementById('edit-viewdist').value || undefined,
    simulationDistance: document.getElementById('edit-simdist').value || undefined,
    whitelist: document.getElementById('edit-whitelist').checked,
  };

  if (!data.name) { editFormError.textContent = 'Name is required'; return; }

  socket.emit('update-server', data, async (res) => {
    if (res.ok) {
      // Upload icon if selected
      const iconInput = document.getElementById('edit-icon');
      if (iconInput.files[0]) {
        const buf = await iconInput.files[0].arrayBuffer();
        socket.emit('upload-server-icon', { serverId, imageData: buf }, () => {});
      }
      closeEditModal();
    } else {
      editFormError.textContent = res.error;
    }
  });
};
