/* Filter state (kept in the URL hash so views can be shared) and matching logic.
   Example: #scope=neuro&day=2026-11-16&fmt=poster&theme=E,I&q=dopamine */
(function () {
  'use strict';
  const SFN = (window.SFN = window.SFN || {});
  const SCOPE_IDS = SFN.SCOPES.map((s) => s.id);
  const RANK = Object.fromEntries(SFN.SCOPES.map((s) => [s.id, s.rank]));
  const FORMATS = ['poster', 'talk', 'role'];

  const defaults = () => ({ scope: 'don', ctx: false, days: [], fmts: [], themes: [], q: '' });
  let state = defaults();
  const listeners = [];

  const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

  function parseHash() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    const st = defaults();
    if (SCOPE_IDS.includes(p.get('scope'))) st.scope = p.get('scope');
    st.ctx = p.get('ctx') === '1';
    st.days = list(p.get('day'));
    st.fmts = list(p.get('fmt')).filter((f) => FORMATS.includes(f));
    st.themes = list(p.get('theme'));
    st.q = (p.get('q') || '').slice(0, 200);
    return st;
  }

  function writeHash() {
    const old = new URLSearchParams(location.hash.replace(/^#/, ''));
    const p = new URLSearchParams();
    if (state.scope !== 'don') p.set('scope', state.scope);
    if (state.ctx) p.set('ctx', '1');
    if (state.days.length) p.set('day', state.days.join(','));
    if (state.fmts.length) p.set('fmt', state.fmts.join(','));
    if (state.themes.length) p.set('theme', state.themes.join(','));
    if (state.q) p.set('q', state.q);
    if (old.get('now')) p.set('now', old.get('now'));
    const s = p.toString();
    history.replaceState(null, '', location.pathname + location.search + (s ? '#' + s.replace(/%2C/g, ',').replace(/%3A/g, ':') : ''));
  }

  function emit() { listeners.forEach((fn) => fn(state)); }

  function set(patch) {
    state = Object.assign({}, state, patch);
    writeHash();
    emit();
  }
  function toggle(key, value) {
    const cur = state[key];
    set({ [key]: cur.includes(value) ? cur.filter((v) => v !== value) : cur.concat(value) });
  }
  function reset() {
    state = defaults();
    writeHash();
    emit();
  }

  /* opts.ignoreScope / ignoreDay / ignoreFmt / ignoreTheme let a section opt out of one filter. */
  function matches(item, st, opts) {
    opts = opts || {};
    if (!opts.ignoreScope) {
      const ok = item.tier <= RANK[st.scope] || (item.tier === SFN.CONTEXT_TIER && st.ctx);
      if (!ok) return false;
    }
    if (!opts.ignoreDay && st.days.length && !st.days.includes(item.date)) return false;
    if (!opts.ignoreFmt && st.fmts.length && !st.fmts.includes(item.group)) return false;
    if (!opts.ignoreTheme && st.themes.length && !item.themeLetters.some((l) => st.themes.includes(l))) return false;
    if (st.q) {
      const terms = st.q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.every((t) => item.haystack.includes(t))) return false;
    }
    return true;
  }

  function filter(items, st, opts) {
    return items.filter((i) => matches(i, st || state, opts));
  }

  /* Counts for each scope button (cumulative) under the other active filters. */
  function scopeCounts(items, st) {
    const counts = { context: 0 };
    SCOPE_IDS.forEach((id) => (counts[id] = 0));
    items.forEach((i) => {
      if (!matches(i, st, { ignoreScope: true })) return;
      if (i.tier === SFN.CONTEXT_TIER) { counts.context++; return; }
      SCOPE_IDS.forEach((id) => { if (i.tier <= RANK[id]) counts[id]++; });
    });
    return counts;
  }

  /* True when any filter other than scope is narrowing the view. */
  function narrowing(st) {
    st = st || state;
    return !!(st.days.length || st.fmts.length || st.themes.length || st.q);
  }
  function isDefault(st) {
    st = st || state;
    return st.scope === 'don' && !st.ctx && !narrowing(st);
  }

  function init() {
    state = parseHash();
    window.addEventListener('hashchange', () => {
      const next = parseHash();
      if (JSON.stringify(next) !== JSON.stringify(state)) { state = next; emit(); }
      else emit(); // the "now" override may have changed
    });
  }

  SFN.filters = {
    init, get: () => state, set, toggle, reset, matches, filter, scopeCounts, narrowing, isDefault,
    onChange: (fn) => listeners.push(fn)
  };
})();
