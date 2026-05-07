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
const menuBackup = document.getElementById('files-menu-backup');
const menuRestore = document.getElementById('files-menu-restore');
const menuDownloadWorld = document.getElementById('files-menu-download-world');
const backupInfoEl = document.getElementById('backup-info');
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

function formatBackupSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function refreshBackupState() {
  socket.emit('has-backup', { serverId }, (res) => {
    if (!res || !res.ok) return;
    hasBackup = res.exists;
    menuRestore.disabled = !hasBackup;
    if (hasBackup) {
      const when = new Date(res.createdAt).toLocaleString();
      backupInfoEl.textContent = `Backup: ${formatBackupSize(res.size)} · ${when}`;
    } else {
      backupInfoEl.textContent = 'No backup';
    }
  });
}

refreshBackupState();

function backupWorld() {
  if (hasBackup && !confirm('An existing backup will be overwritten. Continue?')) return;
  menuBackup.disabled = true;
  showToast('Backing up world...');
  socket.emit('backup-server', { serverId }, (r) => {
    menuBackup.disabled = false;
    if (r.ok) {
      hasBackup = true;
      menuRestore.disabled = false;
      refreshBackupState();
      showToast(`Backup complete (${formatBackupSize(r.size)})`);
    } else {
      showToast('Backup failed: ' + r.error, 'error');
    }
  });
}

function restoreWorld() {
  if (menuRestore.disabled) return;
  if (!confirm('Restore will overwrite the current world with the backup. Continue?')) return;
  menuRestore.disabled = true;
  menuBackup.disabled = true;
  showToast('Restoring world...');
  socket.emit('restore-backup', { serverId }, (r) => {
    menuRestore.disabled = !hasBackup;
    menuBackup.disabled = false;
    if (r.ok) {
      showToast('Restore complete');
    } else {
      showToast('Restore failed: ' + r.error, 'error');
    }
  });
}

function downloadWorld() {
  socket.emit('check-world-download', { serverId }, (r) => {
    if (!r || !r.ok) {
      showToast('Cannot download: ' + (r && r.error ? r.error : 'unknown error'), 'error');
      return;
    }
    showToast('Preparing world ZIP — your download will start shortly');
    const a = document.createElement('a');
    a.href = `/api/download-world?id=${encodeURIComponent(serverId)}`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}


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
editModalOverlay.addEventListener('backdrop-dismiss', closeEditModal);

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

  // Reset icon picker and load existing icon (if any). The img stays hidden on 404.
  const iconInput = document.getElementById('edit-icon');
  iconInput.value = '';
  loadEditIconPreview();
}

function loadEditIconPreview() {
  const img = document.getElementById('edit-icon-preview');
  if (img.dataset.objectUrl) {
    URL.revokeObjectURL(img.dataset.objectUrl);
    delete img.dataset.objectUrl;
  }
  img.hidden = true;
  img.onload = () => { img.hidden = false; };
  img.onerror = () => { img.hidden = true; };
  img.src = `/api/server-icon?id=${encodeURIComponent(serverId)}&t=${Date.now()}`;
}

document.getElementById('edit-icon').addEventListener('change', (e) => {
  const file = e.target.files[0];
  const img = document.getElementById('edit-icon-preview');
  if (!file) { loadEditIconPreview(); return; }
  // Revoke any previous object URL we set on the img to avoid leaks.
  if (img.dataset.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);
  const url = URL.createObjectURL(file);
  img.dataset.objectUrl = url;
  img.src = url;
  img.hidden = false;
});

// --- Mods Modal ---
const modsModalOverlay = document.getElementById('mods-modal-overlay');
const modList = document.getElementById('mod-list');
const modError = document.getElementById('mod-error');
const modUploadBtn = document.getElementById('mod-upload-btn');
const modUploadStatus = document.getElementById('mod-upload-status');
const modFilesInput = document.getElementById('mod-files');

document.getElementById('close-mods-modal').onclick = closeModsModal;
modsModalOverlay.addEventListener('backdrop-dismiss', closeModsModal);

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
      iconInput.value = '';
    } else {
      editFormError.textContent = res.error;
    }
  });
};

// --- Files dropdown menu ---
const filesMenu = document.getElementById('files-menu');
const filesBtn = document.getElementById('btn-files');

