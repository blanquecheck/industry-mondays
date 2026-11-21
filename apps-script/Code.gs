/**
 * Industry Mondays — RSVP backend (Google Apps Script, bound to the "Industry Mondays RSVPs" Google Sheet).
 *
 * The website posts each RSVP here; this script adds one row to the "RSVPs" tab, emails a confirmation with a
 * check-in QR code, and (on a daily timer) emails a morning-of reminder. The site also reads the "Settings" tab
 * from here (GET ?action=event), so the page and the emails always name the same night.
 *
 * Which night: every Monday, 9 PM–3 AM Miami time. A Monday shows until 3:00 AM Tuesday, then the next Monday.
 * The "Settings" tab can change the venue, address, time text, set a one-off date, skip a week, or add a note.
 * The date rule sits between the BEGIN/END SHARED EVENT DATE RULE markers and is identical to the site's
 * event-date.js (the repo's tests check that).
 *
 * Set up / update: see apps-script/README.md in the industry-mondays repo. In short:
 *   1. Paste this whole file over Code.gs → Save → run `setup` once (adds the Settings tab and any missing
 *      RSVP columns; nothing is deleted or moved).
 *   2. Run `installReminderTrigger` once (daily reminder at 10–11 AM Miami time).
 *   3. Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy, so the /exec URL stays the same.
 * Check-in codes (QR in the email, scanned at the door on industrymondays.com/door/):
 *   - Run `setDoorPin` once after editing the PIN inside it. Door staff type that PIN once on their phone.
 *   - Run `assignMissingCodes` once to give codes to anyone who RSVP'd before codes existed.
 */

var TAB = 'RSVPs';
var SETTINGS_TAB = 'Settings';
// RSVP columns, found by their header text (so a reordered or extended tab still works). Missing ones are added
// at the right-hand end by setup() and on the first RSVP.
var HEADERS = [
  'Submitted (NY time)', 'First name', 'Last name', 'Email', 'Mobile', 'Instagram', 'Industry role', 'Works at',
  'Email updates', 'Text updates', 'Text consent wording', 'RSVP count for this email',
  'Referral code', 'UTM source', 'UTM medium', 'UTM campaign', 'Page', 'Browser',
  'Check-in code', 'Checked in (NY time)',
  'Event date', 'Confirmation sent', 'Reminded'
];
var H = {
  submitted: 'Submitted (NY time)', first: 'First name', last: 'Last name', email: 'Email', mobile: 'Mobile',
  instagram: 'Instagram', role: 'Industry role', works: 'Works at', emailOpt: 'Email updates', smsOpt: 'Text updates',
  smsText: 'Text consent wording', count: 'RSVP count for this email', ref: 'Referral code', utmSource: 'UTM source',
  utmMedium: 'UTM medium', utmCampaign: 'UTM campaign', page: 'Page', browser: 'Browser', code: 'Check-in code',
  checkedIn: 'Checked in (NY time)', eventDate: 'Event date', confirmed: 'Confirmation sent', reminded: 'Reminded'
};
// Settings tab: label in column A, value in column B, help in column C. Rows are found by label.
var SETTINGS_ROWS = [
  ['Venue name', 'venue', 'Astra', 'Shown on the site and in every email.'],
  ['Venue address', 'address', '2121 NW Second Ave, Miami, FL 33127', 'Street, City, State ZIP. Used for directions too.'],
  ['Event time', 'time', '9 PM–3 AM', 'Display text only. The night always rolls over at 3 AM Tuesday.'],
  ['Next date override', 'overrideDate', '', 'Blank = automatic (next Monday). A date here is used until its night ends.'],
  ['Skip this week', 'skip', 'No', 'Yes = "No event this Monday — back [next date]". Set back to No afterwards.'],
  ['Note', 'note', '', 'Optional one-liner shown on the site and in emails. Blank = hidden.']
];
// Lineups tab: one row per event date, filled ahead of time. Names are sent to the site only after the reveal.
var LINEUPS_TAB = 'Lineups';
var LINEUP_HEADERS = ['Event date', 'Theme', 'Background', 'Accent', 'Text',
  'Role 1', 'Name 1', 'Role 2', 'Name 2', 'Role 3', 'Name 3', 'Role 4', 'Name 4', 'Reveal override'];
var DOOR_URL = 'https://industrymondays.com/door/#';   // the QR opens this page with the guest's code
var SITE = 'https://industrymondays.com/';

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(IM_TZ);
  var sh = ss.getSheetByName(TAB) || ss.insertSheet(TAB, 0);
  var c = cols_(sh);
  sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(1, c[H.mobile], sh.getMaxRows(), 1).setNumberFormat('@');      // keep phone numbers as text
  sh.getRange(1, c[H.eventDate], sh.getMaxRows(), 1).setNumberFormat('@');   // keep 2026-11-23 as text
  setupSettings_(ss);
  setupLineups_(ss);
}

