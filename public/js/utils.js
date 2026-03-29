function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