filesBtn.onclick = () => {
  filesMenu.classList.toggle('open');
};

// Use mousedown rather than click so that drag-selecting text inside the menu
// (mousedown in menu, mouseup outside) does not dismiss it — only a press that
// originates outside both the menu and its trigger should close it.
document.addEventListener('mousedown', (e) => {
  if (!filesMenu.classList.contains('open')) return;
  if (filesBtn.contains(e.target)) return;
  if (filesMenu.contains(e.target)) return;
  filesMenu.classList.remove('open');
});

document.getElementById('files-menu-mods').onclick = () => {
  filesMenu.classList.remove('open');
  openModsModal();
};

document.getElementById('files-menu-update').onclick = () => {
  filesMenu.classList.remove('open');
  openUpdateModal();
};

menuDownloadWorld.onclick = () => {
  filesMenu.classList.remove('open');
  downloadWorld();
};

menuBackup.onclick = () => {
  filesMenu.classList.remove('open');
  backupWorld();
};

menuRestore.onclick = () => {
  if (menuRestore.disabled) return;
  filesMenu.classList.remove('open');
  restoreWorld();
};

// --- Update Modal ---
const updateModalOverlay = document.getElementById('update-modal-overlay');
const updateDropZone = document.getElementById('update-drop-zone');
const updateFilesInput = document.getElementById('update-files-input');
const updateFolderInput = document.getElementById('update-folder-input');
const updateStagedList = document.getElementById('update-staged-list');
const updateArgsDetails = document.getElementById('update-args-details');
const updateArgsText = document.getElementById('update-args-text');
const updateBackupCheckbox = document.getElementById('update-backup-checkbox');
const updateBackupRow = document.getElementById('update-backup-row');
const updateProgress = document.getElementById('update-progress');
const updateProgressText = document.getElementById('update-progress-text');
const updateProgressBar = document.getElementById('update-progress-bar');
const updateError = document.getElementById('update-error');
const applyUpdateBtn = document.getElementById('apply-update');
const stoppedWarn = document.getElementById('update-stopped-warn');

// Each entry: { file: File, relpath: string }
let stagedFiles = [];
let originalArgs = [];

function openUpdateModal() {
  // Refuse to open while running — server must be stopped to overwrite jars/world files safely.
  const running = currentStatus === 'running' || currentStatus === 'starting' || currentStatus === 'stopping';
  stoppedWarn.style.display = running ? '' : 'none';
  applyUpdateBtn.disabled = true;

  stagedFiles = [];
  renderStagedList();
  updateError.textContent = '';
  updateProgress.style.display = 'none';
  updateBackupCheckbox.checked = false;
  updateArgsDetails.open = false;

  // Load current start args; only show the section if the server has them (always does)
  socket.emit('get-server-startargs', { serverId }, (res) => {
    if (res.ok) {
      originalArgs = res.startArgs.slice();
      updateArgsText.value = originalArgs.join('\n');
    } else {
      originalArgs = [];
      updateArgsText.value = '';
    }
    updateApplyButtonState();
  });

  // Hide backup row if the server has no world yet (rare, but no point offering)
  // We just always show it — the backup endpoint will surface a clear error if there's nothing to back up.
  updateBackupRow.style.display = '';

  updateModalOverlay.classList.add('active');
}

function closeUpdateModal() {
  updateModalOverlay.classList.remove('active');
}

document.getElementById('cancel-update').onclick = closeUpdateModal;
updateModalOverlay.addEventListener('backdrop-dismiss', closeUpdateModal);

// File pickers
document.getElementById('update-pick-files').onclick = () => updateFilesInput.click();
document.getElementById('update-pick-folder').onclick = () => updateFolderInput.click();

updateFilesInput.onchange = () => {
  for (const f of updateFilesInput.files) addStagedFile(f, f.name);
  updateFilesInput.value = '';
  renderStagedList();
};

updateFolderInput.onchange = () => {
  for (const f of updateFolderInput.files) {
    // webkitRelativePath is "folderName/path/to/file"
    const rel = f.webkitRelativePath || f.name;
    addStagedFile(f, rel);
  }
  updateFolderInput.value = '';
  renderStagedList();
};

