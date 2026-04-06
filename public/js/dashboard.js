const socket = io();
const serverGrid = document.getElementById('server-grid');
const emptyState = document.getElementById('empty-state');
const modalOverlay = document.getElementById('modal-overlay');
const form = document.getElementById('create-server-form');
const formError = document.getElementById('form-error');
const templateSelect = document.getElementById('srv-template');

let servers = [];

socket.emit('join-dashboard');

socket.emit('list-servers', (list) => {
  servers = list;
  renderGrid();
});

// Live updates
socket.on('server-created', (info) => {
  servers.push(info);
  renderGrid();
});

socket.on('server-deleted', ({ serverId }) => {
  servers = servers.filter(s => s.id !== serverId);
  renderGrid();
});

socket.on('server-updated', (info) => {
  const idx = servers.findIndex(s => s.id === info.id);
  if (idx !== -1) servers[idx] = info;
  renderGrid();
});

function renderGrid() {
  if (servers.length === 0) {
    serverGrid.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }
  serverGrid.style.display = 'grid';
  emptyState.style.display = 'none';

  serverGrid.innerHTML = servers.map(s => `
    <a href="/server.html?id=${s.id}" class="server-card">
      <div class="server-card-header">
        <span class="status-dot ${s.status}"></span>
        <h3>${esc(s.name)}</h3>
      </div>
      <div class="server-card-meta">
        <span>Port: ${s.port} &middot; ${s.status}</span>
        ${s.status === 'running' ? `<span>Players: ${s.playerCount}</span>` : ''}
        <span>Template: ${esc(s.templateName)}</span>
      </div>
    </a>
  `).join('');
}

function loadTemplates() {
  socket.emit('list-templates', (templates) => {
    templateSelect.innerHTML = '';

    // Always offer "Latest Release" as the first option
    const latestOpt = document.createElement('option');
    latestOpt.value = '__latest_release__';
    latestOpt.textContent = 'Latest Release (Vanilla)';
    templateSelect.appendChild(latestOpt);

    const ready = templates.filter(t => t.hasJar);
    for (const t of ready) {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name;
      templateSelect.appendChild(opt);
    }
  });
}

// --- Add Server Modal ---
document.getElementById('add-server-btn').onclick = openModal;
document.getElementById('add-server-btn-empty').onclick = openModal;
document.getElementById('cancel-modal').onclick = closeModal;
modalOverlay.onclick = (e) => { if (e.target === modalOverlay) closeModal(); };

function openModal() {
  formError.textContent = '';
  form.reset();
  modalOverlay.classList.add('active');
  loadTemplates();
}

function closeModal() {
  modalOverlay.classList.remove('active');
}

form.onsubmit = async (e) => {
  e.preventDefault();
  formError.textContent = '';

  const ramValue = document.getElementById('srv-maxram').value;
  const data = {
    name: document.getElementById('srv-name').value.trim(),
    templateName: templateSelect.value,
    port: document.getElementById('srv-port').value || undefined,
    motd: document.getElementById('srv-motd').value || undefined,
    difficulty: document.getElementById('srv-difficulty').value,
    gamemode: document.getElementById('srv-gamemode').value,
    hardcore: document.getElementById('srv-hardcore').checked,
    maxRam: `${parseInt(ramValue) * 1024}M`,
    pvp: document.getElementById('srv-pvp').checked,
    maxPlayers: document.getElementById('srv-maxplayers').value || undefined,
    viewDistance: document.getElementById('srv-viewdist').value || undefined,
    simulationDistance: document.getElementById('srv-simdist').value || undefined,
    whitelist: document.getElementById('srv-whitelist').checked,
  };

  if (!data.name) { formError.textContent = 'Name is required'; return; }
  if (!data.templateName) { formError.textContent = 'Select a template'; return; }

  const createBtn = form.querySelector('button[type="submit"]');
  const progressDiv = document.getElementById('download-progress');
  const progressText = document.getElementById('download-progress-text');
  const progressBar = document.getElementById('download-progress-bar');

  // Handle "Latest Release" selection
  if (data.templateName === '__latest_release__') {
    createBtn.disabled = true;
    createBtn.textContent = 'Fetching version...';

    const releaseInfo = await new Promise((resolve) => {
      socket.emit('fetch-latest-release', (res) => resolve(res));
    });

    if (!releaseInfo.ok) {
      formError.textContent = releaseInfo.error;
      createBtn.disabled = false;
      createBtn.textContent = 'Create';
      return;
    }

    data.templateName = releaseInfo.templateName;

    if (!releaseInfo.cached) {
      progressDiv.style.display = '';
      progressText.textContent = `Downloading Vanilla ${releaseInfo.version} server...`;
      progressBar.style.width = '0%';
      createBtn.textContent = 'Downloading...';

      data._latestRelease = {
        jarUrl: releaseInfo.jarUrl,
        sha1: releaseInfo.sha1,
        templateName: releaseInfo.templateName,
      };
    } else {
      createBtn.textContent = 'Creating...';
    }
  }

  // Listen for download progress
  const onProgress = ({ downloaded, total }) => {
    const pct = total ? Math.round((downloaded / total) * 100) : 0;
    progressBar.style.width = pct + '%';
    progressText.textContent = `Downloading... ${pct}% (${Math.round(downloaded / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`;
  };
  socket.on('download-progress', onProgress);

  createBtn.disabled = true;
  if (createBtn.textContent === 'Create') createBtn.textContent = 'Creating...';

  socket.emit('create-server', data, async (res) => {
    socket.off('download-progress', onProgress);
    progressDiv.style.display = 'none';
    progressBar.style.width = '0%';
    createBtn.disabled = false;
    createBtn.textContent = 'Create';

    if (res.ok) {
      const iconInput = document.getElementById('srv-icon');
      if (iconInput.files[0]) {
        const buf = await iconInput.files[0].arrayBuffer();
        socket.emit('upload-server-icon', { serverId: res.server.id, imageData: buf }, () => {});
      }
      closeModal();
    } else {
      formError.textContent = res.error;
    }
  });
};

