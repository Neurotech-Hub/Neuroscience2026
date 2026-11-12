/* Rendering for the filter bar and the three sections. All scraped text is
   inserted with textContent (via h()), never as HTML. */
(function () {
  'use strict';
  const SFN = (window.SFN = window.SFN || {});
  const F = () => SFN.filters;

  let M = null; // normalized model
  const ui = {};
  const view = {
    shown: 8,            // "Up next" cards
    liveShown: 12,       // "Happening now" cards
    openCell: null,      // "day|block" selected in the grid
    sort: { key: 'when', dir: 1 },
    expanded: new Set(), // table rows with details open
    peopleOpen: new Map(),
    showAbsent: false,
    othersOpen: false,
    peopleMode: (function () { try { return localStorage.getItem('sfn.peopleMode') === 'cards' ? 'cards' : 'timeline'; } catch (e) { return 'timeline'; } })()
  };

  const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';

  /* ---------- DOM helper ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'icon') el.innerHTML = v; // static, trusted SVG only
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    kids.flat(Infinity).forEach((kid) => {
      if (kid == null || kid === false) return;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    });
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
  function ext(href, text, cls) {
    return href ? h('a', { href, target: '_blank', rel: 'noopener', class: cls }, text, ' \u2197') : null;
  }
  const themeLabel = (l) => 'Theme ' + l + (SFN.THEME_NAMES[l] ? ': ' + SFN.THEME_NAMES[l] : '');

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const a = h('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'event';

  /* Small, low-key "iCal" link; items can be one item or several. */
  function icsLink(items, filename, calName, label) {
    if (!items.length) return null;
    return h('button', {
      type: 'button', class: 'ics-link',
      title: items.length === 1 ? 'Add to calendar (.ics)' : 'Add ' + items.length + ' items to calendar (.ics)',
      onclick: () => download(filename + '.ics', SFN.ics.build(items, calName), 'text/calendar;charset=utf-8')
    }, label || 'iCal');
  }
  const itemIcs = (it) => icsLink([it], 'sfn2026-' + (it.number ? slug(it.number) : slug(it.title)), 'Neuroscience 2026');

  /* ---------- shared item pieces ---------- */
  const tagClass = (it) => ({ role: 'role', poster: 'poster', event: 'event' })[it.group] || '';

  function tagsFor(it) {
    return h('div', { class: 'tags' },
      it.isDon && h('span', { class: 'tag don', title: 'Department of Neuroscience faculty author' }, 'DoN'),
      h('span', { class: 'tag ' + tagClass(it) }, it.kind),
      it.tier === SFN.CONTEXT_TIER && h('span', { class: 'tag ctx', title: 'Not WashU-authored; in a session WashU people chair or moderate' }, 'Session context')
    );
  }

  function peopleLine(it) {
    if (!it.washu.length) {
      return it.presenter ? h('div', { class: 'people-line' }, (it.isEvent ? 'Organizer: ' : 'Presenter: ') + it.presenter.replace(/,\s*(MS|PhD|MD|Ph\.D\.)$/i, '')) : null;
    }
    const nodes = [];
    it.washu.forEach((a, i) => {
      if (i) nodes.push(', ');
      nodes.push(h('span', { class: 'person-name' + (a.isDon ? ' don' : a.isNeuro ? ' neuro' : ''), title: a.isDon ? 'DoN faculty' : a.isNeuro ? 'Lists Dept. of Neuroscience' : null }, a.name));
      if (a.presenting) nodes.push(h('span', { class: 'mic', title: 'Presenting author', icon: MIC }));
    });
    return h('div', { class: 'people-line' }, nodes);
  }

  function whereText(it) {
    const bits = [];
    if (it.room) bits.push(it.room);
    if (it.board) bits.push('Board ' + it.board);
    return bits.join(' \u00b7 ');
  }
  function sessionText(it) {
    return [it.sessionNumber, it.sessionTitle].filter(Boolean).join(' \u00b7 ');
  }
  const whenText = (it) => SFN.fmtDay(it.date) + ' \u00b7 ' + SFN.fmtRange(it.start, it.end);

  function itemLinks(it, cls, tag) {
    const links = it.isEvent
      ? [ext(it.sessionUrl || it.url, 'Event details')]
      : [ext(it.url, 'Abstract'), ext(it.sessionUrl, 'Session')];
    return h(tag || 'div', { class: cls }, links, itemIcs(it));
  }

  function card(it, live) {
    return h('article', { class: 'card' + (it.isDon ? ' don' : '') + (it.isEvent ? ' event' : '') + (live ? ' live' : '') },
      h('div', { class: 'card-time' }, whenText(it)),
      tagsFor(it),
      h('h3', { class: 'card-title' }, it.url ? h('a', { href: it.url, target: '_blank', rel: 'noopener' }, it.title) : it.title),
      h('div', { class: 'card-where' }, [whereText(it), it.isEvent ? '' : sessionText(it)].filter(Boolean).join(' \u2014 ')),
      peopleLine(it),
      itemLinks(it, 'card-links')
    );
  }

  /* ---------- hero stats / footer ---------- */
  function renderHeroMeta() {
    if (!M.days.length) return;
    const first = new Date(M.days[0] + 'T12:00:00Z');
    const last = new Date(M.days[M.days.length - 1] + 'T12:00:00Z');
    const mon = (d) => d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    const range = mon(first) === mon(last)
      ? mon(first) + ' ' + first.getUTCDate() + '\u2013' + last.getUTCDate() + ', ' + last.getUTCFullYear()
      : mon(first) + ' ' + first.getUTCDate() + ' \u2013 ' + mon(last) + ' ' + last.getUTCDate() + ', ' + last.getUTCFullYear();
    ui.heroMeta.prepend(h('span', { class: 'date' }, range), h('span', { class: 'sep', 'aria-hidden': 'true' }), h('span', null, 'Times Eastern'), h('span', { class: 'sep', 'aria-hidden': 'true' }));
  }

  function renderMetrics() {
    const washu = M.items.filter((i) => i.tier < SFN.CONTEXT_TIER);
    const count = (g) => washu.filter((i) => i.group === g).length;
    const sessions = new Set(washu.map((i) => i.sessionNumber || i.sessionTitle).filter(Boolean)).size;
    const byDay = M.days.map((d) => [d, washu.filter((i) => i.date === d).length]).sort((a, b) => b[1] - a[1]);
    const donPresenting = M.people.filter((p) => p.isDon).length;
    const g = SFN.timeParts(M.generated);
    const tile = (n, label) => h('div', { class: 'metric' }, h('b', null, n), h('span', null, label));
    const wide = (label, value) => h('div', { class: 'metric wide' }, h('span', null, label), h('b', null, value));

    clear(ui.metricsPanel);
    ui.metricsPanel.append(
      h('h2', null, 'Neuroscience 2026 at WashU'),
      h('div', { class: 'metrics-grid' },
        tile(M.items.filter((i) => i.isDon).length, 'items with DoN faculty'),
        tile(M.donRosterSize ? donPresenting + ' / ' + M.donRosterSize : donPresenting, 'DoN faculty on the program'),
        tile(washu.length, 'WashU items in total'),
        tile(M.people.length, 'WashU PIs presenting'),
        wide('Posters \u00b7 Talks \u00b7 Roles \u00b7 Events', count('poster') + ' \u00b7 ' + count('talk') + ' \u00b7 ' + count('role') + ' \u00b7 ' + count('event')),
        wide('Sessions with WashU work', sessions),
        byDay.length ? wide('Busiest day', SFN.fmtDay(byDay[0][0]) + ' (' + byDay[0][1] + ')') : null
      ),
      g ? h('p', { class: 'metrics-foot' }, 'Data updated ' + SFN.fmtDay(g.date) + ', ' + SFN.fmtClock(g, true) + ' ET') : null
    );
  }

  function initMetricsToggle() {
    const btn = ui.metricsBtn;
    const panel = ui.metricsPanel;
    const setOpen = (open) => {
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(panel.hidden); });
    document.addEventListener('click', (e) => { if (!panel.hidden && !panel.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { setOpen(false); btn.focus(); } });
  }

  function renderFooter() {
    const g = SFN.timeParts(M.generated);
    ui.footUpdated.textContent = g ? 'Data last updated ' + SFN.fmtDay(g.date) + ', ' + SFN.fmtClock(g, true) + ' ET.' : '';
  }

  /* ---------- filter bar ---------- */
  function buildFilterBar() {
    const st = F().get();
    ui.scopeBtns = {};
    ui.dayChips = {};
    ui.fmtChips = {};
    ui.themeChips = {};

    ui.search = h('input', {
      class: 'search', type: 'search', placeholder: 'Search title, author, keyword, session, room\u2026', 'aria-label': 'Search',
      value: st.q
    });
    let timer;
    ui.search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => F().set({ q: ui.search.value.trim() }), 150);
    });

    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Scope' });
    SFN.SCOPES.forEach((s) => {
      const n = h('span', { class: 'n' });
      const b = h('button', { type: 'button', title: s.title, onclick: () => F().set({ scope: s.id }) }, s.label, n);
      b._n = n;
      ui.scopeBtns[s.id] = b;
      seg.append(b);
    });
    ui.ctxN = h('span', { class: 'n' });
    ui.ctx = h('input', { type: 'checkbox', onchange: (e) => F().set({ ctx: e.target.checked }) });
    const ctxLabel = h('label', { class: 'check', title: 'Talks by non-WashU authors that sit in sessions WashU people chair or moderate' }, ui.ctx, 'Show talks we chair', ui.ctxN);

    const dayGroup = h('div', { class: 'fb-group' }, h('span', { class: 'fb-label' }, 'Day'));
    M.days.forEach((d) => {
      const c = h('button', { type: 'button', class: 'chip', onclick: () => F().toggle('days', d) }, SFN.fmtDay(d, 'short'));
      ui.dayChips[d] = c;
      dayGroup.append(c);
    });

    const fmtGroup = h('div', { class: 'fb-group' }, h('span', { class: 'fb-label' }, 'Format'));
    [['poster', 'Poster'], ['talk', 'Talk'], ['role', 'Chair / roles'], ['event', 'WashU events']].forEach(([id, label]) => {
      const c = h('button', { type: 'button', class: 'chip', onclick: () => F().toggle('fmts', id) }, label);
      ui.fmtChips[id] = c;
      fmtGroup.append(c);
    });

    const themeGroup = h('div', { class: 'fb-group' }, h('span', { class: 'fb-label' }, 'Theme'));
    M.themeLetters.forEach((l) => {
      const c = h('button', { type: 'button', class: 'chip theme', title: themeLabel(l), onclick: () => F().toggle('themes', l) }, l);
      ui.themeChips[l] = c;
      themeGroup.append(c);
    });

    ui.count = h('span', { class: 'fb-count', 'aria-live': 'polite' });
    ui.reset = h('button', { type: 'button', class: 'linkbtn', onclick: () => { ui.search.value = ''; F().reset(); } }, 'Reset filters');

    clear(ui.filterbar);
    ui.filterbar.append(
      h('div', { class: 'fb-row' }, ui.search, h('div', { class: 'fb-group' }, h('span', { class: 'fb-label' }, 'Scope'), seg), ctxLabel),
      h('div', { class: 'fb-row' }, dayGroup, fmtGroup, M.themeLetters.length ? themeGroup : null, h('span', { class: 'fb-spacer' }), ui.count, ui.reset)
    );
  }

  function updateFilterBar() {
    const st = F().get();
    const counts = F().scopeCounts(M.items, st);
    SFN.SCOPES.forEach((s) => {
      ui.scopeBtns[s.id].setAttribute('aria-pressed', String(st.scope === s.id));
      ui.scopeBtns[s.id]._n.textContent = counts[s.id];
    });
    ui.ctx.checked = st.ctx;
    ui.ctxN.textContent = '(' + counts.context + ')';
    Object.entries(ui.dayChips).forEach(([k, c]) => c.setAttribute('aria-pressed', String(st.days.includes(k))));
    Object.entries(ui.fmtChips).forEach(([k, c]) => c.setAttribute('aria-pressed', String(st.fmts.includes(k))));
    Object.entries(ui.themeChips).forEach(([k, c]) => c.setAttribute('aria-pressed', String(st.themes.includes(k))));
    if (document.activeElement !== ui.search && ui.search.value.trim() !== st.q) ui.search.value = st.q;
    const n = F().filter(M.items, st).length;
    ui.count.replaceChildren(h('b', null, n), ' ' + (n === 1 ? 'item' : 'items') + ' shown');
    ui.reset.hidden = F().isDefault(st);
  }

  /* ---------- What's next ---------- */
  function duration(ms) {
    const mins = Math.max(0, Math.round(ms / 60000));
    const d = Math.floor(mins / 1440);
    const hr = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d) return d + 'd ' + hr + 'h ' + m + 'm';
    if (hr) return hr + 'h ' + m + 'm';
    return m + 'm';
  }

  function renderNext() {
    const now = SFN.nowMs();
    const st = F().get();
    const items = F().filter(M.items, st, { ignoreDay: true });
    const body = ui.nextBody;
    clear(body);

    if (SFN.isSimulated()) {
      body.append(h('div', { class: 'banner sim' }, 'Preview mode: showing the page as if it were ' + new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' }) + ' ET. Remove "now" from the URL to return to real time.'));
    }
    if (!items.length) { body.append(h('p', { class: 'empty' }, 'No items match the current filters.')); return; }

    const live = items.filter((i) => i.startMs <= now && now < i.endMs);
    let upcoming = items.filter((i) => i.startMs > now);
    const beforeMeeting = now < M.meetingStartMs;

    if (!live.length && !upcoming.length) {
      body.append(h('div', { class: 'banner' }, h('span', { class: 'big' }, now > M.meetingEndMs ? 'Neuroscience 2026 has wrapped up.' : 'Nothing else scheduled for these filters.'), h('span', null, 'Browse everything in "At a glance" below.')));
      return;
    }

    if (upcoming.length && (beforeMeeting || !live.length)) {
      const first = upcoming[0];
      body.append(h('div', { class: 'banner' },
        h('span', { class: 'big' }, (beforeMeeting ? 'First WashU item in ' : 'Next item in ') + duration(first.startMs - now)),
        h('span', null, whenText(first))));
    }

    if (live.length) {
      body.append(h('h3', { class: 'sub' }, h('span', { class: 'dot-live' }), 'Happening now', h('span', { class: 'n' }, plural(live.length, 'item'))));
      body.append(h('div', { class: 'cards' }, live.slice(0, view.liveShown).map((i) => card(i, true))));
      if (live.length > view.liveShown) {
        body.append(h('div', { class: 'more' }, h('button', { type: 'button', class: 'btn', onclick: () => { view.liveShown += 12; renderNext(); } }, 'Show more happening now (' + (live.length - view.liveShown) + ' left)')));
      }
    }

    if (upcoming.length) {
      let later = 0;
      if (beforeMeeting) {
        const day = upcoming[0].date;
        later = upcoming.filter((i) => i.date !== day).length;
        upcoming = upcoming.filter((i) => i.date === day);
      }
      body.append(h('h3', { class: 'sub' }, beforeMeeting ? 'Opening day: ' + SFN.fmtDay(upcoming[0].date) : 'Up next', h('span', { class: 'n' }, plural(upcoming.length, 'item'))));
      body.append(h('div', { class: 'cards' }, upcoming.slice(0, view.shown).map((i) => card(i, false))));
      const left = upcoming.length - view.shown;
      const more = h('div', { class: 'more' });
      if (left > 0) more.append(h('button', { type: 'button', class: 'btn', onclick: () => { view.shown += 8; renderNext(); } }, 'Show ' + Math.min(8, left) + ' more (' + left + ' left)'));
      if (later) more.append(h('p', { class: 'panel-note' }, plural(later, 'more item') + ' on later days; see "At a glance".'));
      if (more.childNodes.length) body.append(more);
    }
  }

  /* ---------- WashU PIs ---------- */
  function roleBadges(p) {
    const roles = Array.from(new Set(p.items.filter((i) => i.group === 'role').map((i) => i.roleLabel)));
    return roles.map((r) => h('span', { class: 'tag role' }, r));
  }

  function personCard(e) {
    const p = e.p;
    const open = view.peopleOpen.has(p.atlasId) ? view.peopleOpen.get(p.atlasId) : p.isDon;
    const det = h('details', { open: open ? true : null },
      h('summary', null, plural(e.shown.length, 'item') + (e.shown.length !== p.items.length ? ' of ' + p.items.length : '')),
      h('ul', { class: 'mini-list' }, e.shown.map((it) => h('li', null,
        h('span', { class: 'when' }, whenText(it)),
        h('span', null, h('span', { class: 'tag ' + tagClass(it) }, it.kind), ' ',
          it.url ? h('a', { class: 't', href: it.url, target: '_blank', rel: 'noopener' }, it.title) : it.title),
        h('span', { class: 'sub' }, [whereText(it)].filter(Boolean).join(''), it.sessionUrl ? ' \u00b7 ' : '', ext(it.sessionUrl, 'Session'))
      )))
    );
    det.addEventListener('toggle', () => view.peopleOpen.set(p.atlasId, det.open));
    return h('article', { class: 'person' + (p.isDon ? ' don' : '') },
      h('div', { class: 'person-top' }, h('h4', null, p.name), p.isDon && h('span', { class: 'tag don' }, 'DoN'), roleBadges(p)),
      h('div', { class: 'person-meta' }, h('span', null, p.dept), ext(p.lab, 'Lab page'), p.orcid && ext('https://orcid.org/' + encodeURIComponent(p.orcid), 'ORCID'), personIcs(e)),
      det
    );
  }

  const personIcs = (e) => icsLink(e.shown, 'sfn2026-' + slug(e.p.name), 'Neuroscience 2026: ' + e.p.name);

  function todayET() {
    try { return new Date(SFN.nowMs()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); } catch (err) { return ''; }
  }

  /* One row per investigator, one column per meeting day. groups: [{ label, entries }]. */
  function timeline(groups) {
    const today = todayET();
    const head = h('tr', null, h('th', { scope: 'col', class: 'tl-who' }, 'Investigator'),
      M.days.map((d) => h('th', { scope: 'col', class: d === today ? 'tl-today' : null }, SFN.fmtDay(d, 'short'), d === today ? h('span', { class: 'tl-today-tag' }, 'today') : null)));
    const body = h('tbody');
    groups.forEach((g) => {
      if (g.label) body.append(h('tr', { class: 'tl-dept' }, h('th', { colspan: M.days.length + 1, scope: 'colgroup' }, g.label + ' (' + g.entries.length + ')')));
      g.entries.forEach((e) => {
        const p = e.p;
        body.append(h('tr', { class: p.isDon ? 'don' : null },
          h('th', { scope: 'row', class: 'tl-who' },
            h('div', { class: 'tl-name' }, p.name, p.isDon && h('span', { class: 'tag don' }, 'DoN'), roleBadges(p)),
            h('div', { class: 'tl-sub' }, h('span', null, p.dept), ext(p.lab, 'Lab'), personIcs(e))),
          M.days.map((d) => {
            const dayItems = e.shown.filter((i) => i.date === d);
            return h('td', { class: d === today ? 'tl-today' : null }, dayItems.map((it) => {
              const t = SFN.timeParts(it.start);
              const inner = [
                h('span', { class: 'tl-time' }, t ? SFN.fmtClock(t, true) : ''),
                h('span', { class: 'tl-kind' }, it.kind),
                h('span', { class: 'tl-title' }, it.title)
              ];
              const tip = it.title + '\n' + SFN.fmtRange(it.start, it.end) + (whereText(it) ? ' \u00b7 ' + whereText(it) : '');
              return it.url
                ? h('a', { class: 'tl-chip ' + it.group, href: it.url, target: '_blank', rel: 'noopener', title: tip }, inner)
                : h('div', { class: 'tl-chip ' + it.group, title: tip }, inner);
            }));
          })));
      });
    });
    return h('div', { class: 'tl-wrap' }, h('table', { class: 'tl', style: '--days:' + M.days.length }, h('thead', null, head), body));
  }

  function renderPeopleTools() {
    const tools = ui.peopleTools;
    clear(tools);
    const seg = h('div', { class: 'seg seg-sm', role: 'group', 'aria-label': 'Layout' });
    [['timeline', 'Timeline'], ['cards', 'Cards']].forEach(([id, label]) => {
      seg.append(h('button', {
        type: 'button', 'aria-pressed': String(view.peopleMode === id),
        onclick: () => {
          if (view.peopleMode === id) return;
          view.peopleMode = id;
          try { localStorage.setItem('sfn.peopleMode', id); } catch (err) { /* private mode */ }
          renderPeople();
        }
      }, label));
    });
    tools.append(seg);
  }

  function renderPeople() {
    const st = F().get();
    const narrow = F().narrowing(st);
    const entries = M.people
      .map((p) => ({ p, shown: p.items.filter((i) => F().matches(i, st, { ignoreScope: true })) }))
      .filter((e) => !narrow || e.shown.length);
    const don = entries.filter((e) => e.p.isDon);
    const others = entries.filter((e) => !e.p.isDon);
    const body = ui.peopleBody;
    const timelineMode = view.peopleMode === 'timeline';
    renderPeopleTools();
    clear(body);

    if (!entries.length) body.append(h('p', { class: 'empty' }, 'No investigators match the current filters.'));

    const donGroup = h('div', { class: 'people-group' },
      h('h3', null, 'Department of Neuroscience faculty', h('span', { class: 'n' },
        narrow ? plural(don.length, 'matching person', 'matching people') : don.length + (M.donRosterSize ? ' of ' + M.donRosterSize : '') + ' on the program')));
    if (don.length) donGroup.append(timelineMode ? timeline([{ entries: don }]) : h('div', { class: 'people-grid' }, don.map(personCard)));
    else donGroup.append(h('p', { class: 'empty' }, 'No DoN faculty match the current filters.'));

    if (M.notPresenting.length) {
      donGroup.append(h('div', { class: 'toggle-row' },
        h('button', { type: 'button', class: 'linkbtn', 'aria-expanded': String(view.showAbsent), onclick: () => { view.showAbsent = !view.showAbsent; renderPeople(); } },
          (view.showAbsent ? 'Hide' : 'Show') + ' ' + plural(M.notPresenting.length, 'DoN faculty member') + ' with nothing found')));
      if (view.showAbsent) {
        donGroup.append(h('p', { class: 'panel-note' }, 'No presentation was matched to these faculty. The scrape finds trainees by affiliation only, so absence here may be a data gap rather than a true absence.'));
        donGroup.append(h('div', { class: 'absent' }, M.notPresenting.map((p) => h('span', { class: 'pill' }, p.lab ? h('a', { href: p.lab, target: '_blank', rel: 'noopener' }, p.name) : p.name))));
      }
    }
    body.append(donGroup);

    if (others.length) {
      const byDept = new Map();
      others.forEach((e) => { if (!byDept.has(e.p.dept)) byDept.set(e.p.dept, []); byDept.get(e.p.dept).push(e); });
      const depts = Array.from(byDept.keys()).sort((a, b) => (a === 'Neuroscience' ? -1 : b === 'Neuroscience' ? 1 : a.localeCompare(b)));
      const inner = h('div', { class: 'people-group-body' });
      if (timelineMode) {
        inner.append(timeline(depts.map((d) => ({ label: d, entries: byDept.get(d) }))));
      } else {
        depts.forEach((d) => {
          inner.append(h('div', { class: 'dept-h' }, d + ' (' + byDept.get(d).length + ')'));
          inner.append(h('div', { class: 'people-grid' }, byDept.get(d).map(personCard)));
        });
      }
      const det = h('details', { class: 'people-group collapsible', open: view.othersOpen ? true : null },
        h('summary', null, h('h3', null, 'Other WashU investigators', h('span', { class: 'n' }, plural(others.length, 'person', 'people') + ' in ' + plural(depts.length, 'department')))),
        inner);
      det.addEventListener('toggle', () => { view.othersOpen = det.open; });
      body.append(det);
    }
  }

  /* ---------- At a glance ---------- */
  function itemRow(it) {
    return h('article', { class: 'card' + (it.isDon ? ' don' : '') + (it.isEvent ? ' event' : '') },
      h('div', { class: 'card-time' }, SFN.fmtRange(it.start, it.end)),
      tagsFor(it),
      h('h3', { class: 'card-title' }, it.url ? h('a', { href: it.url, target: '_blank', rel: 'noopener' }, it.title) : it.title),
      h('div', { class: 'card-where' }, [whereText(it), it.isEvent ? '' : sessionText(it)].filter(Boolean).join(' \u2014 ')),
      peopleLine(it),
      itemLinks(it, 'card-links'));
  }

  function renderGrid(items, st) {
    const counts = {};
    items.forEach((i) => { const k = i.date + '|' + i.block; (counts[k] = counts[k] || { n: 0, don: 0, items: [] }); counts[k].n++; counts[k].items.push(i); if (i.isDon) counts[k].don++; });
    const max = Math.max(1, ...Object.values(counts).map((c) => c.n));
    const grid = h('div', { class: 'glance-grid', style: '--cols:' + M.days.length, role: 'group', 'aria-label': 'Items by day and time of day' });
    grid.append(h('div'));
    M.days.forEach((d) => grid.append(h('button', { type: 'button', class: 'gg-h' + (st.days.includes(d) ? ' sel' : ''), title: 'Filter to this day', 'aria-pressed': String(st.days.includes(d)), onclick: () => F().toggle('days', d) }, SFN.fmtDay(d, 'short'))));
    SFN.BLOCKS.forEach((b) => {
      grid.append(h('div', { class: 'gg-row' }, b.label, h('small', null, b.hint)));
      M.days.forEach((d) => {
        const key = d + '|' + b.id;
        const c = counts[key];
        if (!c) { grid.append(h('div', { class: 'gg-cell zero', 'aria-label': SFN.fmtDay(d) + ' ' + b.label + ': none' }, h('b', null, '0'))); return; }
        const heat = Math.min(4, Math.max(1, Math.ceil((c.n / max) * 4)));
        grid.append(h('button', {
          type: 'button', class: 'gg-cell heat' + heat + (view.openCell === key ? ' open' : ''), 'aria-expanded': String(view.openCell === key),
          onclick: () => { view.openCell = view.openCell === key ? null : key; renderGlance(); }
        }, h('b', null, c.n), h('span', null, c.don && st.scope !== 'don' ? c.don + ' DoN' : plural(c.n, 'item'))));
      });
    });
    const wrap = h('div', null, grid);
    const open = view.openCell && counts[view.openCell];
    if (open) {
      const [d, bId] = view.openCell.split('|');
      const blk = SFN.BLOCKS.find((b) => b.id === bId);
      wrap.append(h('div', { class: 'cell-panel' },
        h('header', null, h('h3', { class: 'sub' }, SFN.fmtDay(d) + ', ' + blk.label.toLowerCase(), h('span', { class: 'n' }, plural(open.n, 'item'))),
          h('button', { type: 'button', class: 'linkbtn', onclick: () => { view.openCell = null; renderGlance(); } }, 'Close')),
        h('div', { class: 'cards' }, open.items.map(itemRow))));
    }
    return wrap;
  }

  function barCard(title, rows) {
    const max = Math.max(1, ...rows.map((r) => r.n));
    return h('div', { class: 'bar-card' }, h('h4', null, title), rows.map((r) =>
      h('button', { type: 'button', class: 'bar-row' + (r.sel ? ' sel' : ''), 'aria-pressed': String(!!r.sel), title: r.title || null, onclick: r.onclick },
        h('span', null, r.label), h('span', { class: 'bar' }, h('i', { style: 'width:' + Math.round((r.n / max) * 100) + '%' })), h('span', { class: 'v' }, r.n))));
  }

  function renderBars(st) {
    const byDay = F().filter(M.items, st, { ignoreDay: true });
    const byFmt = F().filter(M.items, st, { ignoreFmt: true });
    const byTheme = F().filter(M.items, st, { ignoreTheme: true });
    const dayRows = M.days.map((d) => ({ label: SFN.fmtDay(d, 'short'), n: byDay.filter((i) => i.date === d).length, sel: st.days.includes(d), onclick: () => F().toggle('days', d) }));
    const fmtRows = [['poster', 'Poster'], ['talk', 'Talk'], ['role', 'Roles'], ['event', 'Events']].map(([id, label]) => ({ label, n: byFmt.filter((i) => i.group === id).length, sel: st.fmts.includes(id), onclick: () => F().toggle('fmts', id) }));
    const themeRows = M.themeLetters.map((l) => ({ label: 'Theme ' + l, title: themeLabel(l), n: byTheme.filter((i) => i.themeLetters.includes(l)).length, sel: st.themes.includes(l), onclick: () => F().toggle('themes', l) }));
    return h('div', { class: 'bars' }, barCard('By day', dayRows), barCard('By format', fmtRows), themeRows.length ? barCard('By theme (items can have several)', themeRows) : null);
  }

  const COLUMNS = [
    { key: 'when', label: 'When', val: (i) => i.startMs },
    { key: 'num', label: '#', val: (i) => i.number },
    { key: 'title', label: 'Title', val: (i) => i.title.toLowerCase() },
    { key: 'kind', label: 'Format', val: (i) => i.kind },
    { key: 'session', label: 'Session', val: (i) => i.sessionNumber + ' ' + i.sessionTitle },
    { key: 'where', label: 'Where', val: (i) => i.room + ' ' + i.board },
    { key: 'people', label: 'WashU authors', val: null },
    { key: 'links', label: 'Links', val: null }
  ];

  function sortedItems(items) {
    const col = COLUMNS.find((c) => c.key === view.sort.key) || COLUMNS[0];
    const out = items.slice();
    if (!col.val) return out;
    out.sort((a, b) => {
      const x = col.val(a), y = col.val(b);
      const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return (c || a.startMs - b.startMs) * view.sort.dir;
    });
    return out;
  }

  function detailRow(it) {
    const dl = h('dl', null);
    const add = (k, v) => { if (v && (!Array.isArray(v) || v.length)) dl.append(h('dt', null, k), h('dd', null, v)); };
    add('Session', it.sessionUrl ? [sessionText(it), ' ', ext(it.sessionUrl, 'open')] : sessionText(it));
    add('Presenter', it.presenter);
    add('All authors', it.allAuthors.join('; '));
    add('Themes', it.themes.join(' | '));
    add('Keywords', it.keywords.join(', '));
    if (it.abstract) add('Abstract', h('div', { class: 'abstract' }, it.abstract));
    return h('tr', { class: 'detail' }, h('td', { colspan: COLUMNS.length }, dl));
  }

  function renderTable(items) {
    const rows = sortedItems(items);
    const head = h('tr', null, COLUMNS.map((c) => {
      if (!c.val) return h('th', { scope: 'col' }, c.label);
      const active = view.sort.key === c.key;
      return h('th', { scope: 'col', 'aria-sort': active ? (view.sort.dir === 1 ? 'ascending' : 'descending') : 'none' },
        h('button', { type: 'button', onclick: () => { view.sort = { key: c.key, dir: active ? -view.sort.dir : 1 }; renderGlance(); } },
          c.label, h('span', { class: 'arrow', 'aria-hidden': 'true' }, active ? (view.sort.dir === 1 ? '\u25b2' : '\u25bc') : '\u25b2')));
    }));
    const body = h('tbody');
    rows.forEach((it) => {
      const open = view.expanded.has(it.id);
      body.append(h('tr', { class: it.isDon ? 'don' : it.isEvent ? 'event' : '' },
        h('td', { class: 'when' }, SFN.fmtDay(it.date, 'short'), h('br'), SFN.fmtRange(it.start, it.end)),
        h('td', { class: 'num' }, it.number),
        h('td', null, h('div', { class: 'title' }, it.url ? h('a', { href: it.url, target: '_blank', rel: 'noopener' }, it.title) : it.title,
          h('button', { type: 'button', class: 'row-toggle', 'aria-expanded': String(open), onclick: () => { open ? view.expanded.delete(it.id) : view.expanded.add(it.id); renderGlance(); } }, open ? 'hide details' : 'details'))),
        h('td', null, tagsFor(it)),
        h('td', null, sessionText(it)),
        h('td', null, whereText(it)),
        h('td', null, peopleLine(it)),
        itemLinks(it, 'links', 'td')));
      if (open) body.append(detailRow(it));
    });
    if (!rows.length) body.append(h('tr', null, h('td', { colspan: COLUMNS.length, class: 'empty' }, 'No items match the current filters.')));
    return h('div', { class: 'table-wrap' }, h('table', { class: 'grid' }, h('thead', null, head), body));
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCsv(items) {
    const cols = ['Date', 'Start', 'End', 'Number', 'Title', 'Format', 'Session', 'Room', 'Board', 'WashU authors', 'DoN', 'Abstract link', 'Session link'];
    const lines = [cols.join(',')];
    sortedItems(items).forEach((it) => {
      const s = SFN.timeParts(it.start), e = SFN.timeParts(it.end);
      lines.push([it.date, s ? SFN.fmtClock(s, true) : '', e ? SFN.fmtClock(e, true) : '', it.number, it.title, it.kind, sessionText(it), it.room, it.board,
        it.washu.map((a) => a.name).join('; '), it.isDon ? 'yes' : '', it.url, it.sessionUrl].map(csvCell).join(','));
    });
    download('neuroscience2026-washu.csv', '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  function renderGlance() {
    const st = F().get();
    const items = F().filter(M.items, st);
    const gridItems = F().filter(M.items, st, { ignoreDay: true });
    ui.glanceNote.textContent = plural(items.length, 'item') + ' match the current filters. Click a day, bar or cell to filter or drill in.';
    const body = ui.glanceBody;
    clear(body);
    body.append(renderGrid(gridItems, st), renderBars(st),
      h('div', { class: 'table-tools' }, h('h3', null, 'All items'),
        h('div', { class: 'tools-right' },
          icsLink(sortedItems(items), 'neuroscience2026-washu', 'Neuroscience 2026 (WashU)', 'Add these ' + items.length + ' to calendar (.ics)'),
          h('button', { type: 'button', class: 'btn', onclick: () => downloadCsv(items), disabled: items.length ? null : true }, 'Download CSV (' + items.length + ')'))),
      renderTable(items));
  }

  /* ---------- orchestration ---------- */
  function refresh() {
    view.shown = 8; view.liveShown = 12; // the open grid cell is kept across filter changes
    updateFilterBar();
    renderNext();
    renderPeople();
    renderGlance();
  }

  function init(model) {
    M = model;
    ui.heroMeta = document.getElementById('hero-meta');
    ui.metricsBtn = document.getElementById('metrics-btn');
    ui.metricsPanel = document.getElementById('metrics-panel');
    ui.filterbar = document.getElementById('filterbar');
    ui.footUpdated = document.getElementById('foot-updated');
    ui.nextBody = document.getElementById('next-body');
    ui.peopleBody = document.getElementById('people-body');
    ui.peopleTools = document.getElementById('people-tools');
    ui.glanceBody = document.getElementById('glance-body');
    ui.glanceNote = document.getElementById('glance-note');

    renderHeroMeta();
    renderMetrics();
    initMetricsToggle();
    renderFooter();
    buildFilterBar();
    // Let in-page jumps clear the sticky filter bar (it is static on narrow screens).
    const syncBarHeight = () => {
      const sticky = getComputedStyle(ui.filterbar).position === 'sticky';
      document.documentElement.style.setProperty('--fb-h', (sticky ? ui.filterbar.offsetHeight : 0) + 'px');
    };
    syncBarHeight();
    if (window.ResizeObserver) new ResizeObserver(syncBarHeight).observe(ui.filterbar);
    window.addEventListener('resize', syncBarHeight);
    F().onChange(refresh);
    refresh();
    ['next', 'people', 'glance'].forEach((id) => { document.getElementById(id).hidden = false; });
    setInterval(renderNext, 30000);
  }

  SFN.render = { init, refresh };
})();