// Drag and drop
['dragenter', 'dragover'].forEach(ev => updateDropZone.addEventListener(ev, (e) => {
  e.preventDefault();
  e.stopPropagation();
  updateDropZone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(ev => updateDropZone.addEventListener(ev, (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (ev === 'dragleave' && updateDropZone.contains(e.relatedTarget)) return;
  updateDropZone.classList.remove('dragover');
}));

updateDropZone.addEventListener('drop', async (e) => {
  const items = e.dataTransfer.items;
  if (!items) {
    // Fallback: just use files (no folder support)
    for (const f of e.dataTransfer.files) addStagedFile(f, f.name);
    renderStagedList();
    return;
  }

  // Walk all items via webkitGetAsEntry to support folders
  const entries = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }

  for (const entry of entries) {
    await walkEntry(entry, '');
  }
  renderStagedList();
});

function walkEntry(entry, prefix) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        addStagedFile(file, rel);
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (batch.length === 0) {
            // All entries read — recurse
            const subPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
            for (const child of all) {
              await walkEntry(child, subPrefix);
            }
            resolve();
          } else {
            all.push(...batch);
            readBatch();
          }
        }, () => resolve());
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

function addStagedFile(file, relpath) {
  // Normalize separators; reject obviously bad paths client-side (server validates again)
  const norm = relpath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.split('/').some(seg => seg === '..')) return;
  // Avoid duplicate paths — last write wins
  stagedFiles = stagedFiles.filter(s => s.relpath !== norm);
  stagedFiles.push({ file, relpath: norm });
}

function renderStagedList() {
  if (stagedFiles.length === 0) {
    updateStagedList.innerHTML = '';
  } else {
    const totalBytes = stagedFiles.reduce((s, f) => s + f.file.size, 0);
    const isSingleZip = stagedFiles.length === 1 && stagedFiles[0].relpath.toLowerCase().endsWith('.zip');
    const summary = isSingleZip
      ? `1 ZIP archive (${formatBytes(totalBytes)}) — will be extracted on the server`
      : `${stagedFiles.length} file${stagedFiles.length === 1 ? '' : 's'} · ${formatBytes(totalBytes)}`;

    const rows = stagedFiles.map((s, i) => `
      <div class="staged-row">
        <span class="path" title="${esc(s.relpath)}">${esc(s.relpath)}</span>
        <span class="size">${formatBytes(s.file.size)}</span>
        <button type="button" class="remove" data-i="${i}" title="Remove">&times;</button>
      </div>
    `).join('');

    updateStagedList.innerHTML = `<div class="staged-summary">${summary}</div>${rows}`;
    updateStagedList.querySelectorAll('.remove').forEach(btn => {
      btn.onclick = () => {
        stagedFiles.splice(parseInt(btn.dataset.i, 10), 1);
        renderStagedList();
      };
    });
  }
  updateApplyButtonState();
}

// Compute the args list as it would be sent right now (trimmed, no blanks).
function getEditedArgs() {
  return updateArgsText.value.split('\n').map(s => s.trim()).filter(Boolean);
}

function isArgsChanged() {
  const cur = getEditedArgs();
  if (cur.length !== originalArgs.length) return true;
  return cur.some((v, i) => v !== originalArgs[i]);
}

// Apply is enabled if there is something to apply (files OR args change) AND the server is stopped.
function updateApplyButtonState() {
  const running = currentStatus === 'running' || currentStatus === 'starting' || currentStatus === 'stopping';
  const hasChanges = stagedFiles.length > 0 || isArgsChanged();
  applyUpdateBtn.disabled = running || !hasChanges;
}