// Adds the Lineups tab with its header row, a theme dropdown and date formats. Existing rows are never touched.
function setupLineups_(ss) {
  var sh = ss.getSheetByName(LINEUPS_TAB) || ss.insertSheet(LINEUPS_TAB);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, LINEUP_HEADERS.length).setValues([LINEUP_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  var n = Math.max(sh.getMaxRows() - 1, 1);
  sh.getRange(2, 1, n, 1).setNumberFormat('yyyy-mm-dd');
  sh.getRange(2, 2, n, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.keys(IM_THEMES), true).setAllowInvalid(false).build());
  sh.getRange(2, 14, n, 1).setNumberFormat('yyyy-mm-dd hh:mm');
}

// The Lineups row for an event date → { theme, lineup, revealOverride } (raw), or null when there is no row.
function readLineup_(ymd) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LINEUPS_TAB);
  if (!sh || sh.getLastRow() < 2) return null;
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var col = function (name) { return head.indexOf(name.toLowerCase()); };
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i], get = function (name) { var c = col(name); return c < 0 ? '' : r[c]; };
    if (ymdCell_(get('Event date')) !== ymd) continue;
    var names = [];
    for (var k = 1; k <= 4; k++) names.push({ role: get('Role ' + k), name: get('Name ' + k) });
    var ro = get('Reveal override');
    return {
      theme: imResolveTheme_(get('Theme'), { background: get('Background'), accent: get('Accent'), text: get('Text') }),
      lineup: imNormalizeLineup_(names),
      revealOverride: ro instanceof Date ? Utilities.formatDate(ro, IM_TZ, 'yyyy-MM-dd HH:mm') : ro
    };
  }
  return null;
}

// Everything the site and the RSVP lock need right now: event, phase, reveal instant, theme, lineup.
function currentState_(date) {
  var now = date || new Date(), ny = imNyPartsGs_(now), raw = {};
  try { raw = readSettings_(); } catch (x) {}
  var ev = imResolveEvent_(ny, raw), row = null;
  try { row = readLineup_(ev.date); } catch (x) {}
  var ph = imPhase_(ny, ev, row ? row.revealOverride : '');
  var revealAt = ph.revealKey ? Utilities.parseDate(ph.revealKey, IM_TZ, 'yyyy-MM-dd HH:mm') : null;
  return { ev: ev, phase: ph.phase, revealKey: ph.revealKey, revealAt: revealAt, row: row };
}

// Owner preview of the reveal before noon: ?preview=reveal&key=<PREVIEW_KEY>. Edit the key below, then run once.
function setPreviewKey() {
  var KEY = 'CHANGE-ME';
  if (KEY === 'CHANGE-ME' || KEY.length < 8) throw new Error('Type a preview key of at least 8 characters in setPreviewKey first.');
  PropertiesService.getScriptProperties().setProperty('PREVIEW_KEY', KEY);
  Logger.log('Preview key saved. Preview link: https://industrymondays.com/?preview=reveal&key=<your key>');
}

function previewOk_(p) {
  if (!p || p.preview !== 'reveal' || !p.key) return false;
  var want = PropertiesService.getScriptProperties().getProperty('PREVIEW_KEY');
  if (!want || String(p.key).length !== want.length) return false;
  var diff = 0;                                         // compare every character, so timing doesn't hint at the key
  for (var i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ String(p.key).charCodeAt(i);
  return diff === 0;
}

// Adds the Settings tab, or any of its rows that are missing. Existing values are never overwritten.
function setupSettings_(ss) {
  var sh = ss.getSheetByName(SETTINGS_TAB) || ss.insertSheet(SETTINGS_TAB);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, 3).setValues([['Setting', 'Value', 'How it works']]).setFontWeight('bold');
  var have = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { have[String(r[0]).trim()] = true; });
  SETTINGS_ROWS.forEach(function (row) {
    if (have[row[0]]) return;
    sh.appendRow([row[0], row[2], row[3]]);
    var r = sh.getLastRow();
    if (row[1] === 'overrideDate') sh.getRange(r, 2).setNumberFormat('yyyy-mm-dd')
      .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
    if (row[1] === 'skip') sh.getRange(r, 2).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['No', 'Yes'], true).build());
  });
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 170); sh.setColumnWidth(2, 300); sh.setColumnWidth(3, 520);
}

