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
const btnBackup = document.getElementById('btn-backup');
const btnRestore = document.getElementById('btn-restore');
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
    `RAM: ${esc(String(Math.round(parseInt(info.maxRam) / 1024)))} GB`,
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

let hasBackup = false;

function refreshBackupState() {
  socket.emit('has-backup', { serverId }, (res) => {
    if (res && res.ok) {
      hasBackup = res.exists;
      btnRestore.disabled = !hasBackup;
    }
  });
}

refreshBackupState();

btnBackup.onclick = () => {
  if (hasBackup && !confirm('An existing backup will be overwritten. Continue?')) return;
  btnBackup.disabled = true;
  const originalText = btnBackup.textContent;
  btnBackup.textContent = 'Backing up...';
  socket.emit('backup-server', { serverId }, (r) => {
    btnBackup.disabled = false;
    btnBackup.textContent = originalText;
    if (r.ok) {
      hasBackup = true;
      btnRestore.disabled = false;
      const mb = (r.size / (1024 * 1024)).toFixed(1);
      alert(`Backup complete (${mb} MB).`);
    } else {
      alert('Backup failed: ' + r.error);
    }
  });
};

btnRestore.onclick = () => {
  if (btnRestore.disabled) return;
  if (!confirm('Restore will overwrite the current world with the backup. Continue?')) return;
  btnRestore.disabled = true;
  btnBackup.disabled = true;
  const originalText = btnRestore.textContent;
  btnRestore.textContent = 'Restoring...';
  socket.emit('restore-backup', { serverId }, (r) => {
    btnRestore.textContent = originalText;
    btnRestore.disabled = !hasBackup;
    btnBackup.disabled = false;
    if (r.ok) {
      alert('Restore complete.');
    } else {
      alert('Restore failed: ' + r.error);
    }
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
  const clampedRam = Math.max(1, Math.min(10, ramGB));
  ramSelect.value = String(clampedRam);
}

// --- Mods Modal ---
const modsModalOverlay = document.getElementById('mods-modal-overlay');
const modList = document.getElementById('mod-list');
const modError = document.getElementById('mod-error');
const modUploadBtn = document.getElementById('mod-upload-btn');
const modUploadStatus = document.getElementById('mod-upload-status');
const modFilesInput = document.getElementById('mod-files');

document.getElementById('btn-mods').onclick = openModsModal;
document.getElementById('close-mods-modal').onclick = closeModsModal;
modsModalOverlay.onclick = (e) => { if (e.target === modsModalOverlay) closeModsModal(); };

function openModsModal() {
  modError.textContent = '';
  modUploadStatus.textContent = '';
  modFilesInput.value = '';
  modsModalOverlay.classList.add('active');
  refreshModList();
}

function closeModsModal() {
  modsModalOverlay.classList.remove('active');
}

function refreshModList() {
  modList.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">Loading...</p>';
  socket.emit('list-server-mods', { serverId }, (res) => {
    if (!res.ok) { modList.innerHTML = ''; modError.textContent = res.error; return; }
    if (res.mods.length === 0) {
      modList.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">No mods installed.</p>';
      return;
    }
    modList.innerHTML = res.mods.map(m => `
      <div class="mod-list-row">
        <span class="mod-list-name">${esc(m)}</span>
        <button class="btn btn-danger btn-sm delete-mod-btn" data-filename="${esc(m)}">Delete</button>
      </div>
    `).join('');
    modList.querySelectorAll('.delete-mod-btn').forEach(btn => {
      btn.onclick = () => deleteMod(btn.dataset.filename, btn);
    });
  });
}

function deleteMod(filename, btn) {
  if (!confirm(`Delete mod "${filename}"?`)) return;
  btn.disabled = true;
  socket.emit('delete-server-mod', { serverId, filename }, (res) => {
    if (res.ok) {
      refreshModList();
    } else {
      modError.textContent = res.error;
      btn.disabled = false;
    }
  });
}

modUploadBtn.onclick = async () => {
  const files = modFilesInput.files;
  if (!files || files.length === 0) { modError.textContent = 'Select at least one .jar file'; return; }
  modError.textContent = '';
  modUploadBtn.disabled = true;

  let uploaded = 0;
  for (const file of files) {
    if (!file.name.endsWith('.jar')) {
      modError.textContent = `Skipped "${file.name}" — only .jar files allowed`;
      continue;
    }
    modUploadStatus.textContent = `Uploading ${uploaded + 1}/${files.length}...`;
    try {
      const res = await fetch(`/api/upload-mods?type=server&id=${encodeURIComponent(serverId)}&filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: file,
      });
      const data = await res.json();
      if (!data.ok) {
        modError.textContent = `Failed "${file.name}": ${data.error}`;
        break;
      }
      uploaded++;
    } catch (err) {
      modError.textContent = `Upload failed: ${err.message}`;
      break;
    }
  }

  modUploadBtn.disabled = false;
  modUploadStatus.textContent = uploaded > 0 ? `${uploaded} mod(s) uploaded` : '';
  modFilesInput.value = '';
  refreshModList();
};

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
