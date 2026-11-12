/* Data loading and normalization. See DATA_CONTRACT.md for the fields relied on. */
(function () {
  'use strict';
  const SFN = (window.SFN = window.SFN || {});

  const FILES = {
    presentations: 'data/presentations.json', // required
    sessions: 'data/sessions.json',           // optional
    people: 'data/people_index.json',         // optional (PIs section degrades without it)
    stats: 'data/stats.json'                  // optional
  };

  /* Scope tiers, mapped from presentation.don_link. Rank 3 ("context") is
     toggled separately and never part of the three scope buttons. */
  const SCOPES = [
    { id: 'don', rank: 0, label: 'DoN', title: 'Items with a Department of Neuroscience faculty author' },
    { id: 'neuro', rank: 1, label: 'WashU Neuroscience', title: 'Adds WashU neuroscience investigators from the Investigator Atlas' },
    { id: 'washu', rank: 2, label: 'All WashU', title: 'Adds every other WashU-authored item' }
  ];
  const TIER_BY_LINK = {
    don: 0,
    washu_neuro_directory: 1,
    washu_probable: 1,
    washu_other: 2,
    session_context: 3
  };
  const CONTEXT_TIER = 3;

  /* Optional: fill in to show names next to theme letters, e.g. { A: 'Development' }.
     Left empty on purpose: names are not in the scraped data. */
  const THEME_NAMES = {};

  /* Joint DoN faculty whose home department is elsewhere are marked is_DoN=false
     in the Atlas scrape. Override here so they appear under DoN. */
  const DON_OVERRIDES = new Set([
    'ATL-000265' // Geoffrey Goodhill
  ]);

  const ROLE_LABELS = {
    'chair': 'Chair',
    'co chair': 'Co-chair',
    'moderator': 'Moderator',
    'satellite organizer': 'Organizer',
    'award winner': 'Award'
  };

  const BLOCKS = [
    { id: 'morning', label: 'Morning', hint: 'before 12 PM', test: (h) => h < 12 },
    { id: 'afternoon', label: 'Afternoon', hint: '12 to 5 PM', test: (h) => h >= 12 && h < 17 },
    { id: 'evening', label: 'Evening', hint: 'after 5 PM', test: (h) => h >= 17 }
  ];

  /* ---------- helpers ---------- */
  async function getJson(url, required) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(url + ' returned HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (required) throw err;
      console.warn('Optional data file unavailable:', url, err);
      return null;
    }
  }

  function safeUrl(u) {
    return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
  }

  function titleCaseToken(tok) {
    return tok.toLowerCase().replace(/(^|[-'\u2019])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }

  function prettyName(raw, person) {
    if (person && person.name) return person.name;
    return String(raw || '')
      .split(/\s+/)
      .map((tok) => (tok.length > 1 && /[A-Z]/.test(tok) && tok === tok.toUpperCase() && !/\.$/.test(tok) ? titleCaseToken(tok) : tok))
      .join(' ');
  }

  function lastName(name) {
    const parts = String(name).replace(/,.*$/, '').trim().split(/\s+/);
    return (parts[parts.length - 1] || '').toLowerCase();
  }

  /* Times are strings like 2026-11-14T13:00:00-05:00 and are shown exactly as
     listed (Eastern), never converted to the viewer's time zone. */
  function timeParts(iso) {
    const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(iso || '');
    return m ? { date: m[1] + '-' + m[2] + '-' + m[3], h: +m[4], m: +m[5] } : null;
  }
  function fmtClock(p, withMeridiem) {
    const h12 = p.h % 12 || 12;
    const mm = String(p.m).padStart(2, '0');
    return h12 + ':' + mm + (withMeridiem ? ' ' + (p.h >= 12 ? 'PM' : 'AM') : '');
  }
  function fmtRange(startIso, endIso) {
    const s = timeParts(startIso);
    const e = timeParts(endIso);
    if (!s) return '';
    if (!e) return fmtClock(s, true);
    if ((s.h >= 12) === (e.h >= 12)) return fmtClock(s, false) + '\u2013' + fmtClock(e, true);
    return fmtClock(s, true) + ' \u2013 ' + fmtClock(e, true);
  }
  function fmtDay(date, style) {
    const d = new Date(date + 'T12:00:00Z');
    if (isNaN(d)) return date;
    if (style === 'short') {
      return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) + ' ' + d.getUTCDate();
    }
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  /* The scraper split theme/topic strings on ";", so rejoin fragments that do
     not start with a code such as "B.07.b." onto the previous entry. */
  function normalizeThemes(list) {
    const out = [];
    (list || []).forEach((t) => {
      const s = String(t).trim();
      if (!s) return;
      if (!out.length || /^[A-Z]\.\d/.test(s)) out.push(s);
      else out[out.length - 1] += '; ' + s;
    });
    return out;
  }

  /* "Now" can be overridden with #now=2026-11-16T14:00 (Eastern) to preview the page. */
  function nowMs() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    const sim = p.get('now');
    if (sim) {
      const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(sim) ? sim : sim + '-05:00';
      const t = Date.parse(iso);
      if (!isNaN(t)) return t;
    }
    return Date.now();
  }
  function isSimulated() {
    return new URLSearchParams(location.hash.replace(/^#/, '')).has('now') && !isNaN(nowMs());
  }

  /* ---------- normalization ---------- */
  function buildPeople(rawPeople, byId, items) {
    const people = new Map();
    (rawPeople || []).forEach((p) => {
      if (!p || !p.atlas_id) return;
      people.set(p.atlas_id, {
        atlasId: p.atlas_id,
        name: p.name || p.full_name_as_listed || p.atlas_id,
        dept: p.department || 'Other',
        isDon: !!(p.is_DoN || DON_OVERRIDES.has(p.atlas_id)),
        lab: safeUrl(p.lab_website),
        orcid: p.orcid || null,
        itemIds: new Set((p.presentation_ids || []).map(String).filter((id) => byId.has(id)))
      });
    });
    // Also credit anyone tagged on an item's WashU author list.
    items.forEach((it) => {
      it.washu.forEach((a) => {
        const person = a.atlasId && people.get(a.atlasId);
        if (person) person.itemIds.add(it.id);
      });
    });
    const list = [];
    people.forEach((p) => {
      p.items = Array.from(p.itemIds).map((id) => byId.get(id)).sort((a, b) => a.startMs - b.startMs || a.number.localeCompare(b.number));
      list.push(p);
    });
    return list;
  }

  function normalize(rawPres, rawSessions, rawPeople, rawStats) {
    const rosterByAtlas = new Map();
    (rawPeople || []).forEach((p) => p && p.atlas_id && rosterByAtlas.set(p.atlas_id, p));
    const sessionById = new Map();
    (rawSessions || []).forEach((s) => s && sessionById.set(String(s.id), s));

    const items = (rawPres || []).map((p) => {
      const sess = p.session || {};
      const sessMeta = sessionById.get(String(sess.id)) || {};
      const format = String(p.format || '').toLowerCase();
      const sessionTitle = sess.title || sessMeta.title || '';
      const sessionType = sess.type || sessMeta.type || '';
      /* Department-hosted socials (e.g. the WashU Neuroscience Reception) often have a
         non-WashU organizer, so the scraper under-tiers them; show them in every scope. */
      const isEvent = (p.don_flags || []).includes('washu_named_session') ||
        (/satellite|ancillary|networking/i.test(sessionType) && /washington univ|washu/i.test(sessionTitle));
      const isRole = !isEvent && Object.prototype.hasOwnProperty.call(ROLE_LABELS, format);
      const group = isEvent ? 'event' : format === 'poster' || p.is_poster ? 'poster' : isRole ? 'role' : 'talk';
      const linkTier = Object.prototype.hasOwnProperty.call(TIER_BY_LINK, p.don_link) ? TIER_BY_LINK[p.don_link] : 2;
      const tier = isEvent ? 0 : linkTier;
      const start = p.start || '';
      const tp = timeParts(start);
      const roleLabel = isRole ? ROLE_LABELS[format] : '';

      let title = (p.title || '').trim();
      if (isEvent) {
        title = sessionTitle || title;
      } else if (isRole && (!title || title.toLowerCase() === roleLabel.toLowerCase() || title.toLowerCase() === format)) {
        title = roleLabel + (sessionTitle ? ': ' + sessionTitle : '');
      }

      let kind;
      if (isEvent) kind = /reception/i.test(sessionTitle) ? 'Reception' : 'WashU event';
      else if (isRole) kind = roleLabel;
      else if (group === 'poster') kind = /late/i.test(p.activity || '') || /late/i.test(sessionType) ? 'Late-breaking poster' : 'Poster';
      else kind = sessionType && !/poster/i.test(sessionType) ? sessionType : 'Talk';

      const presenting = new Set((p.authors || []).filter((a) => a && a.presenting).map((a) => a.name));
      const washu = (p.washu_authors || []).map((a) => {
        const person = a.atlas_id ? rosterByAtlas.get(a.atlas_id) : null;
        return {
          raw: a.name,
          name: prettyName(a.name, person),
          atlasId: a.atlas_id || null,
          isDon: !!(a.is_don_roster || DON_OVERRIDES.has(a.atlas_id) || (person && (person.is_DoN || DON_OVERRIDES.has(person.atlas_id)))),
          isNeuro: !!a.dept_neuroscience,
          presenting: presenting.has(a.name)
        };
      });

      const themes = normalizeThemes(p.theme);
      const themeLetters = Array.from(new Set(themes.map((t) => (/^([A-Z])\./.exec(t) || [])[1]).filter(Boolean)));
      const allAuthors = (p.authors || []).map((a) => a.name).filter(Boolean);
      const keywords = (p.keywords || []).map(String);

      const it = {
        id: String(p.id),
        number: p.presentation_number || '',
        title,
        kind,
        group,
        roleLabel,
        scope: tier === 0 ? 'don' : tier === 1 ? 'neuro' : tier === 2 ? 'washu' : 'context',
        tier,
        isDon: linkTier === 0 && !isEvent,
        isEvent,
        start,
        end: p.end || '',
        startMs: Date.parse(start) || 0,
        endMs: Date.parse(p.end || start) || 0,
        date: p.date || (tp && tp.date) || '',
        hour: tp ? tp.h : 0,
        block: (BLOCKS.find((b) => tp && b.test(tp.h)) || BLOCKS[0]).id,
        room: p.room || sess.location || sessMeta.location || '',
        board: p.posterboard || '',
        sessionNumber: sess.number || sessMeta.number || '',
        sessionTitle,
        sessionType,
        url: safeUrl(p.url),
        sessionUrl: safeUrl(p.session_url || sess.url || sessMeta.url),
        washu,
        presenter: p.presenter || '',
        presenterIsWashu: !!p.presenter_is_washu,
        themes,
        themeLetters,
        keywords,
        allAuthors,
        abstract: p.abstract || (isEvent ? sessMeta.description || '' : '')
      };
      it.haystack = [
        it.title, it.number, it.presenter, it.sessionTitle, it.sessionNumber, it.room, it.kind,
        it.washu.map((a) => a.name + ' ' + a.raw).join(' '),
        allAuthors.join(' '), keywords.join(' ')
      ].join(' \u0001 ').toLowerCase();
      return it;
    });

    items.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.number.localeCompare(b.number, undefined, { numeric: true }));
    const byId = new Map(items.map((i) => [i.id, i]));

    const people = buildPeople(rawPeople, byId, items);
    const presenting = people.filter((p) => p.items.length > 0);
    presenting.sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));
    const notPresenting = people.filter((p) => p.isDon && p.items.length === 0).sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));

    const days = Array.from(new Set(items.map((i) => i.date).filter(Boolean))).sort();
    const letters = Array.from(new Set(items.flatMap((i) => i.themeLetters))).sort();

    return {
      items,
      byId,
      people: presenting,
      notPresenting,
      donRosterSize: people.filter((p) => p.isDon).length,
      days,
      themeLetters: letters,
      generated: (rawStats && rawStats.generated) || null,
      meetingStartMs: items.length ? Math.min(...items.map((i) => i.startMs)) : 0,
      meetingEndMs: items.length ? Math.max(...items.map((i) => i.endMs)) : 0
    };
  }

  async function load() {
    const [pres, sess, ppl, stats] = await Promise.all([
      getJson(FILES.presentations, true),
      getJson(FILES.sessions),
      getJson(FILES.people),
      getJson(FILES.stats)
    ]);
    if (!Array.isArray(pres)) throw new Error('presentations.json must be a JSON array.');
    return normalize(pres, Array.isArray(sess) ? sess : [], Array.isArray(ppl) ? ppl : [], stats || {});
  }

  Object.assign(SFN, {
    load, normalize, SCOPES, CONTEXT_TIER, THEME_NAMES, BLOCKS,
    nowMs, isSimulated, fmtRange, fmtDay, fmtClock, timeParts
  });
})();