// Reads the Settings tab into { venue, address, time, overrideDate, skip, note } (raw; IM normalizes it).
function readSettings_() {
  var out = {};
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SETTINGS_TAB);
  if (!sh || sh.getLastRow() < 2) return out;
  var keys = {};
  SETTINGS_ROWS.forEach(function (r) { keys[r[0].toLowerCase()] = r[1]; });
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    var key = keys[String(r[0]).trim().toLowerCase()];
    if (!key) return;
    var v = r[1];
    if (v instanceof Date) v = Utilities.formatDate(v, IM_TZ, 'yyyy-MM-dd');
    out[key] = v;
  });
  return out;
}

// Miami wall-clock parts for an instant, from Apps Script's own time zone data.
function imNyPartsGs_(date) {
  var p = Utilities.formatDate(date, IM_TZ, 'yyyy-MM-dd-HH-mm').split('-');
  return { y: +p[0], m: +p[1], d: +p[2], hh: +p[3], mi: +p[4] };
}

// The night as of now (or `date`), with the Settings tab applied. If the tab can't be read, the automatic date.
function currentEvent_(date) {
  var raw = {};
  try { raw = readSettings_(); } catch (x) {}
  return imResolveEvent_(imNyPartsGs_(date || new Date()), raw);
}

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

// Map header text → column number on the RSVPs tab, adding any missing HEADERS at the right-hand end.
function cols_(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var row = sh.getRange(1, 1, 1, lastCol).getValues()[0], map = {}, used = 0;
  row.forEach(function (h, i) { var t = String(h).trim(); if (t) { map[t] = i + 1; used = i + 1; } });
  var missing = HEADERS.filter(function (h) { return !map[h]; });
  if (missing.length) {
    sh.getRange(1, used + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    missing.forEach(function (h, i) { map[h] = used + 1 + i; });
  }
  return map;
}

function rows_(sh, c) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var width = Math.max(sh.getLastColumn(), c[H.reminded]);
  return sh.getRange(2, 1, n, width).getValues();
}

// A sheet cell holding an event date (text or a real date) → 'YYYY-MM-DD'.
function ymdCell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, IM_TZ, 'yyyy-MM-dd');
  return imNormalizeDate_(v);
}

