// Run: node --test tests/
// Runs apps-script/Code.gs against an in-memory stand-in for Google Sheets, Mail and the clock, to check the
// RSVP → event date → confirmation → reminder flow without a Google account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const GS_SRC = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

function fmt(date, tz, pattern) {
  const o = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).forEach((p) => { o[p.type] = p.value; });
  const h24 = +o.hour % 24, h12 = h24 % 12 || 12;
  return pattern.replace('yyyy', o.year).replace('MM', o.month).replace('dd', o.day).replace('HH', String(h24).padStart(2, '0'))
    .replace('h:', h12 + ':').replace('mm', o.minute).replace('ss', o.second).replace(' a', h24 < 12 ? ' AM' : ' PM');
}
// 'yyyy-MM-dd HH:mm:ss' in a zone → Date (search the two possible offsets).
function parseDate(s, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  for (const off of [4, 5]) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + off, +m[5], +m[6]));
    if (fmt(d, tz, 'yyyy-MM-dd HH:mm:ss') === s) return d;
  }
  throw new Error('parse');
}

class Range {
  constructor(sh, r, c, nr = 1, nc = 1) { Object.assign(this, { sh, r, c, nr, nc }); }
  getValues() { return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => this.sh.get(this.r + i, this.c + j))); }
  setValues(v) { v.forEach((row, i) => row.forEach((x, j) => this.sh.set(this.r + i, this.c + j, x))); return this; }
  setValue(x) { this.sh.set(this.r, this.c, x); return this; }
  setFontWeight() { return this; } setNumberFormat() { return this; } setDataValidation() { return this; }
}
class Sheet {
  constructor(name) { this.name = name; this.cells = []; }
  get(r, c) { return (this.cells[r - 1] || [])[c - 1] ?? ''; }
  set(r, c, x) { (this.cells[r - 1] ||= [])[c - 1] = x; }
  getLastRow() { return this.cells.length; }
  getLastColumn() { return this.cells.reduce((m, row) => Math.max(m, row ? row.length : 0), 0); }
  getMaxRows() { return 1000; }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
  appendRow(v) { this.cells.push([...v]); }
  setFrozenRows() {} setColumnWidth() {}
  header() { return this.cells[0]; }
  col(name) { return this.header().indexOf(name) + 1; }
  rows() { return this.cells.slice(1).map((r) => Object.fromEntries(this.header().map((h, i) => [h, r[i] ?? '']))); }
}

function makeEnv({ now, settings, legacyRows } = {}) {
  const sheets = {};
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new Sheet(n)),
    setSpreadsheetTimeZone() {},
  };
  const sent = [];
  let clock = new Date(now || '2026-11-22T20:00:00Z').getTime();
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(clock); }
    static now() { return clock; }
  }
  const dv = { requireDate() { return dv; }, setAllowInvalid() { return dv; }, requireValueInList() { return dv; }, build() { return {}; } };
  const ctx = vm.createContext({
    Date: FakeDate, Intl, Math, JSON, String, Object, Array, Number, RegExp, isNaN, encodeURIComponent,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, newDataValidation: () => dv },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    MailApp: { sendEmail: (m) => sent.push(m), getRemainingDailyQuota: () => 100 },
    Utilities: { formatDate: fmt, parseDate, newBlob: () => ({}), sleep() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => '1234' }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => JSON.parse(s) }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
    Logger: { log() {} },
  });
  vm.runInContext(GS_SRC, ctx);
  if (legacyRows) {                                   // a tab in today's 20-column layout, with an old RSVP
    const sh = ss.insertSheet('RSVPs');
    sh.appendRow(ctx.HEADERS.slice(0, 20));
    legacyRows.forEach((r) => sh.appendRow(r));
  }
  ctx.setup();
  if (settings) {
    const st = sheets.Settings;
    st.cells.forEach((row, i) => { if (i && settings[row[0]] !== undefined) row[1] = typeof settings[row[0]] === 'function' ? settings[row[0]](ctx) : settings[row[0]]; });
  }
  const post = (body) => ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  const rsvp = (email, first = 'Ana') => post({ first, email, phone: '3055550123' });
  return { ctx, sheets, sent, post, rsvp, setNow: (iso) => { clock = new RealDate(iso).getTime(); } };
}

