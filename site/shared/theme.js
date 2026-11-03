'use strict';
// Light by default, dark on request, remembered in this browser under 'orbit-theme', as on orbitwan.io. Loaded in
// <head> before the stylesheet, so the page is drawn in the chosen theme from the first frame.
(function () {
  const root = document.documentElement;
  try { if (localStorage.getItem('orbit-theme') === 'dark') root.setAttribute('data-theme', 'dark'); } catch (e) { /* storage blocked: light */ }
  document.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('tog');
    if (!btn) return;
    btn.addEventListener('click', function () {
      const dark = root.getAttribute('data-theme') === 'dark';
      if (dark) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', 'dark');
      try { localStorage.setItem('orbit-theme', dark ? 'light' : 'dark'); } catch (e) { /* not remembered */ }
    });
  });
})();
