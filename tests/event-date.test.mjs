// Run: node --test tests/
// Checks the "which Monday" rule, and that the website (event-date.js) and the RSVP emails
// (apps-script/Code.gs) give the same answer for the same moment and the same Settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SITE_SRC = read('event-date.js');
const GS_SRC = read('apps-script/Code.gs');

// The site file, as the browser runs it.
const siteCtx = vm.createContext({ Intl, Date, window: {} });
vm.runInContext(SITE_SRC, siteCtx);
const site = siteCtx.window.IMEvent;

// The Apps Script file, with the one Google service the date rule touches (Utilities.formatDate) stood in by
// the same IANA time zone data. Everything else in the file is only defined, not run.
function formatDate(date, tz, pattern) {
  const o = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).forEach((p) => { o[p.type] = p.value; });
  return pattern.replace('yyyy', o.year).replace('MM', o.month).replace('dd', o.day)
    .replace('HH', String(+o.hour % 24).padStart(2, '0')).replace('mm', o.minute).replace('ss', o.second);
}
const gsCtx = vm.createContext({ Intl, Date, Utilities: { formatDate } });
vm.runInContext(GS_SRC, gsCtx);
const script = (date, settings) => gsCtx.imResolveEvent_(gsCtx.imNyPartsGs_(date), settings || {});
const web = (date, settings) => site.resolve(date, settings || {});

// Both sides, asserting they agree, then returning one result.
function both(iso, settings) {
  const at = new Date(iso), a = web(at, settings), b = script(at, settings);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), `site and script differ at ${iso}`);
  return a;
}

test('the date rule is the same code in the site and the Apps Script', () => {
  const block = (src) => {
    const lines = src.split('\n');
    const i = lines.findIndex((l) => l.includes('==== BEGIN SHARED EVENT DATE RULE'));
    const j = lines.findIndex((l) => l.includes('==== END SHARED EVENT DATE RULE'));
    assert.ok(i >= 0 && j > i, 'markers present');
    const indent = lines[i].match(/^\s*/)[0].length;
    return lines.slice(i, j + 1).map((l) => l.slice(Math.min(indent, l.match(/^\s*/)[0].length))).join('\n');
  };
  assert.equal(block(SITE_SRC), block(GS_SRC));
});

// November 2026 is EST (UTC-5); DST ended Sunday Nov 1, 2026. Times below are Miami wall clock → UTC.
test('Sunday afternoon → the next day, Monday', () => {
  const ev = both('2026-11-22T20:00:00Z');                       // Sun Nov 22, 3:00 PM
  assert.equal(ev.date, '2026-11-23');
  assert.equal(ev.label, 'Monday, Nov 23');
});

test('Monday 8:00 PM → tonight', () => {
  assert.equal(both('2026-11-24T01:00:00Z').date, '2026-11-23');   // Mon Nov 23, 8:00 PM
});

test('Monday 11:59 PM → tonight', () => {
  assert.equal(both('2026-11-24T04:59:00Z').date, '2026-11-23');   // Mon Nov 23, 11:59 PM
});

test('Tuesday 2:59 AM → still Monday night', () => {
  assert.equal(both('2026-11-24T07:59:00Z').date, '2026-11-23');   // Tue Nov 24, 2:59 AM
});

test('Tuesday 3:00 AM → next Monday', () => {
  const ev = both('2026-11-24T08:00:00Z');                        // Tue Nov 24, 3:00 AM
  assert.equal(ev.date, '2026-11-30');
  assert.equal(ev.label, 'Monday, Nov 30');
});

test('Monday 12:00 AM (start of the day) → that Monday', () => {
  assert.equal(both('2026-11-23T05:00:00Z').date, '2026-11-23');
});

test('DST ends (Sun Nov 1, 2026): rollover still at 3:00 AM local', () => {
  assert.equal(both('2026-11-01T05:30:00Z').date, '2026-11-02');   // Sun Nov 1, 1:30 AM EDT (before the change)
  assert.equal(both('2026-11-01T06:30:00Z').date, '2026-11-02');   // Sun Nov 1, 1:30 AM EST (after)
  assert.equal(both('2026-11-03T07:59:00Z').date, '2026-11-02');   // Tue Nov 3, 2:59 AM EST
  assert.equal(both('2026-11-03T08:00:00Z').date, '2026-11-09');   // Tue Nov 3, 3:00 AM EST
});