function stamp_() { return Utilities.formatDate(new Date(), IM_TZ, 'yyyy-MM-dd HH:mm:ss'); }

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var d = parse_(e);
    if (d.action === 'checkin' || d.action === 'pin') return json_(checkin_(d));
    if (d.company) return json_({ ok: true });            // honeypot: bots fill the hidden field; drop quietly
    var first = clean_(d.first, 60), last = clean_(d.last, 60);
    var email = clean_(d.email, 120).toLowerCase();
    var phone = digits_(d.phone);
    if (!first) return json_({ ok: false, error: 'first' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json_({ ok: false, error: 'email' });
    if (phone.length < 10 || phone.length > 15) return json_({ ok: false, error: 'phone' });

    var state = currentState_(), ev = state.ev;         // RSVPs are for ev.rsvpDate (the Monday after a skip)
    if (state.phase === 'locked') return json_({ ok: false, error: 'locked', message: 'RSVP opens Wednesday 12PM ET' });
    lock.waitLock(10000);
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB);
    if (!sh) { setup(); sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB); }
    var c = cols_(sh);
    var prior = 0, priorThisNight = 0, code = '';
    rows_(sh, c).forEach(function (r) {
      if (String(r[c[H.email] - 1]).toLowerCase() !== email) return;
      prior++;
      if (!code && r[c[H.code] - 1]) code = String(r[c[H.code] - 1]);
      if (ymdCell_(r[c[H.eventDate] - 1]) === ev.rsvpDate) priorThisNight++;
    });
    if (!code) code = newCode_(sh, c);                  // repeat RSVPs keep the same code
    var v = {};
    v[H.submitted] = stamp_();
    v[H.first] = first; v[H.last] = last; v[H.email] = email; v[H.mobile] = formatPhone_(phone);
    v[H.instagram] = clean_(d.instagram, 40).replace(/^@+/, '');
    v[H.role] = clean_(d.role, 60); v[H.works] = clean_(d.workplace, 80);
    v[H.emailOpt] = d.email_opt === true || d.email_opt === 'yes' ? 'Yes' : 'No';
    v[H.smsOpt] = d.sms_opt === true || d.sms_opt === 'yes' ? 'Yes' : 'No';
    v[H.smsText] = d.sms_opt === true || d.sms_opt === 'yes' ? clean_(d.sms_text, 400) : '';
    v[H.count] = prior + 1;
    v[H.ref] = clean_(d.ref, 40); v[H.utmSource] = clean_(d.utm_source, 60); v[H.utmMedium] = clean_(d.utm_medium, 60);
    v[H.utmCampaign] = clean_(d.utm_campaign, 60); v[H.page] = clean_(d.page, 200); v[H.browser] = clean_(d.ua, 200);
    v[H.code] = code; v[H.checkedIn] = ''; v[H.eventDate] = ev.rsvpDate; v[H.confirmed] = ''; v[H.reminded] = '';
    var width = Math.max(sh.getLastColumn(), c[H.reminded]), row = [];
    for (var i = 1; i <= width; i++) row.push('');
    Object.keys(v).forEach(function (h) { row[c[h] - 1] = v[h]; });
    sh.appendRow(row);
    var at = sh.getLastRow();
    if (priorThisNight === 0) {                         // first RSVP from this email for this night: confirm once
      var sent = '';
      try { sendConfirmation_(first, email, code, ev); sent = stamp_(); } catch (x) { sent = 'Failed: ' + String(x).slice(0, 80); }
      sh.getRange(at, c[H.confirmed]).setValue(sent);   // a mail error never blocks the RSVP
    } else {
      sh.getRange(at, c[H.confirmed]).setValue('Already sent for this date');
    }
    return json_({ ok: true, returning: prior > 0, event: { date: ev.rsvpDate, label: ev.rsvpLabel } });
  } catch (err) {
    return json_({ ok: false, error: 'server' });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

// GET ?action=event → what the website shows right now. Anything else: a health check.
// Lineup names are included only once the reveal time has passed in Miami time (or with a valid preview key);
// the theme colours may be sent during the countdown, the names never are.
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'event') {
    var st = currentState_(), ev = st.ev, s = ev.settings, preview = previewOk_(p);
    var open = st.phase === 'reveal' || preview;
    return json_({
      ok: true, now: new Date().toISOString(),
      settings: { venue: s.venue, address: s.address, time: s.time, overrideDate: s.overrideDate, skip: s.skip ? 'Yes' : 'No', note: s.note },
      event: { date: ev.date, label: ev.label, skipped: ev.skipped, nextDate: ev.nextDate, rsvpDate: ev.rsvpDate, source: ev.source },
      phase: preview && st.phase === 'locked' ? 'reveal' : st.phase,
      preview: preview,
      revealAt: st.revealAt ? st.revealAt.toISOString() : null,
      theme: st.row ? st.row.theme : null,
      lineup: open && st.row ? st.row.lineup : []
    });
  }
  return json_({ ok: true, service: 'industry-mondays-rsvp' });
}

// ---------- Event details for emails ----------

function eventInfo_(ev, ymd) {
  var s = ev.settings, date = ymd || ev.rsvpDate, end = imAddDays_(date, 1);
  var where = s.venue + ', ' + s.address;
  return {
    name: 'Industry Mondays',
    presenter: 'The Industry Mixer',
    date: imLabel_(date),
    ymd: date,
    time: s.time,
    venue: s.venue,
    address: s.address,
    note: s.note,
    maps: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(where),
    site: SITE,
    // Google Calendar link in Miami time: that date 9 PM to 3 AM the next day (ctz keeps it right across DST).
    calendar: 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
      '&text=' + encodeURIComponent('Industry Mondays at ' + s.venue) +
      '&dates=' + date.replace(/-/g, '') + 'T210000/' + end.replace(/-/g, '') + 'T030000' +
      '&ctz=' + encodeURIComponent(IM_TZ) +
      '&location=' + encodeURIComponent(where) +
      '&details=' + encodeURIComponent('Happy hour is free with your RSVP. ' + SITE)
  };
}

// ---------- Confirmation email ----------
// Sent from the Google account that owns this script (its Gmail address is the sender and gets any replies).
// Consumer Gmail accounts can send about 100 emails a day (confirmations and reminders together).

function sendConfirmation_(first, email, code, ev) {
  var E = eventInfo_(ev || currentEvent_());
  MailApp.sendEmail({
    to: email,
    name: E.name,
    subject: "You're on the list: " + E.name + ', ' + E.date,
    body: emailText_(first, code, E, 'confirm'),
    htmlBody: emailHtml_(first, code, E, 'confirm'),
    inlineImages: { qr: qrPng_(DOOR_URL + code) }
  });
}

// ---------- Morning-of reminder ----------
// Run daily by the trigger from installReminderTrigger(). Sends only when today is the event date, never on a
// skip week, and only to RSVPs saved for today's date. Each email gets one reminder; the "Reminded" column
// records it, so a second run the same day sends nothing new.