test('setup adds the Settings tab and the three new RSVP columns to an existing 20-column tab', () => {
  const legacy = ['2026-11-02 12:00:00', 'Old', 'Guest', 'old@example.com', '+1 (305) 555-0000', '', '', '', 'No', 'No', '', 1, '', '', '', '', '', '', 'IM-AAAAAA', ''];
  const env = makeEnv({ legacyRows: [legacy] });
  const sh = env.sheets.RSVPs;
  assert.deepEqual(sh.header().slice(20), ['Event date', 'Confirmation sent', 'Reminded']);
  assert.equal(sh.rows()[0]['Check-in code'], 'IM-AAAAAA');           // nothing moved
  assert.deepEqual(env.sheets.Settings.cells.map((r) => r[0]),
    ['Setting', 'Venue name', 'Venue address', 'Event time', 'Next date override', 'Skip this week', 'Note']);
  env.ctx.backfillEventDates();
  assert.equal(sh.rows()[0]['Event date'], '2026-11-02');            // submitted Mon Nov 2, noon
});

test('an RSVP stores the event date and the confirmation names that date, time and venue', () => {
  const env = makeEnv({ now: '2026-11-22T20:00:00Z' });              // Sun Nov 22, 3 PM
  const res = env.rsvp('ana@example.com');
  assert.deepEqual({ ...res.event }, { date: '2026-11-23', label: 'Monday, Nov 23' });
  const row = env.sheets.RSVPs.rows()[0];
  assert.equal(row['Event date'], '2026-11-23');
  assert.match(String(row['Confirmation sent']), /^2026-11-22 15:00/);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].subject, "You're on the list: Industry Mondays, Monday, Nov 23");
  assert.match(env.sent[0].body, /Monday, Nov 23 · 9 PM–3 AM\nAstra, 2121 NW Second Ave, Miami, FL 33127/);
  assert.match(env.sent[0].body, /dates=20261123T210000\/20261124T030000&ctz=America%2FNew_York/);
});

test('one confirmation per email per date; a new week gets a new one', () => {
  const env = makeEnv({ now: '2026-11-22T20:00:00Z' });
  env.rsvp('ana@example.com'); env.rsvp('ANA@example.com');
  assert.equal(env.sent.length, 1);
  assert.equal(env.sheets.RSVPs.rows()[1]['Confirmation sent'], 'Already sent for this date');
  env.setNow('2026-11-24T08:00:00Z');                                 // Tue 3 AM: now for Nov 30
  const res = env.rsvp('ana@example.com');
  assert.equal(res.event.date, '2026-11-30');
  assert.equal(env.sent.length, 2);
  assert.match(env.sent[1].subject, /Monday, Nov 30$/);
  const codes = new Set(env.sheets.RSVPs.rows().map((r) => r['Check-in code']));
  assert.equal(codes.size, 1);                                       // same guest keeps one code
});

test('Settings tab: venue, time, note and override flow into the RSVP and email', () => {
  const env = makeEnv({ now: '2026-11-24T15:00:00Z', settings: {
    'Venue name': 'Club Nova', 'Venue address': '100 Biscayne Blvd, Miami, FL 33132', 'Event time': '10 PM–3 AM',
    'Next date override': (ctx) => vm.runInContext("new Date('2026-11-27T12:00:00Z')", ctx), 'Note': 'Thanksgiving weekend special' } });
  const res = env.rsvp('ana@example.com');
  assert.equal(res.event.date, '2026-11-27');
  assert.match(env.sent[0].body, /Friday, Nov 27 · 10 PM–3 AM\nClub Nova, 100 Biscayne Blvd, Miami, FL 33132\n\nThanksgiving weekend special/);
  const got = env.ctx.doGet({ parameter: { action: 'event' } });
  assert.equal(got.settings.overrideDate, '2026-11-27');
  assert.equal(got.event.label, 'Friday, Nov 27');
});

