# Industry Mondays at Astra — RSVP site

Static one-page site for The Industry Mixer's Industry Mondays. RSVPs post to a Google Apps Script web app that writes
to the private "Industry Mondays RSVPs" Google Sheet (source: `apps-script/Code.gs`; setup in `apps-script/README.md`).

- `config.js` — backend URL and privacy contact email.
- `event-date.js` — which night to show: the upcoming Monday in Miami time, rolling over at 3 AM Tuesday. The page
  fills every date spot from it, then applies the Sheet's Settings tab (venue, time, one-off date, skip week, note).
  No edits needed week to week. Without JavaScript the page says "Every Monday, 9 PM–3 AM".
- Promoter links: add `?ref=<name>` to the site URL; UTM tags are recorded too.
- Tests: `node --test tests/*.test.mjs` (Node 20+, no installs). They check the date rule and that the site and the
  Apps Script give the same date.

Built by Proper Ground Studio.
