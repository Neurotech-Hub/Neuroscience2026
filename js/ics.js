/* iCalendar (.ics) export for one or more items. */
(function () {
  'use strict';
  const SFN = (window.SFN = window.SFN || {});

  const pad = (n) => String(n).padStart(2, '0');
  function utc(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([;,])/g, '\\$1');
  }
  /* RFC 5545: lines longer than 75 octets are folded with CRLF + space. */
  const enc = new TextEncoder();
  function fold(line) {
    if (enc.encode(line).length <= 75) return line;
    const parts = [];
    let cur = '';
    let len = 0;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (len + b > (parts.length ? 74 : 75)) { parts.push(cur); cur = ''; len = 0; }
      cur += ch;
      len += b;
    }
    parts.push(cur);
    return parts.join('\r\n ');
  }

  function event(it, stamp) {
    if (!it.startMs) return [];
    const where = [it.room, it.board && 'Board ' + it.board].filter(Boolean).join(', ');
    const session = [it.sessionNumber, it.sessionTitle].filter(Boolean).join(' ');
    const desc = [
      it.kind + (it.number ? ' ' + it.number : ''),
      session && 'Session: ' + session,
      it.washu.length && 'WashU: ' + it.washu.map((a) => a.name).join(', '),
      it.url && 'Abstract: ' + it.url,
      it.sessionUrl && 'Session link: ' + it.sessionUrl
    ].filter(Boolean).join('\n');
    return [
      'BEGIN:VEVENT',
      'UID:sfn2026-' + it.id + '@neuroscience.wustl.edu',
      'DTSTAMP:' + stamp,
      'DTSTART:' + utc(it.startMs),
      'DTEND:' + utc(it.endMs > it.startMs ? it.endMs : it.startMs + 3600000),
      'SUMMARY:' + esc(it.title + ' (' + it.kind + ')'),
      where && 'LOCATION:' + esc(where),
      'DESCRIPTION:' + esc(desc),
      it.url && 'URL:' + it.url,
      'END:VEVENT'
    ].filter(Boolean);
  }

  function build(items, calName) {
    const stamp = utc(Date.now());
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//WashU Department of Neuroscience//Neuroscience 2026//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:' + esc(calName || 'Neuroscience 2026'),
      'X-WR-TIMEZONE:America/New_York'
    ];
    items.forEach((it) => lines.push(...event(it, stamp)));
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  SFN.ics = { build };
})();