updateArgsText.addEventListener('input', updateApplyButtonState);

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// --- Apply the update ---
applyUpdateBtn.onclick = async () => {
  const argsChanged = isArgsChanged();
  if (stagedFiles.length === 0 && !argsChanged) return;

  updateError.textContent = '';
  applyUpdateBtn.disabled = true;
  document.getElementById('cancel-update').disabled = true;
  updateProgress.style.display = '';

  try {
    // Step 1: optional backup
    if (updateBackupCheckbox.checked) {
      updateProgressText.textContent = 'Backing up world...';
      updateProgressBar.style.width = '0%';
      await new Promise((resolve, reject) => {
        socket.emit('backup-server', { serverId }, (r) => {
          if (r.ok) resolve();
          else reject(new Error(r.error || 'Backup failed'));
        });
      });
      refreshBackupState();
    }

    // Step 2: upload files (skipped if nothing staged)
    let totalAdded = 0;
    let totalOverwritten = 0;
    if (stagedFiles.length > 0) {
      const isSingleZip = stagedFiles.length === 1 && stagedFiles[0].relpath.toLowerCase().endsWith('.zip');
      if (isSingleZip) {
        const result = await uploadZip(stagedFiles[0].file);
        totalAdded += result.added || 0;
        totalOverwritten += result.overwritten || 0;
      } else {
        const totalBytes = stagedFiles.reduce((s, f) => s + f.file.size, 0);
        let bytesDone = 0;
        let filesDone = 0;
        for (const staged of stagedFiles) {
          updateProgressText.textContent = `Uploading ${filesDone + 1}/${stagedFiles.length}: ${staged.relpath}`;
          const result = await uploadFile(staged, (loaded) => {
            const pct = totalBytes > 0 ? Math.round(((bytesDone + loaded) / totalBytes) * 100) : 0;
            updateProgressBar.style.width = `${pct}%`;
          });
          bytesDone += staged.file.size;
          filesDone += 1;
          if (result.overwritten) totalOverwritten++; else totalAdded++;
        }
      }
    }

    // Step 3: update start args if changed (must happen AFTER file uploads so any
    // referenced jar that was just added passes the existence check)
    if (argsChanged) {
      const newArgs = getEditedArgs();
      if (newArgs.length === 0) throw new Error('Start arguments cannot be empty');
      updateProgressText.textContent = 'Updating start arguments...';
      updateProgressBar.style.width = '100%';
      await new Promise((resolve, reject) => {
        socket.emit('set-server-startargs', { serverId, startArgs: newArgs }, (r) => {
          if (r.ok) resolve();
          else reject(new Error(r.error || 'Failed to update start arguments'));
        });
      });
      // Reflect the new baseline so re-clicking Apply doesn't re-send the same args
      originalArgs = newArgs.slice();
    }

    closeUpdateModal();
    const parts = [];
    if (stagedFiles.length > 0) parts.push(`${totalAdded} added, ${totalOverwritten} overwritten`);
    if (argsChanged) parts.push('start arguments updated');
    showToast(`Update applied — ${parts.join(' · ')}`);
  } catch (err) {
    updateError.textContent = err.message;
    updateApplyButtonState();
  } finally {
    document.getElementById('cancel-update').disabled = false;
    updateProgress.style.display = 'none';
  }
};

function uploadFile(staged, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && onProgress) onProgress(evt.loaded);
    };
    xhr.onload = () => {
      let res;
      try { res = JSON.parse(xhr.responseText); }
      catch { return reject(new Error('Invalid server response')); }
      if (!res.ok) return reject(new Error(res.error || 'Upload failed'));
      resolve(res);
    };
    xhr.onerror = () => reject(new Error('Upload failed — check your connection'));
    const url = `/api/update-server-file?id=${encodeURIComponent(serverId)}&relpath=${encodeURIComponent(staged.relpath)}`;
    xhr.open('POST', url);
    xhr.send(staged.file);
  });
}

function uploadZip(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        const pct = Math.round((evt.loaded / evt.total) * 100);
        updateProgressBar.style.width = `${pct}%`;
        updateProgressText.textContent = `Uploading ZIP ${pct}%`;
      }
    };
    xhr.onload = () => {
      let res;
      try { res = JSON.parse(xhr.responseText); }
      catch { return reject(new Error('Invalid server response')); }
      if (!res.ok) return reject(new Error(res.error || 'Upload failed'));
      updateProgressText.textContent = 'Extracting ZIP on server...';
      resolve(res);
    };
    xhr.onerror = () => reject(new Error('Upload failed — check your connection'));
    xhr.open('POST', `/api/update-server-zip?id=${encodeURIComponent(serverId)}`);
    xhr.send(file);
  });
}

// --- Toast ---
const toastContainer = document.getElementById('toast-container');

function showToast(message, kind) {
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' error' : ''}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  // Animation total: ~4s before fully gone — remove after to keep DOM clean
  setTimeout(() => el.remove(), 4200);
}