// --- Add Template Modal ---
const templateModalOverlay = document.getElementById('template-modal-overlay');
const templateUploadForm = document.getElementById('template-upload-form');
const templateError = document.getElementById('template-error');
const templatePickError = document.getElementById('template-pick-error');
const stepUpload = document.getElementById('template-step-upload');
const stepPick = document.getElementById('template-step-pick');
const filePicker = document.getElementById('tpl-file-picker');

let pendingTemplateName = null;

document.getElementById('add-template-btn').onclick = openTemplateModal;
document.getElementById('cancel-template-modal').onclick = closeTemplateModal;
document.getElementById('cancel-template-pick').onclick = () => {
  if (pendingTemplateName) {
    socket.emit('cancel-template-upload', { name: pendingTemplateName });
  }
  closeTemplateModal();
};
templateModalOverlay.onclick = (e) => {
  if (e.target === templateModalOverlay) {
    if (pendingTemplateName) {
      socket.emit('cancel-template-upload', { name: pendingTemplateName });
    }
    closeTemplateModal();
  }
};

function openTemplateModal() {
  templateError.textContent = '';
  templatePickError.textContent = '';
  templateUploadForm.reset();
  stepUpload.style.display = '';
  stepPick.style.display = 'none';
  pendingTemplateName = null;
  document.getElementById('tpl-upload-btn').disabled = false;
  document.getElementById('tpl-upload-btn').textContent = 'Upload';
  templateModalOverlay.classList.add('active');
}

function closeTemplateModal() {
  pendingTemplateName = null;
  templateModalOverlay.classList.remove('active');
}

templateUploadForm.onsubmit = (e) => {
  e.preventDefault();
  templateError.textContent = '';

  const name = document.getElementById('tpl-name').value.trim();
  const fileInput = document.getElementById('tpl-zip');
  if (!name) { templateError.textContent = 'Name is required'; return; }
  if (!fileInput.files[0]) { templateError.textContent = 'Select a ZIP file'; return; }

  const uploadBtn = document.getElementById('tpl-upload-btn');
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading 0%...';

  const xhr = new XMLHttpRequest();
  xhr.upload.onprogress = (evt) => {
    if (evt.lengthComputable) {
      uploadBtn.textContent = `Uploading ${Math.round((evt.loaded / evt.total) * 100)}%...`;
    }
  };
  xhr.onload = () => {
    let res;
    try { res = JSON.parse(xhr.responseText); } catch {
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload';
      templateError.textContent = 'Invalid server response';
      return;
    }
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload';
    if (!res.ok) {
      templateError.textContent = res.error;
      return;
    }
    pendingTemplateName = name;
    showFilePicker(res.files, name);
  };
  xhr.onerror = () => {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload';
    templateError.textContent = 'Upload failed — check your connection';
  };
  xhr.open('POST', `/api/upload-template?name=${encodeURIComponent(name)}`);
  xhr.send(fileInput.files[0]);
};

