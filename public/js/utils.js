function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Fetch and display version label
fetch('/api/version').then(r => r.json()).then(d => {
  const el = document.getElementById('version-label');
  if (el) el.textContent = 'v' + d.version;
}).catch(() => {});
