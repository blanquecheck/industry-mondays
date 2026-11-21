// Industry Mondays RSVP form: validates, posts to the Google Sheet backend, shows the confirmation.
(function () {
  const cfg = window.IM_CONFIG || {};
  const q = new URLSearchParams(location.search);
  const $ = id => document.getElementById(id);
  const form = $('rsvp-form');

  // ---------- The night on show: automatic next Monday, plus overrides from the Settings sheet ----------
  // Works with no network: the date comes from IMEvent (event-date.js) and the device clock right away; the
  // Settings tab (venue, time, override date, skip, note) arrives from the Apps Script web app and refines it.
  // If that call fails, the page keeps the automatic date and the last venue it saw.
  const SETTINGS_KEY = 'im_settings_v1';
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(v)); } catch (e) {} },
  };
  let current = null;   // the last resolved event, used by the confirmation screen

  const setText = (key, text) => document.querySelectorAll(`[data-im="${key}"]`).forEach(el => { el.textContent = text; });
  function splitAddress(address) {
    const parts = address.split(',').map(x => x.trim()).filter(Boolean);
    return { street: parts[0] || address, rest: parts.slice(1).join(', '), city: parts[1] || '' };
  }
  function render(ev) {
    current = ev;
    const s = ev.settings, a = splitAddress(s.address);
    if (ev.skipped) {
      setText('date', `No event this ${ev.label.split(',')[0]}`);
      setText('time', `Back ${ev.nextLabel}`);
      setText('when-line', `No event this ${ev.label.split(',')[0]} — back ${ev.nextLabel}`);
    } else {
      setText('date', ev.label);
      setText('time', s.time);
      setText('when-line', `${ev.label} · ${s.time}`);
    }
    setText('venue', s.venue);
    setText('addr-short', a.city ? `${a.street} · ${a.city}` : a.street);
    document.querySelectorAll('[data-im="addr-lines"]').forEach(el => {
      el.textContent = a.street;
      if (a.rest) el.append(document.createElement('br'), a.rest);
    });
    document.querySelectorAll('[data-im="maps"]').forEach(el => {
      el.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(`${s.venue} ${s.address}`);
    });
    document.querySelectorAll('[data-im="note"]').forEach(el => { el.textContent = s.note; el.hidden = !s.note; });
    setText('done-lede', `See you ${ev.rsvpLabel} at ${s.venue}, ${a.street}, from ${s.time.split(/[–-]/)[0].trim()}. Happy hour is free with your RSVP.`);
    document.title = `Industry Mondays at ${s.venue} · RSVP for free happy hour`;
  }

  // ---------- Weekly lock and lineup reveal ----------
  // LOCKED (Tue 3 AM → Wed 12 PM ET): a full-screen countdown only; the server also refuses RSVPs.
  // REVEAL (Wed 12 PM → Tue 3 AM): the full site in that week's flyer theme, with the lineup when there is one.
  // The page holds no lineup data: names arrive from the Apps Script web app only once the server says it's time.
  const root = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const previewQs = q.get('preview') === 'reveal' && q.get('key') ? `&preview=reveal&key=${encodeURIComponent(q.get('key'))}` : '';
  let clockSkew = 0;                    // server time − device time, so the countdown follows the server
  let lock = null;                      // { revealAt: Date, theme } while counting down

  const hexRgb = h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16));
  const rgbHex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  const mix = (a, b, t) => { const x = hexRgb(a), y = hexRgb(b); return rgbHex(x.map((v, i) => v + (y[i] - v) * t)); };
  const rgba = (h, a) => { const c = hexRgb(h); return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`; };

  function applyTheme(t) {
    t = t || IMEvent.theme('classic');
    const v = {
      '--plum-900': t.bg, '--plum-800': mix(t.bg, t.text, 0.05), '--plum-700': mix(t.bg, t.text, 0.1),
      '--cream': t.text, '--cream-dim': rgba(t.text, 0.72), '--pink': t.accent, '--emerald': t.second,
      '--line': rgba(t.accent, 0.38), '--line-soft': rgba(t.text, 0.16),
      '--pink-hover': mix(t.accent, IMEvent.contrast(t.bg, mix(t.accent, '#FFFFFF', 0.18)) >= 4.5 ? '#FFFFFF' : t.bg, 0.18),
    };
    if (t.name === 'classic') Object.keys(v).forEach(k => root.style.removeProperty(k));   // exactly the stylesheet
    else Object.keys(v).forEach(k => root.style.setProperty(k, v[k]));
    const meta = document.getElementById('theme-color'); if (meta) meta.content = t.bg;
  }

  // Lineup: 1–4 names, each shrunk until it fits its line (wraps only if even the smallest size can't fit).
  function fitNames() {
    document.querySelectorAll('.lineup .name').forEach(el => {
      el.classList.remove('wrap'); el.style.fontSize = '';
      let size = parseFloat(getComputedStyle(el).fontSize);
      while (el.scrollWidth > el.clientWidth + 0.5 && size > 18) { size -= 1; el.style.fontSize = size + 'px'; }
      if (el.scrollWidth > el.clientWidth + 0.5) el.classList.add('wrap');
    });
  }
  function renderLineup(list) {
    const ul = document.querySelector('[data-im="lineup"]');
    if (!ul) return;
    ul.textContent = '';
    (list || []).forEach(x => {
      const li = document.createElement('li');
      if (x.role) { const r = document.createElement('span'); r.className = 'mono role'; r.textContent = x.role; li.append(r); }
      const n = document.createElement('span'); n.className = 'display name'; n.textContent = x.name; li.append(n);
      ul.append(li);
    });
    ul.hidden = !ul.children.length;                    // never an empty lineup
    if (!ul.hidden) requestAnimationFrame(fitNames);
  }
  window.addEventListener('resize', () => requestAnimationFrame(fitNames));

  // Countdown background: slow colour cycle that settles into the new week's theme over the final hour.
  const SETTLE_MS = 60 * 60 * 1000;
  function lockColors(now) {
    const left = Math.max(0, lock.revealAt - now);
    const w = Math.pow(Math.min(1, Math.max(0, 1 - left / SETTLE_MS)), 1.5);
    const t = lock.theme || IMEvent.theme('classic');
    const h = reduceMotion ? 300 : (performance.now() / 1000 * 9) % 360;   // animation time: one slow turn every 40 s
    const hsl = (hue, l) => { const k = n => (n + hue / 30) % 12, a = 0.62 * Math.min(l, 1 - l);
      return rgbHex([0, 8, 4].map(n => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))); };
    const target = [t.bg, mix(t.bg, t.accent, 0.55), mix(t.bg, t.second, 0.25)];
    const cycle = [hsl(h, 0.12), hsl(h + 70, 0.30), hsl(h + 150, 0.16)];
    const stops = cycle.map((c, i) => mix(c, target[i], w));
    ['a', 'b', 'c'].forEach((k, i) => root.style.setProperty(`--lock-${k}`, stops[i]));
    root.style.setProperty('--lock-angle', (reduceMotion ? 160 : 160 + 40 * Math.sin(performance.now() / 9000)) + 'deg');
    const lum = stops.reduce((s, c) => s + hexRgb(c).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0) / 255, 0) / 3;
    root.style.setProperty('--lock-text', lum > 0.5 ? '#141414' : '#F4EEE3');
  }

  let ticking = false, lastSr = '';
  function tick() {
    if (!lock) { ticking = false; return; }
    const now = Date.now() + clockSkew, left = Math.max(0, lock.revealAt - now);
    const s = Math.floor(left / 1000);
    const parts = { d: Math.floor(s / 86400), h: Math.floor(s / 3600) % 24, m: Math.floor(s / 60) % 60, s: s % 60 };
    Object.keys(parts).forEach(k => { const el = document.querySelector(`[data-cd="${k}"]`); if (el) el.textContent = String(parts[k]).padStart(2, '0'); });
    const sr = `Lineup drops in ${parts.d} days, ${parts.h} hours, ${parts.m} minutes.`;
    if (sr !== lastSr) { lastSr = sr; const el = $('cd-sr'); if (el) el.textContent = sr; }
    lockColors(now);
    if (left <= 0) { lock.done = true; reachZero(); ticking = false; return; }
    if (reduceMotion) setTimeout(tick, 1000); else requestAnimationFrame(tick);
  }
  function startLock(revealAt, theme) {
    lock = { revealAt: revealAt.getTime(), theme: theme || null };
    root.setAttribute('data-phase', 'locked');
    if (!ticking) { ticking = true; tick(); }
  }

  // At zero, ask the server until it says REVEAL (its clock may be a few seconds behind), then show the site.
  let polling = false;
  function reachZero() {
    if (polling) return;
    polling = true;
    let tries = 0;
    const attempt = () => fetchEvent().then(res => {
      if (res && res.phase === 'locked' && tries++ < 40) { setTimeout(attempt, 2500); return; }
      polling = false;
      reveal(res);
    });
    attempt();
  }

  function reveal(res) {
    const wasLocked = root.getAttribute('data-phase') === 'locked';
    lock = null;
    applyTheme(res && res.theme);
    renderLineup(res ? res.lineup : []);
    document.querySelectorAll('[data-im="preview"]').forEach(el => { el.hidden = !(res && res.preview); });
    const panel = $('lock');
    if (wasLocked && panel && !reduceMotion) {
      panel.classList.add('leaving');
      setTimeout(() => panel.classList.remove('leaving'), 950);
    }
    root.setAttribute('data-phase', res && res.phase === 'skip' ? 'skip' : 'reveal');
  }

  function fetchEvent() {
    if (!cfg.RSVP_ENDPOINT || q.has('demo')) return Promise.resolve(null);
    const ctrl = 'AbortController' in window ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), 8000);
    return fetch(cfg.RSVP_ENDPOINT + '?action=event' + previewQs, { cache: 'no-store', signal: ctrl && ctrl.signal })
      .then(r => r.json())
      .then(res => (res && res.ok ? res : null))
      .catch(() => null)
      .finally(() => clearTimeout(timer));
  }

  // Server answer → date/venue text, then lock or reveal.
  function apply(res) {
    if (res.settings) {
      const settings = IMEvent.normalizeSettings(res.settings);
      store.set({ venue: settings.venue, address: settings.address, time: settings.time });
      // Prefer the server's clock, so a phone set to the wrong time still shows the right night.
      const now = res.now && !isNaN(Date.parse(res.now)) ? new Date(res.now) : new Date();
      if (res.now && !isNaN(Date.parse(res.now))) clockSkew = Date.parse(res.now) - Date.now();
      render(IMEvent.resolve(now, settings));
    }
    if (res.phase === 'locked' && res.revealAt) startLock(new Date(res.revealAt), res.theme);
    else reveal(res);
  }

  if (window.IMEvent) {
    const cached = store.get();
    // Until the sheet answers: automatic date, last known venue/address/time (never a cached override or skip).
    const known = cached ? { venue: cached.venue, address: cached.address, time: cached.time } : {};
    try {
      const now = new Date(), ev = IMEvent.resolve(now, known), ph = IMEvent.phase(now, ev);
      render(ev);
      if (ph.phase === 'locked') startLock(IMEvent.instant(ph.revealKey) || now, null);
    } catch (e) {}
    fetchEvent().then(res => {
      if (res) apply(res);
      else if (!lock) reveal(null);   // no server: keep the automatic date, default theme, no lineup
    });
  }

  // Pause the background loop for people who ask for less motion.
  const video = document.querySelector('video.loop');
  if (video && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { video.removeAttribute('autoplay'); video.pause(); }

  // Keep a referral code from links like ?ref=maria for the whole visit.
  try { if (q.get('ref')) sessionStorage.setItem('im_ref', q.get('ref')); } catch (e) {}
  const ref = () => { try { return q.get('ref') || sessionStorage.getItem('im_ref') || ''; } catch (e) { return q.get('ref') || ''; } };

  const digits = s => (s || '').replace(/\D/g, '');
  const checks = {
    first: v => v.trim() ? '' : 'Add your first name.',
    email: v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : 'Check your email address.',
    phone: v => { const d = digits(v); return d.length >= 10 && d.length <= 15 ? '' : 'Add a mobile number with area code.'; },
  };

  function showError(name, msg) {
    const input = $(name), err = $(name + '-err');
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg) input.setAttribute('aria-describedby', name + '-err'); else input.removeAttribute('aria-describedby');
    err.textContent = msg;
  }
  Object.keys(checks).forEach(name => {
    $(name).addEventListener('blur', () => { if ($(name).value) showError(name, checks[name]($(name).value)); });
    $(name).addEventListener('input', () => { if ($(name).getAttribute('aria-invalid') === 'true') showError(name, checks[name]($(name).value)); });
  });

  // US numbers format as you type: (305) 555-0123
  $('phone').addEventListener('input', e => {
    const d = digits(e.target.value);
    if (e.target.value.trim().startsWith('+') || d.length > 10) return;
    const a = d.slice(0, 3), b = d.slice(3, 6), c = d.slice(6, 10);
    e.target.value = d.length > 6 ? `(${a}) ${b}-${c}` : d.length > 3 ? `(${a}) ${b}` : a;
  });

  const status = (msg, bad) => { $('status').textContent = msg; $('status').classList.toggle('bad', !!bad); };

  form.addEventListener('submit', async e => {
    e.preventDefault();
    status('');
    let firstBad = null;
    Object.keys(checks).forEach(name => {
      const msg = checks[name]($(name).value);
      showError(name, msg);
      if (msg && !firstBad) firstBad = $(name);
    });
    if (firstBad) { firstBad.focus(); return; }

    const data = {
      first: $('first').value.trim(), last: $('last').value.trim(), email: $('email').value.trim(),
      phone: $('phone').value.trim(), role: $('role').value, instagram: $('instagram').value.trim(),
      workplace: $('workplace').value.trim(), company: $('company').value,
      email_opt: $('email_opt').checked, sms_opt: $('sms_opt').checked, sms_text: $('sms-text').textContent.trim(),
      ref: ref(), utm_source: q.get('utm_source') || '', utm_medium: q.get('utm_medium') || '', utm_campaign: q.get('utm_campaign') || '',
      page: location.href.split('#')[0], ua: navigator.userAgent,
    };

    const btn = $('submit');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      let result;
      if (q.has('demo')) {
        result = { ok: true };   // preview mode: nothing is sent
      } else {
        if (!cfg.RSVP_ENDPOINT) throw new Error('no-endpoint');
        // text/plain keeps this a simple request, so the browser skips the CORS preflight Apps Script can't answer.
        const res = await fetch(cfg.RSVP_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(data) });
        result = await res.json();
      }
      if (!result.ok) {
        if (result.error === 'locked') { status(result.message || 'RSVP opens Wednesday 12PM ET', true); return; }
        if (checks[result.error]) { showError(result.error, checks[result.error]('')); $(result.error).focus(); }
        else status('That didn’t go through. Try again in a moment.', true);
        return;
      }
      $('done-title').textContent = `You're on the list, ${data.first}`;
      // The backend says which night this RSVP was saved for; show that exact date.
      if (result.event && result.event.label && current) {
        const s = current.settings;
        setText('done-lede', `See you ${result.event.label} at ${s.venue}, ${splitAddress(s.address).street}, from ${s.time.split(/[–-]/)[0].trim()}. Happy hour is free with your RSVP.`);
      }
      $('form-view').hidden = true;
      $('done-view').hidden = false;
      $('done-view').focus();
    } catch (err) {
      status('That didn’t go through. Check your connection and try again.', true);
    } finally {
      btn.disabled = false; btn.textContent = 'RSVP · it’s free';
    }
  });

  $('share').addEventListener('click', async () => {
    const url = location.origin + location.pathname;
    const text = 'Industry Mondays at Astra. Happy hour is free with RSVP.';
    try {
      if (navigator.share) { await navigator.share({ title: 'Industry Mondays', text, url }); return; }
      await navigator.clipboard.writeText(`${text} ${url}`);
      $('share-status').textContent = 'Link copied. Paste it in the group chat.';
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      $('share-status').textContent = url;
    }
  });
})();