function showFilePicker(files, name) {
  stepUpload.style.display = 'none';
  stepPick.style.display = '';
  templatePickError.textContent = '';
  document.getElementById('tpl-custom-args').value = '';

  const jarFiles = files.filter(f => f.endsWith('.jar'));
  if (jarFiles.length === 0) {
    filePicker.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">No .jar files found in the ZIP</p>';
  } else {
    filePicker.innerHTML = jarFiles.map((f, i) => `
      <label>
        <input type="radio" name="tpl-jar" value="${esc(f)}" ${i === 0 ? 'checked' : ''}>
        ${esc(f)}
      </label>
    `).join('');
  }

  document.getElementById('confirm-template').disabled = false;
}

document.getElementById('confirm-template').onclick = () => {
  const customArgs = document.getElementById('tpl-custom-args').value.trim();
  const selected = filePicker.querySelector('input[name="tpl-jar"]:checked');
  if (!customArgs && !selected) { templatePickError.textContent = 'Select a server file or enter custom arguments'; return; }

  document.getElementById('confirm-template').disabled = true;
  const payload = { name: pendingTemplateName };
  if (customArgs) {
    payload.customArgs = customArgs;
  } else {
    payload.serverJar = selected.value;
  }
  socket.emit('finalize-template', payload, (res) => {
    document.getElementById('confirm-template').disabled = false;
    if (res.ok) {
      closeTemplateModal();
    } else {
      templatePickError.textContent = res.error;
    }
  });
};

// --- Import Server Modal ---
const importModalOverlay = document.getElementById('import-modal-overlay');
const importUploadForm = document.getElementById('import-upload-form');
const importError = document.getElementById('import-error');
const importConfigureError = document.getElementById('import-configure-error');
const importStepUpload = document.getElementById('import-step-upload');
const importStepConfigure = document.getElementById('import-step-configure');
const impFilePicker = document.getElementById('imp-file-picker');

let pendingImportId = null;

document.getElementById('import-server-btn').onclick = openImportModal;
document.getElementById('cancel-import-modal').onclick = closeImportModal;
document.getElementById('cancel-import-configure').onclick = () => {
  if (pendingImportId) {
    socket.emit('cancel-import', { importId: pendingImportId });
  }
  closeImportModal();
};
importModalOverlay.onclick = (e) => {
  if (e.target === importModalOverlay) {
    if (pendingImportId) {
      socket.emit('cancel-import', { importId: pendingImportId });
    }
    closeImportModal();
  }
};

function openImportModal() {
  importError.textContent = '';
  importConfigureError.textContent = '';
  importUploadForm.reset();
  importStepUpload.style.display = '';
  importStepConfigure.style.display = 'none';
  pendingImportId = null;
  document.getElementById('imp-upload-btn').disabled = false;
  document.getElementById('imp-upload-btn').textContent = 'Upload';
  importModalOverlay.classList.add('active');
}

function closeImportModal() {
  pendingImportId = null;
  importModalOverlay.classList.remove('active');
}

importUploadForm.onsubmit = (e) => {
  e.preventDefault();
  importError.textContent = '';

  const name = document.getElementById('imp-name').value.trim();
  const fileInput = document.getElementById('imp-zip');
  if (!name) { importError.textContent = 'Name is required'; return; }
  if (!fileInput.files[0]) { importError.textContent = 'Select a ZIP file'; return; }

  const uploadBtn = document.getElementById('imp-upload-btn');
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading 0%...';

  const xhr = new XMLHttpRequest();
  xhr.upload.onprogress = (evt) => {
    if (evt.lengthComputable) {
      uploadBtn.textContent = `Uploading ${Math.round((evt.loaded / evt.total) * 100)}%...`;
    }
  };
  xhr.onload = () => {
    let res;
    try { res = JSON.parse(xhr.responseText); } catch {
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload';
      importError.textContent = 'Invalid server response';
      return;
    }
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload';
    if (!res.ok) {
      importError.textContent = res.error;
      return;
    }
    pendingImportId = res.importId;
    showImportConfigure(res);
  };
  xhr.onerror = () => {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload';
    importError.textContent = 'Upload failed — check your connection';
  };
  xhr.open('POST', `/api/import-server?name=${encodeURIComponent(name)}`);
  xhr.send(fileInput.files[0]);
};

