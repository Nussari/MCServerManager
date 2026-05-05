function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Backdrop-dismiss for modal overlays. Installed ONCE at document level — every
// .modal-overlay automatically supports it. Modals subscribe via:
//
//   overlay.addEventListener('backdrop-dismiss', closeFn)
//
// The event fires only when mousedown AND mouseup both happen directly on the
// overlay element. A drag-select that begins inside the modal panel and ends on
// the backdrop will NOT dismiss the modal — that bug came from listening to
// `click`, which fires on the common ancestor of mousedown/mouseup targets.
//
// DO NOT use overlay.onclick / a plain 'click' listener to dismiss modals.
(function installBackdropDismissDelegation() {
  let pressedOverlay = null;
  document.addEventListener('mousedown', (e) => {
    pressedOverlay = (e.target.classList && e.target.classList.contains('modal-overlay'))
      ? e.target
      : null;
  });
  document.addEventListener('mouseup', (e) => {
    const overlay = pressedOverlay;
    pressedOverlay = null;
    if (!overlay || e.target !== overlay) return;
    overlay.dispatchEvent(new CustomEvent('backdrop-dismiss'));
  });
})();

// Fetch and display version label
fetch('/api/version').then(r => r.json()).then(d => {
  const el = document.getElementById('version-label');
  if (el) el.textContent = 'v' + d.version;
}).catch(() => {});
