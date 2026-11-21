// In-memory stand-in for the Google services apps-script/Code.gs uses (Sheets, Mail, Properties, clock),
// so the real script can run in Node: unit tests (tests/apps-script.test.mjs) and the browser check
// (tests/browser/reveal.mjs) both use it.
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
// 'yyyy-MM-dd HH:mm[:ss]' in a zone → Date (search the two possible offsets), like Utilities.parseDate.
function parseDate(s, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) throw new Error('parse');
  for (const off of [4, 5]) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + off, +m[5], +(m[6] || 0)));
    if (fmt(d, tz, m[6] ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd HH:mm') === s) return d;
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

export function makeEnv({ now, settings, legacyRows, lineups } = {}) {
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
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => ({ DOOR_PIN: '1234', PREVIEW_KEY: 'preview-secret-key' })[k] || null }) },
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
  if (lineups) lineups.forEach((r) => sheets.Lineups.appendRow(r));   // rows in LINEUP_HEADERS order
  const post = (body) => ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  const rsvp = (email, first = 'Ana') => post({ first, email, phone: '3055550123' });
  return { ctx, sheets, sent, post, rsvp, setNow: (iso) => { clock = new RealDate(iso).getTime(); } };
}