function showImportConfigure(data) {
  importStepUpload.style.display = 'none';
  importStepConfigure.style.display = '';
  importConfigureError.textContent = '';
  document.getElementById('imp-custom-args').value = '';

  // Populate jar file picker
  const jarFiles = data.jarFiles || [];
  if (jarFiles.length === 0) {
    impFilePicker.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">No .jar files found in the ZIP</p>';
  } else {
    impFilePicker.innerHTML = jarFiles.map((f, i) => `
      <label>
        <input type="radio" name="imp-jar" value="${esc(f)}" ${i === 0 ? 'checked' : ''}>
        ${esc(f)}
      </label>
    `).join('');
  }

  // Pre-fill modded hint
  if (data.moddedHint) {
    document.getElementById('imp-custom-args').value = data.moddedHint;
  }

  // Pre-fill settings from detected server.properties
  document.getElementById('imp-name2').value = data.name || '';
  const detected = data.detectedSettings || {};
  if (detected['server-port']) {
    document.getElementById('imp-port').value = detected['server-port'];
  }

  document.getElementById('confirm-import').disabled = false;
}

// --- View Templates Modal ---
const viewTemplatesModalOverlay = document.getElementById('view-templates-modal-overlay');
const viewTemplatesList = document.getElementById('view-templates-list');
const viewTemplatesError = document.getElementById('view-templates-error');

document.getElementById('view-templates-btn').onclick = openViewTemplatesModal;
document.getElementById('close-view-templates-modal').onclick = closeViewTemplatesModal;
viewTemplatesModalOverlay.onclick = (e) => { if (e.target === viewTemplatesModalOverlay) closeViewTemplatesModal(); };

function openViewTemplatesModal() {
  viewTemplatesError.textContent = '';
  viewTemplatesList.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">Loading...</p>';
  viewTemplatesModalOverlay.classList.add('active');
  refreshViewTemplatesList();
}

function closeViewTemplatesModal() {
  viewTemplatesModalOverlay.classList.remove('active');
}

function refreshViewTemplatesList() {
  socket.emit('list-templates', (templates) => {
    viewTemplatesError.textContent = '';
    if (templates.length === 0) {
      viewTemplatesList.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">No templates found.</p>';
      return;
    }
    viewTemplatesList.innerHTML = templates.map(t => `
      <div class="template-list-row" data-name="${esc(t.name)}">
        <span class="template-list-name">${esc(t.name)}</span>
        <span class="template-list-status ${t.hasJar ? 'ready' : 'not-ready'}">${t.hasJar ? 'Ready' : 'Not ready'}</span>
        <button class="btn btn-danger btn-sm delete-template-btn" data-name="${esc(t.name)}">Delete</button>
      </div>
    `).join('');

    viewTemplatesList.querySelectorAll('.delete-template-btn').forEach(btn => {
      btn.onclick = () => deleteTemplate(btn.dataset.name, btn);
    });
  });
}

function deleteTemplate(name, btn) {
  if (!confirm(`Delete template "${name}"? This cannot be undone.`)) return;
  btn.disabled = true;
  socket.emit('delete-template', { name }, (res) => {
    if (res.ok) {
      refreshViewTemplatesList();
    } else {
      viewTemplatesError.textContent = res.error;
      btn.disabled = false;
    }
  });
}

// --- Hamburger menu (mobile) ---
const hamburgerBtn = document.getElementById('hamburger-btn');
const navSecondaryActions = document.getElementById('nav-secondary-actions');

hamburgerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = navSecondaryActions.classList.toggle('open');
  hamburgerBtn.setAttribute('aria-expanded', String(isOpen));
});

document.addEventListener('click', () => {
  navSecondaryActions.classList.remove('open');
  hamburgerBtn.setAttribute('aria-expanded', 'false');
});

document.getElementById('confirm-import').onclick = () => {
  const customArgs = document.getElementById('imp-custom-args').value.trim();
  const selected = impFilePicker.querySelector('input[name="imp-jar"]:checked');
  if (!customArgs && !selected) {
    importConfigureError.textContent = 'Select a server file or enter custom arguments';
    return;
  }

  const name = document.getElementById('imp-name2').value.trim();
  if (!name) {
    importConfigureError.textContent = 'Server name is required';
    return;
  }

  document.getElementById('confirm-import').disabled = true;
  const ramValue = document.getElementById('imp-maxram').value;
  const payload = {
    importId: pendingImportId,
    name,
    port: document.getElementById('imp-port').value || undefined,
    maxRam: `${parseInt(ramValue) * 1024}M`,
  };
  if (customArgs) {
    payload.customArgs = customArgs;
  } else {
    payload.serverJar = selected.value;
  }

  socket.emit('finalize-import', payload, (res) => {
    document.getElementById('confirm-import').disabled = false;
    if (res.ok) {
      closeImportModal();
    } else {
      importConfigureError.textContent = res.error;
    }
  });
};