function sendReminders() {
  var ev = currentEvent_();
  var today = Utilities.formatDate(new Date(), IM_TZ, 'yyyy-MM-dd');
  if (ev.skipped) { Logger.log('Skip week (' + ev.date + '): no reminders.'); return 0; }
  if (ev.date !== today) { Logger.log('No event today (' + today + '); next is ' + ev.date + '.'); return 0; }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB);
    if (!sh) return 0;
    var c = cols_(sh), rows = rows_(sh, c), E = eventInfo_(ev, today), done = {}, sent = 0;
    rows.forEach(function (r) { if (r[c[H.reminded] - 1] && ymdCell_(r[c[H.eventDate] - 1]) === today) done[String(r[c[H.email] - 1]).toLowerCase()] = true; });
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], email = String(r[c[H.email] - 1]).toLowerCase();
      if (ymdCell_(r[c[H.eventDate] - 1]) !== today || r[c[H.reminded] - 1] || !email) continue;
      if (done[email]) { sh.getRange(i + 2, c[H.reminded]).setValue('Already reminded'); continue; }
      if (MailApp.getRemainingDailyQuota() < 1) { Logger.log('Mail quota used up; stopping.'); break; }
      var mark;
      try {
        MailApp.sendEmail({
          to: email, name: E.name,
          subject: 'Tonight: ' + E.name + ' at ' + E.venue + ', ' + E.time,
          body: emailText_(String(r[c[H.first] - 1]), String(r[c[H.code] - 1]), E, 'remind'),
          htmlBody: emailHtml_(String(r[c[H.first] - 1]), String(r[c[H.code] - 1]), E, 'remind'),
          inlineImages: { qr: qrPng_(DOOR_URL + String(r[c[H.code] - 1])) }
        });
        mark = stamp_(); sent++;
      } catch (x) { mark = 'Failed: ' + String(x).slice(0, 80); }
      sh.getRange(i + 2, c[H.reminded]).setValue(mark);
      done[email] = true;
    }
    Logger.log('Reminders sent for ' + today + ': ' + sent + '. Mail left today: ' + MailApp.getRemainingDailyQuota());
    return sent;
  } finally { lock.releaseLock(); }
}

// Run once: a daily trigger for sendReminders between 10 and 11 AM Miami time (replaces any earlier one).
function installReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendReminders').timeBased().everyDays(1).atHour(10).inTimezone(IM_TZ).create();
  Logger.log('Daily reminder trigger installed (10–11 AM ' + IM_TZ + ').');
}

// Run from the editor: what the site and the emails show right now.
function showCurrentEvent() {
  var ev = currentEvent_();
  Logger.log(JSON.stringify({ showing: ev.label, date: ev.date, source: ev.source, skipped: ev.skipped, rsvpsGoTo: ev.rsvpLabel, settings: ev.settings }, null, 2));
}

// Run from the editor to email yourself a test confirmation and a test reminder for the current night.
function testConfirmation() {
  var me = Session.getEffectiveUser().getEmail(), ev = currentEvent_(), E = eventInfo_(ev);
  sendConfirmation_('Jay', me, 'IM-TEST00', ev);   // a test code: the door page answers "test code", nothing is marked
  MailApp.sendEmail({ to: me, name: E.name, subject: '[Test] Tonight: ' + E.name + ' at ' + E.venue + ', ' + E.time,
    body: emailText_('Jay', 'IM-TEST00', E, 'remind'), htmlBody: emailHtml_('Jay', 'IM-TEST00', E, 'remind'),
    inlineImages: { qr: qrPng_(DOOR_URL + 'IM-TEST00') } });
  Logger.log('Test confirmation and reminder sent to ' + me + ' for ' + E.date + '. Mail left today: ' + MailApp.getRemainingDailyQuota());
}

function emailText_(first, code, E, kind) {
  var intro = kind === 'remind'
    ? "It's tonight: " + E.name + ' at ' + E.venue + '.'
    : "You're on the list for " + E.name + ' at ' + E.venue + '.';
  return 'Hi ' + first + ',\n\n' + intro + '\n\n' +
    'Your check-in code: ' + code + '\nShow the QR code in this email (or this code) at the door.\n\n' +
    E.date + ' · ' + E.time + '\n' + E.venue + ', ' + E.address + '\n' + (E.note ? '\n' + E.note + '\n' : '') + '\n' +
    'Happy hour is free with your RSVP.\n\n' +
    'Directions: ' + E.maps + '\nAdd to calendar: ' + E.calendar + '\n\n' +
    'See you there.\n' + E.presenter + '\n' + E.site;
}

