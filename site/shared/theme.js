'use strict';
// Loaded in <head> before the stylesheet by every page of OrbitWan's dapps.
// The theme: light by default, dark on request, remembered in this browser under 'orbit-theme', as on orbitwan.io, so
// the page is drawn in the chosen theme from the first frame.
// The apps' links: each names its published page (https://express.orbitwan.io, https://xlend.orbitwan.io) and, in
// data-here, the same page beside this one. On a published host the published page is kept; on any other host (the
// copy staged for review, a local copy) the link goes to the page beside this one, so a copy links its own pages.
(function () {
  const root = document.documentElement;
  const PUBLISHED = ['express.orbitwan.io', 'xlend.orbitwan.io'];
  try { if (localStorage.getItem('orbit-theme') === 'dark') root.setAttribute('data-theme', 'dark'); } catch (e) { /* storage blocked: light */ }
  document.addEventListener('DOMContentLoaded', function () {
    if (PUBLISHED.indexOf(location.hostname) < 0) {
      document.querySelectorAll('a[data-here]').forEach(function (a) { a.setAttribute('href', a.getAttribute('data-here')); });
    }
    const btn = document.getElementById('tog');
    if (!btn) return;
    btn.addEventListener('click', function () {
      const dark = root.getAttribute('data-theme') === 'dark';
      if (dark) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', 'dark');
      try { localStorage.setItem('orbit-theme', dark ? 'light' : 'dark'); } catch (e) { /* not remembered */ }
    });
  });
})();