test('DST starts (Sun Mar 14, 2027): rollover at 3:00 AM EDT, not a fixed UTC-5', () => {
  assert.equal(both('2027-03-16T06:59:00Z').date, '2027-03-15');   // Tue Mar 16, 2:59 AM EDT
  assert.equal(both('2027-03-16T07:00:00Z').date, '2027-03-22');   // Tue Mar 16, 3:00 AM EDT (a fixed -05:00 would say 2 AM)
});

test('Year end: Tuesday Dec 29, 2026 3:00 AM → Monday Jan 4, 2027', () => {
  assert.equal(both('2026-12-29T08:00:00Z').date, '2027-01-04');
  assert.equal(both('2026-12-29T08:00:00Z').label, 'Monday, Jan 4');
});

test('Override date: used until its night ends, then back to automatic', () => {
  const s = { overrideDate: '2026-11-27' };                       // a Friday special
  let ev = both('2026-11-24T15:00:00Z', s);                        // Tue Nov 24, 10 AM
  assert.equal(ev.date, '2026-11-27'); assert.equal(ev.source, 'override'); assert.equal(ev.label, 'Friday, Nov 27');
  assert.equal(both('2026-11-28T07:59:00Z', s).date, '2026-11-27'); // Sat 2:59 AM: still that night
  ev = both('2026-11-28T08:00:00Z', s);                            // Sat 3:00 AM: over
  assert.equal(ev.date, '2026-11-30'); assert.equal(ev.source, 'auto');
});

test('Override date: other formats, past dates and nonsense', () => {
  assert.equal(both('2026-11-24T15:00:00Z', { overrideDate: '11/27/2026' }).date, '2026-11-27');
  assert.equal(both('2026-11-24T15:00:00Z', { overrideDate: '11/27/26' }).date, '2026-11-27');
  assert.equal(both('2026-11-24T15:00:00Z', { overrideDate: '2026-11-16' }).date, '2026-11-30');  // already past
  assert.equal(both('2026-11-24T15:00:00Z', { overrideDate: '2026-02-30' }).date, '2026-11-30');  // not a date
  assert.equal(both('2026-11-24T15:00:00Z', { overrideDate: 'soon' }).date, '2026-11-30');
  assert.equal(both('2026-11-24T15:00:00Z', { overrideDate: '2026-12-07' }).date, '2026-12-07');  // a later Monday
});

test('Skip this week: shows the skip, RSVPs go to the Monday after', () => {
  const ev = both('2026-11-23T23:00:00Z', { skip: 'Yes' });       // Mon Nov 23, 6 PM
  assert.equal(ev.skipped, true);
  assert.equal(ev.date, '2026-11-23');
  assert.equal(ev.nextDate, '2026-11-30');
  assert.equal(ev.rsvpDate, '2026-11-30');
  assert.equal(ev.rsvpLabel, 'Monday, Nov 30');
  for (const v of ['No', '', 'no', false, null]) assert.equal(both('2026-11-23T23:00:00Z', { skip: v }).skipped, false);
  for (const v of ['yes', 'Y', 'TRUE', true, 'x']) assert.equal(both('2026-11-23T23:00:00Z', { skip: v }).skipped, true);
});

test('Skip with an override: the override night is skipped, back the Monday after it', () => {
  const ev = both('2026-11-24T15:00:00Z', { overrideDate: '2026-11-27', skip: 'Yes' });
  assert.equal(ev.date, '2026-11-27'); assert.equal(ev.skipped, true); assert.equal(ev.rsvpDate, '2026-11-30');
});

test('Settings: blanks fall back to the defaults, time shows as 9 PM–3 AM', () => {
  const ev = both('2026-11-22T20:00:00Z', { venue: '  ', address: '', time: '' });
  assert.deepEqual({ ...ev.settings }, { venue: 'Astra', address: '2121 NW Second Ave, Miami, FL 33127', time: '9 PM–3 AM', overrideDate: '', skip: false, note: '' });
});

test('Site and script agree every 15 minutes from Oct 2026 to Apr 2027 (both DST changes)', () => {
  const variants = [{}, { skip: 'Yes' }, { overrideDate: '2026-12-31' }, { overrideDate: '2027-03-14', skip: 'yes' }];
  let n = 0;
  for (let t = Date.UTC(2026, 9, 1); t < Date.UTC(2027, 4, 1); t += 15 * 60 * 1000) {
    for (const s of variants) { both(new Date(t).toISOString(), s); n++; }
  }
  assert.ok(n > 80000);
});