function emailHtml_(first, code, E, kind) {
  var esc = function (t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var mono = "font-family:'IBM Plex Mono',Menlo,Consolas,monospace;";
  var sans = "font-family:'Archivo','Arial Black',Arial,Helvetica,sans-serif;";
  var btn = 'display:inline-block;margin:0 10px 10px 0;padding:14px 22px;border-radius:999px;text-decoration:none;' + mono +
    'font-size:13px;letter-spacing:2px;text-transform:uppercase;font-weight:600;';
  var hello = kind === 'remind' ? 'Hi ' + esc(first) + ", it's tonight." : 'Hi ' + esc(first) + ", you're on the list.";
  return '' +
  '<div style="margin:0;padding:0;background:#12061A;">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#12061A;"><tr><td align="center" style="padding:32px 16px;">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#1C0B27;border:1px solid #6B2C5C;border-radius:20px;">' +
  '<tr><td style="padding:36px 32px 8px;">' +
    '<p style="margin:0;' + mono + 'font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#FF6BD0;">' + esc(E.presenter) + ' presents</p>' +
    '<h1 style="margin:14px 0 0;' + sans + 'font-weight:900;font-size:40px;line-height:0.95;text-transform:uppercase;color:#F4EEE3;">Industry<br>Mondays</h1>' +
  '</td></tr>' +
  '<tr><td style="padding:24px 32px 0;">' +
    '<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.5;color:#F4EEE3;">' + hello + '</p>' +
    '<p style="margin:10px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.5;color:#F4EEE3;">Happy hour is <strong style="color:#3FD3A0;">free with your RSVP</strong>.</p>' +
  '</td></tr>' +
  '<tr><td style="padding:24px 32px 0;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4EEE3;border-radius:16px;"><tr><td align="center" style="padding:22px 20px 18px;">' +
      '<img src="cid:qr" width="200" height="200" alt="Check-in QR code ' + esc(code) + '" style="display:block;width:200px;height:200px;border:0;">' +
      '<p style="margin:12px 0 0;' + mono + 'font-size:20px;letter-spacing:4px;font-weight:600;color:#12061A;">' + esc(code) + '</p>' +
      '<p style="margin:6px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;color:#4A3A52;">Show this at the door to check in.</p>' +
    '</td></tr></table>' +
  '</td></tr>' +
  '<tr><td style="padding:24px 32px 0;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #4A2346;border-bottom:1px solid #4A2346;"><tr><td style="padding:18px 0;">' +
      '<p style="margin:0;' + sans + 'font-weight:900;font-size:24px;text-transform:uppercase;color:#F4EEE3;">' + esc(E.date) + '</p>' +
      '<p style="margin:6px 0 0;' + mono + 'font-size:15px;letter-spacing:2px;color:#3FD3A0;">' + esc(E.time) + '</p>' +
      '<p style="margin:16px 0 0;' + sans + 'font-weight:900;font-size:24px;text-transform:uppercase;color:#F4EEE3;">' + esc(E.venue) + '</p>' +
      '<p style="margin:6px 0 0;' + mono + 'font-size:14px;line-height:1.6;color:#CFC6D3;">' + esc(E.address) + '</p>' +
      (E.note ? '<p style="margin:14px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#F4EEE3;">' + esc(E.note) + '</p>' : '') +
    '</td></tr></table>' +
  '</td></tr>' +
  '<tr><td style="padding:24px 32px 0;">' +
    '<a href="' + E.calendar + '" style="' + btn + 'background:#FF6BD0;color:#12061A;">Add to calendar</a>' +
    '<a href="' + E.maps + '" style="' + btn + 'background:transparent;color:#3FD3A0;border:1.5px solid #3FD3A0;">Directions</a>' +
  '</td></tr>' +
  '<tr><td style="padding:18px 32px 32px;">' +
    '<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#CFC6D3;">House, Afrobeats, Disco and Open Format. See you there.</p>' +
    '<p style="margin:14px 0 0;' + mono + 'font-size:12px;letter-spacing:2px;text-transform:uppercase;"><a href="' + E.site + '" style="color:#FF6BD0;text-decoration:none;">industrymondays.com</a></p>' +
  '</td></tr>' +
  '</table>' +
  '</td></tr></table>' +
  '</div>';
}

// ---------- Door check-in ----------
// The door page posts { action: 'checkin', pin, code } (or { action: 'pin', pin } to test the PIN).
// Codes stay the same for a guest every week, so check-in marks the row for tonight's date if there is one,
// otherwise the guest's most recent RSVP.

function checkin_(d) {
  var pin = PropertiesService.getScriptProperties().getProperty('DOOR_PIN');
  if (!pin || String(d.pin || '') !== pin) { Utilities.sleep(800); return { ok: false, error: 'pin' }; }
  if (d.action === 'pin') return { ok: true };
  var code = String(d.code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (code === 'IM-TEST00') return { ok: true, status: 'test', code: code };
  var tonight = currentEvent_().date;
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB);
    var c = cols_(sh), rows = rows_(sh, c), pick = -1;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][c[H.code] - 1]).toUpperCase() !== code) continue;
      if (pick < 0 || ymdCell_(rows[pick][c[H.eventDate] - 1]) !== tonight) pick = i;   // tonight's row wins, else the latest
    }
    if (pick < 0) return { ok: true, status: 'unknown', code: code };
    var r = rows[pick], lastName = String(r[c[H.last] - 1] || '');
    var name = (r[c[H.first] - 1] + ' ' + lastName.slice(0, 1) + (lastName ? '.' : '')).trim();
    if (r[c[H.checkedIn] - 1]) return { ok: true, status: 'already', code: code, name: name, at: timeOnly_(r[c[H.checkedIn] - 1]) };
    var now = stamp_();
    sh.getRange(pick + 2, c[H.checkedIn]).setValue(now);
    return { ok: true, status: 'in', code: code, name: name, at: timeOnly_(now) };
  } finally { lock.releaseLock(); }
}

