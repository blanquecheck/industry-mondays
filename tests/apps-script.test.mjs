// Run: node --test tests/
// Runs apps-script/Code.gs against an in-memory stand-in for Google Sheets, Mail and the clock, to check the
// RSVP → event date → confirmation → reminder flow without a Google account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { makeEnv } from './gas-env.mjs';

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
  env.setNow('2026-11-25T17:00:00Z');                                 // Wed 12 PM: Nov 30 revealed, RSVP open
  const res = env.rsvp('ana@example.com');
  assert.equal(res.event.date, '2026-11-30');
  assert.equal(env.sent.length, 2);
  assert.match(env.sent[1].subject, /Monday, Nov 30$/);
  const codes = new Set(env.sheets.RSVPs.rows().map((r) => r['Check-in code']));
  assert.equal(codes.size, 1);                                       // same guest keeps one code
});

test('Settings tab: venue, time, note and override flow into the RSVP and email', () => {
  const env = makeEnv({ now: '2026-11-25T18:00:00Z', settings: {
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
  env.setNow('2026-11-25T17:00:00Z');                                 // Wed 12 PM: an RSVP for Nov 30
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


// ---------- Weekly lineup reveal ----------
// Lineups row: Event date, Theme, Background, Accent, Text, Role 1, Name 1, … Role 4, Name 4, Reveal override.
const ROW_FOUR = ['2026-11-30', 'red-gold', '', '', '', 'HOST', 'Test Host One', 'DJ', 'Test DJ Two',
  'DJ', 'Test DJ With A Very Long Stage Name', 'SPECIAL GUEST', 'Test Guest Four', ''];
const event = (env, q = {}) => env.ctx.doGet({ parameter: { action: 'event', ...q } });

test('reveal: locked from Tue 3 AM — theme may be sent, names never (not anywhere in the response)', () => {
  const env = makeEnv({ now: '2026-11-24T08:00:00Z', lineups: [ROW_FOUR] });   // Tue Nov 24, 3:00 AM
  const got = event(env);
  assert.equal(got.phase, 'locked');
  assert.equal(got.revealAt, '2026-11-25T17:00:00.000Z');
  assert.equal(got.theme.name, 'red-gold');
  assert.equal(got.lineup.length, 0);
  assert.ok(!JSON.stringify(got).includes('Test Host'), 'no names in the response');
  env.setNow('2026-11-25T16:59:59Z');                                         // Wed 11:59:59 AM
  const late = event(env);
  assert.equal(late.phase, 'locked');
  assert.ok(!JSON.stringify(late).includes('Test'));
});

test('reveal: Wed 12:00 PM → names and theme', () => {
  const env = makeEnv({ now: '2026-11-25T17:00:00Z', lineups: [ROW_FOUR] });
  const got = event(env);
  assert.equal(got.phase, 'reveal');
  assert.deepEqual(got.lineup.map((x) => `${x.role}: ${x.name}`),
    ['HOST: Test Host One', 'DJ: Test DJ Two', 'DJ: Test DJ With A Very Long Stage Name', 'SPECIAL GUEST: Test Guest Four']);
});

test('reveal: RSVP during the lock is rejected with a clear message, and nothing is saved or emailed', () => {
  const env = makeEnv({ now: '2026-11-24T15:00:00Z', lineups: [ROW_FOUR] });   // Tue 10 AM
  const res = env.rsvp('ana@example.com');
  assert.deepEqual({ ...res }, { ok: false, error: 'locked', message: 'RSVP opens Wednesday 12PM ET' });
  assert.equal(env.sheets.RSVPs.rows().length, 0);
  assert.equal(env.sent.length, 0);
  env.setNow('2026-11-25T17:00:00Z');                                         // noon: open, same confirmation email
  const ok = env.rsvp('ana@example.com');
  assert.equal(ok.ok, true);
  assert.equal(env.sent[0].subject, "You're on the list: Industry Mondays, Monday, Nov 30");
});

test('reveal: preview key shows names before noon; a wrong or missing key does not; RSVP stays closed', () => {
  const env = makeEnv({ now: '2026-11-24T15:00:00Z', lineups: [ROW_FOUR] });
  const ok = event(env, { preview: 'reveal', key: 'preview-secret-key' });
  assert.equal(ok.phase, 'reveal'); assert.equal(ok.preview, true); assert.equal(ok.lineup.length, 4);
  for (const key of ['wrong-secret-keyy', '', 'preview-secret-ke']) {
    const no = event(env, { preview: 'reveal', key });
    assert.equal(no.phase, 'locked'); assert.equal(no.preview, false); assert.equal(no.lineup.length, 0);
  }
  assert.equal(env.rsvp('ana@example.com').error, 'locked');
});

test('reveal: missing lineup row → normal page data (no theme, no names), RSVP open at noon', () => {
  const env = makeEnv({ now: '2026-11-25T17:00:00Z' });
  const got = event(env);
  assert.equal(got.phase, 'reveal'); assert.equal(got.theme, null); assert.equal(got.lineup.length, 0);
  assert.equal(env.rsvp('ana@example.com').ok, true);
});

test('reveal: a row with 0 names → theme only; a reveal override moves the lock for that week', () => {
  const zero = makeEnv({ now: '2026-11-25T17:00:00Z', lineups: [['2026-11-30', 'neon-green', '', '', '', '', '', '', '', '', '', '', '', '']] });
  const z = event(zero);
  assert.equal(z.theme.name, 'neon-green'); assert.equal(z.lineup.length, 0);
  const moved = makeEnv({ now: '2026-11-25T17:00:00Z', lineups: [[...ROW_FOUR.slice(0, 13), '2026-11-25 18:00']] });
  assert.equal(event(moved).phase, 'locked');
  assert.equal(event(moved).revealAt, '2026-11-25T23:00:00.000Z');
  moved.setNow('2026-11-25T23:00:00Z');
  assert.equal(event(moved).lineup.length, 4);
});

test('reveal: skip week keeps the old behaviour (no lock, RSVP for the Monday after)', () => {
  const env = makeEnv({ now: '2026-11-24T15:00:00Z', settings: { 'Skip this week': 'Yes' }, lineups: [ROW_FOUR] });
  const got = event(env);
  assert.equal(got.phase, 'skip'); assert.equal(got.lineup.length, 0); assert.equal(got.revealAt, null);
  assert.equal(env.rsvp('ana@example.com').event.date, '2026-12-07');
});
