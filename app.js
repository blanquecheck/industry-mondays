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

  if (window.IMEvent) {
    const cached = store.get();
    // Until the sheet answers: automatic date, last known venue/address/time (never a cached override or skip).
    const known = cached ? { venue: cached.venue, address: cached.address, time: cached.time } : {};
    try { render(IMEvent.resolve(new Date(), known)); } catch (e) {}
    if (cfg.RSVP_ENDPOINT && !q.has('demo')) {
      const ctrl = 'AbortController' in window ? new AbortController() : null;
      const timer = setTimeout(() => ctrl && ctrl.abort(), 6000);
      fetch(cfg.RSVP_ENDPOINT + '?action=event', { cache: 'no-store', signal: ctrl && ctrl.signal })
        .then(r => r.json())
        .then(res => {
          if (!res || !res.ok || !res.settings) return;
          const settings = IMEvent.normalizeSettings(res.settings);
          store.set({ venue: settings.venue, address: settings.address, time: settings.time });
          // Prefer the server's clock, so a phone set to the wrong time still shows the right night.
          const now = res.now && !isNaN(Date.parse(res.now)) ? new Date(res.now) : new Date();
          render(IMEvent.resolve(now, settings));
        })
        .catch(() => {})
        .finally(() => clearTimeout(timer));
    }
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