// 'yyyy-MM-dd HH:mm:ss' text written in Miami time (or a real date) → a Date. Right in summer and winter.
function nyStamp_(v) {
  if (v instanceof Date) return v;
  try { return Utilities.parseDate(String(v), IM_TZ, 'yyyy-MM-dd HH:mm:ss'); } catch (x) { return new Date(NaN); }
}

function timeOnly_(v) {
  return Utilities.formatDate(nyStamp_(v), IM_TZ, 'h:mm a');
}

// Edit the PIN below, then run this once. Share the PIN only with door staff.
function setDoorPin() {
  var PIN = 'CHANGE-ME';
  if (PIN === 'CHANGE-ME' || PIN.length < 4) throw new Error('Type a PIN of at least 4 characters in setDoorPin first.');
  PropertiesService.getScriptProperties().setProperty('DOOR_PIN', PIN);
  Logger.log('Door PIN saved.');
}

// Gives a check-in code to every row that doesn't have one (same email = same code). Sends no email.
function assignMissingCodes() {
  setup();
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB);
  var c = cols_(sh), rows = rows_(sh, c), byEmail = {}, added = 0;
  rows.forEach(function (r) { if (r[c[H.code] - 1]) byEmail[String(r[c[H.email] - 1]).toLowerCase()] = r[c[H.code] - 1]; });
  rows.forEach(function (r, i) {
    if (r[c[H.code] - 1]) return;
    var key = String(r[c[H.email] - 1]).toLowerCase();
    var code = byEmail[key] || newCode_(sh, c);
    byEmail[key] = code;
    sh.getRange(i + 2, c[H.code]).setValue(code);
    added++;
  });
  Logger.log('Codes added: ' + added);
}

// Fills "Event date" on rows saved before this column existed, from when they were submitted (automatic rule;
// a skip or override that was active back then isn't known). Run once after updating. Sends no email.
function backfillEventDates() {
  setup();
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB);
  var c = cols_(sh), rows = rows_(sh, c), filled = 0;
  rows.forEach(function (r, i) {
    if (r[c[H.eventDate] - 1]) return;
    var when = nyStamp_(r[c[H.submitted] - 1]);
    if (isNaN(when.getTime())) return;
    sh.getRange(i + 2, c[H.eventDate]).setValue(imResolveEvent_(imNyPartsGs_(when), {}).date);
    filled++;
  });
  Logger.log('Event dates filled: ' + filled);
}

// Emails the confirmation (with QR) to RSVPs for the upcoming night that have none recorded yet. Sends at most
// one per email address.
function sendMissingConfirmations() {
  var ev = currentEvent_();
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB);
  var c = cols_(sh), rows = rows_(sh, c), sent = {}, count = 0;
  rows.forEach(function (r, i) {
    var email = String(r[c[H.email] - 1]).toLowerCase(), code = r[c[H.code] - 1];
    if (!email || !code || r[c[H.confirmed] - 1] || ymdCell_(r[c[H.eventDate] - 1]) !== ev.rsvpDate) return;
    if (sent[email]) { sh.getRange(i + 2, c[H.confirmed]).setValue('Already sent for this date'); return; }
    sent[email] = true;
    var mark;
    try { sendConfirmation_(String(r[c[H.first] - 1]), email, String(code), ev); mark = stamp_(); count++; }
    catch (x) { mark = 'Failed: ' + String(x).slice(0, 80); }
    sh.getRange(i + 2, c[H.confirmed]).setValue(mark);
  });
  Logger.log('Confirmations sent: ' + count + '. Mail left today: ' + MailApp.getRemainingDailyQuota());
}

