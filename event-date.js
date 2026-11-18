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
    resolveParts: imResolveEvent_, normalizeSettings: imNormalizeSettings_, label: imLabel_
  };
})(typeof window !== 'undefined' ? window : globalThis);
