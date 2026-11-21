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

## Weekly lineup reveal

Every week the site locks behind a countdown and reveals the new lineup on **Wednesday at 12:00 PM ET**:

- **Tuesday 3:00 AM → Wednesday 11:59 AM ET: locked.** The page shows only the Industry Mondays logo and a countdown,
  over slowly shifting colours that settle into the new week's theme in the final hour. RSVP is closed: the form
  is hidden and the server turns away any RSVP that still gets sent ("RSVP opens Wednesday 12PM ET").
- **Wednesday 12:00 PM → the next Tuesday 2:59 AM: reveal.** The full site in that week's colours (the chrome sculpture
  is recoloured to match), with the lineup
  (1–4 names) and the RSVP form open. A page left open on the countdown switches over by itself at noon.
- **Skip weeks** work as before: no countdown, no reveal, RSVPs go to the Monday after.
- Lineup names are never in the site's files. The server sends them only after the reveal time.

### Owner: fill next week's lineup (plain steps)

1. Open the **Industry Mondays RSVPs** Google Sheet and go to the **Lineups** tab.
2. On a new row, type the **Event date**: the Monday of the night, e.g. `2026-12-07`.
3. Pick a **Theme** from the dropdown: classic, red-gold, purple-haze, all-white, neon-green or black-chrome.
4. *(Optional)* To tweak colours, type a hex colour in **Background**, **Accent** and/or **Text** (e.g. `#1C0708`).
   Leave them blank to use the theme as is. A colour that would be hard to read is swapped for a readable one.
5. Fill **Role 1 / Name 1** to **Role 4 / Name 4** (e.g. `HOST` / `Name`, `DJ` / `Name`, `SPECIAL GUEST` / `Name`).
   Use 1 to 4; leave the rest blank. Long names shrink to fit on phones.
6. *(Optional)* **Reveal override**: a date and time (Miami time) to reveal earlier or later that one week,
   e.g. `2026-12-02 18:00`. Blank = Wednesday 12:00 PM.
7. That's it. You can fill several weeks ahead. If a week has no row, the site still opens at noon with the date,
   venue and RSVP, just no lineup.

**Check it before noon:** open `https://industrymondays.com/?preview=reveal&key=YOUR-PREVIEW-KEY`. You'll see the
reveal with a "Preview" tag. Only people with the key can see it; RSVP stays closed until noon. (The key is set
once in Apps Script, see `apps-script/README.md`.)

Tests: `node --test tests/*.test.mjs`. Browser check with screenshots:
`PLAYWRIGHT=<path to playwright> node tests/browser/reveal.mjs` (writes `tests/browser/screens/`).

Built by Proper Ground Studio.