// IM- plus 6 characters, leaving out look-alikes (0/O, 1/I/L), unique within the sheet.
function newCode_(sh, c) {
  var ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ', taken = {};
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, c[H.code], sh.getLastRow() - 1, 1).getValues().forEach(function (r) { taken[String(r[0])] = true; });
  }
  for (var t = 0; t < 50; t++) {
    var code = 'IM-';
    for (var i = 0; i < 6; i++) code += ABC.charAt(Math.floor(Math.random() * ABC.length));
    if (!taken[code]) return code;
  }
  throw new Error('code');
}

// ---------- QR code as a PNG (no outside service) ----------
// Uses qrcode-generator (MIT, bundled at the bottom of this file) for the pattern, then writes an uncompressed PNG.

function qrPng_(text) {
  var qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  var n = qr.getModuleCount(), scale = 10, quiet = 4, size = (n + quiet * 2) * scale;
  var raw = [];
  for (var y = 0; y < size; y++) {
    raw.push(0);                                        // filter: none
    var my = Math.floor(y / scale) - quiet;
    for (var x = 0; x < size; x++) {
      var mx = Math.floor(x / scale) - quiet;
      var dark = my >= 0 && my < n && mx >= 0 && mx < n && qr.isDark(my, mx);
      raw.push(dark ? 0 : 255);
    }
  }
  var ihdr = [].concat(u32_(size), u32_(size), [8, 0, 0, 0, 0]);   // 8-bit greyscale
  var png = [137, 80, 78, 71, 13, 10, 26, 10]
    .concat(chunk_('IHDR', ihdr), chunk_('IDAT', zlibStored_(raw)), chunk_('IEND', []));
  return Utilities.newBlob(png.map(function (b) { return b > 127 ? b - 256 : b; }), 'image/png', 'checkin-qr.png');
}

function u32_(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }

function chunk_(type, data) {
  var t = type.split('').map(function (c) { return c.charCodeAt(0); });
  return u32_(data.length).concat(t, data, u32_(crc32_(t.concat(data))));
}

var CRC_TABLE_;
function crc32_(bytes) {
  if (!CRC_TABLE_) {
    CRC_TABLE_ = [];
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE_[n] = c >>> 0; }
  }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE_[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// zlib stream with "stored" (uncompressed) deflate blocks; simple and valid for any PNG reader.
function zlibStored_(data) {
  var out = [0x78, 0x01], a = 1, b = 0;
  for (var i = 0; i < data.length; i += 65535) {
    var len = Math.min(65535, data.length - i), last = i + len >= data.length ? 1 : 0;
    out.push(last, len & 255, len >>> 8, ~len & 255, (~len >>> 8) & 255);
    for (var j = 0; j < len; j++) { var v = data[i + j]; out.push(v); a = (a + v) % 65521; b = (b + a) % 65521; }
  }
  return out.concat(u32_(((b << 16) | a) >>> 0));
}

function parse_(e) {
  if (e && e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (x) {}
  }
  return (e && e.parameter) || {};
}

// Strip leading characters that make a spreadsheet treat a cell as a formula.
function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().replace(/^[=+\-@]+/, '').slice(0, max);
}

function digits_(v) {
  var s = String(v == null ? '' : v).replace(/\D/g, '');
  return s.length === 10 ? '1' + s : s;   // US 10-digit numbers get the country code
}

// The leading apostrophe keeps Sheets from reading "+1 ..." as a formula (#ERROR!); it doesn't show in the cell.
function formatPhone_(d) {
  return "'" + (d.length === 11 && d[0] === '1'
    ? '+1 (' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7)
    : '+' + d);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}


// ===================== Bundled library: qrcode-generator 1.4.4 (MIT, Kazuhiko Arase) =====================
//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\u0020width="';
      img += size;
      img += '"';
      img += '\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '██': '█',
        '█ ': '▀',
        ' █': '▄',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '██': '▀',
        '█ ': '▀',
        ' █': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '█';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '█';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('██');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(row * cellSize, col * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();

(function (factory) {
  if (typeof define === 'function' && define.amd) {
      define([], factory);
  } else if (typeof exports === 'object') {
      module.exports = factory();
  }
}(function () {
    return qrcode;
}));