test('skip week: the page data says skipped, RSVPs and confirmations go to the Monday after', () => {
  const env = makeEnv({ now: '2026-11-23T15:00:00Z', settings: { 'Skip this week': 'Yes' } });
  const got = env.ctx.doGet({ parameter: { action: 'event' } });
  assert.equal(got.event.skipped, true); assert.equal(got.event.date, '2026-11-23'); assert.equal(got.event.rsvpDate, '2026-11-30');
  const res = env.rsvp('ana@example.com');
  assert.equal(res.event.label, 'Monday, Nov 30');
  assert.equal(env.sheets.RSVPs.rows()[0]['Event date'], '2026-11-30');
});

test('reminders: only on the event date, only that date’s RSVPs, once each, never on a skip week', () => {
  const env = makeEnv({ now: '2026-11-22T20:00:00Z' });              // Sun: RSVPs for Nov 23
  env.rsvp('ana@example.com', 'Ana'); env.rsvp('ben@example.com', 'Ben'); env.rsvp('ana@example.com', 'Ana');
  env.setNow('2026-11-24T08:00:00Z');                                 // Tue 3 AM: an RSVP for Nov 30
  env.rsvp('cy@example.com', 'Cy');
  env.sent.length = 0;

  env.setNow('2026-11-22T15:30:00Z');                                 // Sun 10:30 AM: no event today
  assert.equal(env.ctx.sendReminders(), 0);
  env.setNow('2026-11-23T15:30:00Z');                                 // Mon Nov 23, 10:30 AM
  assert.equal(env.ctx.sendReminders(), 2);
  assert.deepEqual(env.sent.map((m) => m.to).sort(), ['ana@example.com', 'ben@example.com']);
  assert.equal(env.sent[0].subject, 'Tonight: Industry Mondays at Astra, 9 PM–3 AM');
  assert.match(env.sent[0].body, /It's tonight/);
  assert.equal(env.ctx.sendReminders(), 0);                           // a second run sends nothing new
  const rows = env.sheets.RSVPs.rows();
  assert.equal(rows.filter((r) => r['Event date'] === '2026-11-23' && r.Reminded).length, 3);
  assert.equal(rows.find((r) => r.Email === 'cy@example.com').Reminded, '');

  const skip = makeEnv({ now: '2026-11-22T20:00:00Z' });
  skip.rsvp('ana@example.com');
  skip.sheets.Settings.cells.forEach((r) => { if (r[0] === 'Skip this week') r[1] = 'Yes'; });
  skip.sent.length = 0;
  skip.setNow('2026-11-23T15:30:00Z');
  assert.equal(skip.ctx.sendReminders(), 0);
  assert.equal(skip.sent.length, 0);
});

test('door check-in marks tonight’s row for a guest who RSVP’d in earlier weeks', () => {
  const env = makeEnv({ now: '2026-11-16T15:00:00Z' });              // Mon Nov 16
  env.rsvp('ana@example.com');
  const code = env.sheets.RSVPs.rows()[0]['Check-in code'];
  env.setNow('2026-11-17T04:00:00Z');                                 // Mon Nov 16, 11 PM: check in
  assert.equal(env.post({ action: 'checkin', pin: '1234', code }).status, 'in');
  env.setNow('2026-11-22T20:00:00Z');                                 // next week's RSVP
  env.rsvp('ana@example.com');
  env.setNow('2026-11-24T03:00:00Z');                                 // Mon Nov 23, 10 PM
  const res = env.post({ action: 'checkin', pin: '1234', code });
  assert.equal(res.status, 'in');                                     // not "already" from last week
  assert.equal(res.at, '10:00 PM');
  const rows = env.sheets.RSVPs.rows();
  assert.ok(rows[0]['Checked in (NY time)'] && rows[1]['Checked in (NY time)']);
});

test('if the Settings tab is missing, the script falls back to the automatic date and defaults', () => {
  const env = makeEnv({ now: '2026-11-24T08:00:00Z' });
  delete env.sheets.Settings;
  const got = env.ctx.doGet({ parameter: { action: 'event' } });
  assert.equal(got.event.date, '2026-11-30');
  assert.equal(got.settings.venue, 'Astra');
});
