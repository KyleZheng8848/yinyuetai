'use strict';

(() => {
  const dialog = document.getElementById('studio-about');
  const version = document.getElementById('studio-about-version');
  // Keep application-wide creation/cancel shortcuts behind the modal inactive.
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  async function showAbout() {
    if (!dialog.open) dialog.showModal();
    version.textContent = document.getElementById('app-version').textContent;
    try {
      const response = await fetch('/api/status');
      if (!response.ok) return;
      const status = await response.json();
      if (status.app?.version) version.textContent = `v${status.app.version}`;
    } catch (_) { /* The dialog remains usable offline. */ }
  }
  document.querySelectorAll('[data-about-open]').forEach((button) => button.addEventListener('click', showAbout));
  window.desktopShell?.onShowAbout?.(showAbout);
})();
