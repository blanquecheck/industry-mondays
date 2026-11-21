// Industry Mondays: which night the site is showing, worked out in Miami time (America/New_York).
// The block between the BEGIN/END markers is copied byte for byte into apps-script/Code.gs, so the site and
// the RSVP emails always pick the same date. tests/event-date.test.mjs fails if the two copies differ.
(function (root) {
  // ==== BEGIN SHARED EVENT DATE RULE (keep identical in event-date.js and apps-script/Code.gs) ====
  // Rule: the event is every Monday, 9 PM to 3 AM. A Monday's date shows until 3:00 AM Tuesday (Miami time),
  // then the next Monday. A "Next date override" replaces that date until its own night ends (3 AM the next day).
  // "Skip this week" marks that date as off; RSVPs then go to the Monday after it.
  var IM_TZ = 'America/New_York';
  var IM_DEFAULTS = { venue: 'Astra', address: '2121 NW Second Ave, Miami, FL 33127', time: '9 PM–3 AM', note: '' };
  var IM_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var IM_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function imPad_(n) { return (n < 10 ? '0' : '') + n; }

  // Calendar arithmetic on plain dates (no time zone involved): 'YYYY-MM-DD' strings.
  function imYmd_(y, m, d) {
    var t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() + '-' + imPad_(t.getUTCMonth() + 1) + '-' + imPad_(t.getUTCDate());
  }
  function imParts_(ymd) { return [+ymd.slice(0, 4), +ymd.slice(5, 7), +ymd.slice(8, 10)]; }
  function imAddDays_(ymd, n) { var p = imParts_(ymd); return imYmd_(p[0], p[1], p[2] + n); }
  function imWeekday_(ymd) { var p = imParts_(ymd); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); }
  function imNextMondayAfter_(ymd) { return imAddDays_(ymd, ((8 - imWeekday_(ymd)) % 7) || 7); }
  function imLabel_(ymd) { var p = imParts_(ymd); return IM_DAYS[imWeekday_(ymd)] + ', ' + IM_MONTHS[p[1] - 1] + ' ' + p[2]; }

  // ny = Miami wall-clock time { y, m, d, hh, mi }. The night of `ymd` is still on until 3:00 AM the next day.
  function imStillOn_(ymd, ny) {
    var today = imYmd_(ny.y, ny.m, ny.d);
    return today <= ymd || (today === imAddDays_(ymd, 1) && ny.hh < 3);
  }
  function imAutoDate_(ny) {
    var today = imYmd_(ny.y, ny.m, ny.d), wd = imWeekday_(today);
    if (wd === 1) return today;                                 // Monday: tonight
    if (wd === 2 && ny.hh < 3) return imAddDays_(today, -1);    // Tuesday before 3 AM: still Monday night
    return imNextMondayAfter_(today);
  }

  // Accepts 'YYYY-MM-DD', 'M/D/YYYY' or 'M/D/YY'. Anything else (or an impossible date) counts as blank.
  function imNormalizeDate_(v) {
    var s = String(v == null ? '' : v).trim(), m, y, mo, d;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) { mo = +m[1]; d = +m[2]; y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; }
    else return '';
    var out = imYmd_(y, mo, d);
    return out === y + '-' + imPad_(mo) + '-' + imPad_(d) ? out : '';
  }

  function imNormalizeSettings_(raw) {
    raw = raw || {};
    var text = function (v, fallback) { var s = String(v == null ? '' : v).trim(); return s || fallback; };
    return {
      venue: text(raw.venue, IM_DEFAULTS.venue),
      address: text(raw.address, IM_DEFAULTS.address),
      time: text(raw.time, IM_DEFAULTS.time),
      overrideDate: imNormalizeDate_(raw.overrideDate),
      skip: raw.skip === true || /^(y|yes|true|1|x|skip)$/i.test(String(raw.skip == null ? '' : raw.skip).trim()),
      note: text(raw.note, '')
    };
  }

  // The one function both sides call. Returns the night to show and the night new RSVPs are for.
  function imResolveEvent_(ny, raw) {
    var s = imNormalizeSettings_(raw), date, source;
    if (s.overrideDate && imStillOn_(s.overrideDate, ny)) { date = s.overrideDate; source = 'override'; }
    else { date = imAutoDate_(ny); source = 'auto'; }
    var next = imNextMondayAfter_(date), rsvp = s.skip ? next : date;
    return {
      date: date, label: imLabel_(date), source: source, skipped: s.skip,
      nextDate: next, nextLabel: imLabel_(next),
      rsvpDate: rsvp, rsvpLabel: imLabel_(rsvp),
      settings: s
    };
  }

  // ---- Weekly lineup reveal: LOCKED (countdown) from the rollover until Wednesday 12:00 PM ET, then REVEAL. ----
  // Reveal time is the Wednesday before the event date at 12:00 PM Miami time, unless a lineup row sets its own.
  function imNowKey_(ny) { return imYmd_(ny.y, ny.m, ny.d) + ' ' + imPad_(ny.hh) + ':' + imPad_(ny.mi); }
  function imDefaultRevealKey_(ymd) { var wd = imWeekday_(ymd); return imAddDays_(ymd, -((((wd - 3) % 7) + 7) % 7 || 7)) + ' 12:00'; }

  // 'YYYY-MM-DD HH:mm', 'YYYY-MM-DDTHH:mm' or 'M/D/YYYY h:mm PM' → 'YYYY-MM-DD HH:mm' (Miami wall clock), else ''.
  function imNormalizeDateTime_(v) {
    var s = String(v == null ? '' : v).trim(), m = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4})[ T]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/.exec(s);
    if (!m) return '';
    var d = imNormalizeDate_(m[1]), h = +m[2], mi = +m[3];
    if (m[4]) { if (h < 1 || h > 12) return ''; h = h % 12 + (/p/i.test(m[4]) ? 12 : 0); }
    return d && h <= 23 && mi <= 59 ? d + ' ' + imPad_(h) + ':' + imPad_(mi) : '';
  }

  // ev from imResolveEvent_. Skip weeks keep the old behaviour: no countdown, no reveal.
  function imPhase_(ny, ev, revealOverride) {
    if (ev.skipped) return { phase: 'skip', revealKey: '' };
    var key = imNormalizeDateTime_(revealOverride) || imDefaultRevealKey_(ev.date);
    return { phase: imNowKey_(ny) < key ? 'locked' : 'reveal', revealKey: key };
  }

  // Flyer themes. Colour overrides are hex; any colour that would be hard to read on the background is replaced.
  var IM_THEMES = {
    'classic': { bg: '#12061A', accent: '#FF6BD0', text: '#F4EEE3', second: '#3FD3A0' },
    'red-gold': { bg: '#1C0708', accent: '#E9B949', text: '#F7EBDD', second: '#FF7A66' },
    'purple-haze': { bg: '#150A26', accent: '#B58CFF', text: '#EEE7FF', second: '#7FE3FF' },
    'all-white': { bg: '#F6F4EF', accent: '#141414', text: '#141414', second: '#1D6B4C' },
    'neon-green': { bg: '#050B07', accent: '#39FF88', text: '#EAFBEF', second: '#FFE14D' },
    'black-chrome': { bg: '#0A0A0B', accent: '#D7DBE0', text: '#F2F3F5', second: '#9AA4B2' }
  };
  function imHex_(v) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v == null ? '' : v).trim()), h;
    if (!m) return '';
    h = m[1].length === 3 ? m[1].replace(/(.)/g, '$1$1') : m[1];
    return '#' + h.toUpperCase();
  }
  function imLum_(hex) {
    var c = [1, 3, 5].map(function (i) { var v = parseInt(hex.substr(i, 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function imContrast_(a, b) { var x = imLum_(a), y = imLum_(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function imResolveTheme_(name, over) {
    over = over || {};
    var key = String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, '-');
    if (!IM_THEMES[key]) key = 'classic';
    var p = IM_THEMES[key];
    var t = { name: key, bg: imHex_(over.background) || p.bg, accent: imHex_(over.accent) || p.accent, text: imHex_(over.text) || p.text, second: p.second };
    var ok = function (c) { return imContrast_(c, t.bg) >= 4.5; };
    var plain = imLum_(t.bg) > 0.4 ? '#141414' : '#F4EEE3';
    if (!ok(t.text)) t.text = ok(p.text) ? p.text : plain;
    if (!ok(t.accent)) t.accent = ok(p.accent) ? p.accent : t.text;
    if (!ok(t.second)) t.second = t.accent;
    return t;
  }

  // Up to four { role, name } pairs; rows without a name are dropped. Never returns an empty-name entry.
  function imNormalizeLineup_(raw) {
    var out = [];
    (raw || []).forEach(function (x) {
      var name = String(x && x.name != null ? x.name : '').trim().slice(0, 48);
      if (name && out.length < 4) out.push({ role: String(x.role == null ? '' : x.role).trim().slice(0, 24), name: name });
    });
    return out;
  }
  // ==== END SHARED EVENT DATE RULE ====

  // Miami wall-clock parts for an instant, from the browser's time zone data.
  var fmt = null;
  function nyParts(date) {
    fmt = fmt || new Intl.DateTimeFormat('en-US', { timeZone: IM_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    var o = {};
    fmt.formatToParts(date).forEach(function (p) { o[p.type] = p.value; });
    return { y: +o.year, m: +o.month, d: +o.day, hh: (+o.hour) % 24, mi: +o.minute };
  }

  root.IMEvent = {
    TZ: IM_TZ, DEFAULTS: IM_DEFAULTS, nyParts: nyParts,
    resolve: function (date, settings) { return imResolveEvent_(nyParts(date || new Date()), settings); },
    resolveParts: imResolveEvent_, normalizeSettings: imNormalizeSettings_, label: imLabel_,
    // Lineup reveal
    phase: function (date, ev, revealOverride) { return imPhase_(nyParts(date || new Date()), ev, revealOverride); },
    phaseParts: imPhase_, theme: imResolveTheme_, themes: IM_THEMES, lineup: imNormalizeLineup_, contrast: imContrast_,
    // Miami wall-clock 'YYYY-MM-DD HH:mm' → the real instant (DST-safe: tries both offsets).
    instant: function (key) {
      var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(key || '');
      if (!m) return null;
      for (var off = 4; off <= 5; off++) {
        var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + off, +m[5]));
        if (imNowKey_(nyParts(d)) === key) return d;
      }
      return null;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
