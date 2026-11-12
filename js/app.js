/* Bootstrap: load data, then render. */
(function () {
  'use strict';
  const SFN = window.SFN;

  // In-page section links must not touch the URL hash, which holds the filter state.
  document.querySelectorAll('[data-jump]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const target = document.getElementById(a.dataset.jump);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  SFN.filters.init();
  SFN.load()
    .then((model) => {
      document.getElementById('loading').hidden = true;
      SFN.render.init(model);
    })
    .catch((err) => {
      console.error(err);
      document.getElementById('loading').hidden = true;
      const box = document.getElementById('error');
      box.hidden = false;
      box.textContent = location.protocol === 'file:'
        ? 'The schedule data could not be loaded. Browsers block data files when a page is opened directly from disk. Serve the folder instead, for example: python3 -m http.server, then open http://localhost:8000.'
        : 'The schedule data could not be loaded (' + err.message + '). Please try again later.';
    });
})();
