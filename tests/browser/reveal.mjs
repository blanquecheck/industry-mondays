// Browser check for the weekly lock and lineup reveal. Not part of `node --test` (needs Playwright + Chromium).
// Run: PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node tests/browser/reveal.mjs
// The page is served from this repo; every request to the Apps Script web app is answered by the real
// apps-script/Code.gs running in Node (tests/gas-env.mjs) at the page's simulated time.
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeEnv } from '../gas-env.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'tests/browser/screens');
mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.webp': 'image/webp', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };
const server = createServer((req, res) => {
  const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || !existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
}).listen(0);
const BASE = `http://127.0.0.1:${server.address().port}/`;

const ROW_FOUR = ['2026-11-30', 'red-gold', '', '', '', 'HOST', 'Test Host One', 'DJ', 'Test DJ Two',
  'DJ', 'Test DJ With A Very Long Stage Name', 'SPECIAL GUEST', 'Test Guest Four', ''];
const NAMES = ['Test Host One', 'Test DJ Two', 'Test DJ With A Very Long Stage Name', 'Test Guest Four'];
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const browser = await chromium.launch();
async function open(label, { at, lineups, settings, qs = '', width = 360, height = 780, video } = {}) {
  const env = makeEnv({ now: at, lineups, settings });
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, ...(video ? { recordVideo: { dir: OUT, size: { width, height } } } : {}) });
  const page = await ctx.newPage();
  const seen = [];                                   // every network response body, for the leak check
  await page.clock.setFixedTime(new Date(at));
  await page.route('**/script.google.com/**', async (route) => {
    const now = await page.evaluate(() => Date.now()).catch(() => Date.parse(at));
    env.setNow(new Date(now).toISOString());
    const req = route.request(), url = new URL(req.url());
    const out = req.method() === 'POST'
      ? env.ctx.doPost({ postData: { contents: req.postData() } })
      : env.ctx.doGet({ parameter: Object.fromEntries(url.searchParams) });
    const body = JSON.stringify(out);
    seen.push(body);
    await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body });
  });
  let navs = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
  await page.goto(BASE + 'index.html' + qs);
  await page.waitForTimeout(1200);
  return { env, ctx, page, seen, navs: () => navs, label };
}
const shot = (o, name) => o.page.screenshot({ path: join(OUT, name) });
const phaseOf = (o) => o.page.evaluate(() => document.documentElement.getAttribute('data-phase'));
const visible = (o, sel) => o.page.evaluate((s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'; }, sel);

// 1. Tue 3:00 AM: locked, countdown only, nothing leaks
{
  const o = await open('tue-3am', { at: '2026-11-24T08:00:00Z', lineups: [ROW_FOUR] });
  await shot(o, '01-locked-tue-3am.png');
  check('Tue 3:00 AM → LOCKED', await phaseOf(o) === 'locked');
  check('Locked: RSVP form, venue and header are not shown', !(await visible(o, '#rsvp-form')) && !(await visible(o, '.venue')) && !(await visible(o, '.bar')));
  const cd = await o.page.evaluate(() => [...document.querySelectorAll('[data-cd]')].map((e) => e.textContent).join(':'));
  check('Countdown reads 1 day 09:00:00 to Wed 12 PM', cd === '01:09:00:00', cd);
  const fits = await o.page.evaluate(() => [...document.querySelectorAll('.lock-logo span, .cd .num, .cd .unit, .lock-note')]
    .every((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  check('Countdown screen fits a 360 px phone (logo, digits, labels)', fits);
  const src = (await o.page.content()) + readFileSync(join(ROOT, 'index.html'), 'utf8') + readFileSync(join(ROOT, 'config.js'), 'utf8') + readFileSync(join(ROOT, 'app.js'), 'utf8');
  check('No lineup name in page source, config.js, app.js or any network response', !NAMES.some((n) => src.includes(n) || o.seen.some((b) => b.includes(n))));
  const res = await o.page.evaluate(async () => (await fetch(window.IM_CONFIG.RSVP_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ first: 'Ana', email: 'ana@example.com', phone: '3055550123' }) })).json());
  check('RSVP attempt during the lock is rejected by the server', res.ok === false && res.error === 'locked' && res.message === 'RSVP opens Wednesday 12PM ET', JSON.stringify(res));
  check('…and nothing was saved or emailed', o.env.sheets.RSVPs.rows().length === 0 && o.env.sent.length === 0);
  await o.ctx.close();
}

// 2. Wed 11:59 AM: still locked, colours settled into the new theme; 3. noon: reveals without a reload
{
  const o = await open('wed-1159', { at: '2026-11-25T16:59:00Z', lineups: [ROW_FOUR] });
  await shot(o, '02-locked-wed-1159.png');
  check('Wed 11:59 AM → still LOCKED', await phaseOf(o) === 'locked');
  check('Locked response carries no names', !o.seen.some((b) => NAMES.some((n) => b.includes(n))));
  await o.page.clock.setFixedTime(new Date('2026-11-25T16:59:58Z'));
  await o.page.waitForTimeout(400);
  await o.page.clock.setFixedTime(new Date('2026-11-25T17:00:00Z'));          // the countdown hits zero
  await o.page.waitForFunction(() => document.documentElement.getAttribute('data-phase') === 'reveal', null, { timeout: 15000 });
  await o.page.waitForTimeout(1100);
  await shot(o, '03-reveal-wed-noon.png');
  check('Wed 12:00 PM → REVEAL on its own, no reload', o.navs() === 1);
  const names = await o.page.evaluate(() => [...document.querySelectorAll('.lineup .name')].map((e) => e.textContent));
  check('Reveal shows the 4 names', JSON.stringify(names) === JSON.stringify(NAMES), names.join(' | '));
  check('Reveal uses the week\'s theme (red-gold background)', (await o.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--plum-900').trim())) === '#1C0708');
  check('RSVP form is open after the reveal', await visible(o, '#rsvp-form'));
  await o.ctx.close();
}

// 4 names at 360 px: nothing cut off
{
  const o = await open('four-names', { at: '2026-11-25T18:00:00Z', lineups: [ROW_FOUR] });
  await o.page.evaluate(() => document.querySelector('.lineup').scrollIntoView({ block: 'center' }));
  await o.page.waitForTimeout(300);
  await shot(o, '04-four-names-360px.png');
  const fit = await o.page.evaluate(() => [...document.querySelectorAll('.lineup .name')].every((e) => e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().right <= innerWidth));
  const scrollX = await o.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check('4 names at 360 px: every name fits its line, no sideways scroll', fit && scrollX);
  await o.ctx.close();
}

// 0 names (row with a theme only) and missing row
{
  const o = await open('zero-names', { at: '2026-11-25T18:00:00Z', lineups: [['2026-11-30', 'neon-green', '', '', '', '', '', '', '', '', '', '', '', '']] });
  await shot(o, '05-zero-names-theme-only.png');
  check('0 names → theme applied, no lineup block', !(await visible(o, '.lineup')) && (await o.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--plum-900').trim())) === '#050B07');
  await o.ctx.close();
  const m = await open('missing-row', { at: '2026-11-25T18:00:00Z' });
  await shot(m, '06-missing-lineup-row.png');
  check('Missing lineup row → normal page, date/venue/RSVP, no lineup', !(await visible(m, '.lineup')) && await visible(m, '#rsvp-form') && (await m.page.textContent('[data-im="date"]')) === 'Monday, Nov 30');
  await m.ctx.close();
}

// Skip week
{
  const o = await open('skip', { at: '2026-11-24T15:00:00Z', settings: { 'Skip this week': 'Yes' }, lineups: [ROW_FOUR] });
  await shot(o, '07-skip-week.png');
  check('Skip week → no countdown, skip message, RSVP open', await phaseOf(o) === 'skip' && (await o.page.textContent('[data-im="date"]')) === 'No event this Monday' && await visible(o, '#rsvp-form'));
  await o.ctx.close();
}

// Owner preview before noon; wrong key stays locked
{
  const o = await open('preview', { at: '2026-11-24T15:00:00Z', lineups: [ROW_FOUR], qs: '?preview=reveal&key=preview-secret-key' });
  await shot(o, '08-preview-before-noon.png');
  check('Preview key before noon → reveal with names and a Preview pill', await phaseOf(o) === 'reveal' && await visible(o, '[data-im="preview"]') && (await o.page.$$('.lineup .name')).length === 4);
  await o.ctx.close();
  const w = await open('preview-bad', { at: '2026-11-24T15:00:00Z', lineups: [ROW_FOUR], qs: '?preview=reveal&key=nope' });
  check('Wrong preview key → still locked, no names', await phaseOf(w) === 'locked' && !w.seen.some((b) => NAMES.some((n) => b.includes(n))));
  await w.ctx.close();
}

// Desktop reveal for the PR
{
  const o = await open('desktop', { at: '2026-11-25T18:00:00Z', lineups: [ROW_FOUR], width: 1440, height: 900 });
  await shot(o, '09-reveal-desktop.png');
  await o.ctx.close();
}

// Screen recording: the colour cycle, then the last hour settling into red-gold, then noon
{
  const o = await open('recording', { at: '2026-11-25T16:00:00Z', lineups: [ROW_FOUR], video: true, width: 390, height: 844 });
  await o.page.waitForTimeout(3500);                                       // real-time colour cycle
  const start = Date.parse('2026-11-25T16:00:00Z');
  for (let i = 1; i <= 120; i++) { await o.page.clock.setFixedTime(new Date(start + i * 30000)); await o.page.waitForTimeout(50); }   // the final hour in ~6 s
  await o.page.clock.setFixedTime(new Date('2026-11-25T17:00:01Z'));
  await o.page.waitForFunction(() => document.documentElement.getAttribute('data-phase') === 'reveal', null, { timeout: 15000 });
  await o.page.waitForTimeout(2200);
  const vid = await o.page.video().path();
  await o.ctx.close();
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', vid, '-vf', 'fps=30,scale=390:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(OUT, 'color-shift.mp4')]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', vid, '-vf', 'fps=12,scale=300:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', join(OUT, 'color-shift.gif')]);
    console.log('recording: tests/browser/screens/color-shift.mp4 (+ .gif)');
  } catch (e) { console.log('recording saved (ffmpeg not available):', vid); }
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
