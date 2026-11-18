# RSVP backend (Google Apps Script)

`Code.gs` is the whole script bound to the "Industry Mondays RSVPs" Google Sheet. It saves RSVPs, sends the
confirmation email (with the check-in QR), sends the morning-of reminder, answers the door check-in page, and
gives the website the Settings tab (`GET …/exec?action=event`).

The site (`../event-date.js`) and this script share one date rule, kept byte-identical between the
`BEGIN/END SHARED EVENT DATE RULE` markers. `node --test tests/*.test.mjs` fails if they drift.

## The night it shows

- Every Monday, 9 PM–3 AM, Miami time (America/New_York, so daylight saving is handled).
- A Monday's date shows until **3:00 AM Tuesday**, then the next Monday.
- **Next date override** (Settings tab): that date is used instead, until 3:00 AM the day after it. Then automatic again.
- **Skip this week = Yes**: the site shows "No event this Monday — back [next date]", RSVPs are saved for the
  Monday after, and no reminders go out that day. Set it back to **No** after the skipped Monday (left on, it
  skips every week).
- If the Settings tab can't be read, everything uses the automatic date and the default venue.

## Settings tab

`setup` creates it (or adds any missing rows). Rows are found by the label in column A, so you can reorder them.

| A: Setting | B: Value (example) | C: How it works |
|---|---|---|
| Venue name | Astra | Shown on the site and in every email. |
| Venue address | 2121 NW Second Ave, Miami, FL 33127 | Street, City, State ZIP. Used for directions too. |
| Event time | 9 PM–3 AM | Display text only. The night always rolls over at 3 AM Tuesday. |
| Next date override | *(blank)* or 2026-11-27 | Blank = automatic. A date is used until its night ends. |
| Skip this week | No | Yes / No. |
| Note | *(blank)* | Optional one-liner on the site and in emails. Blank = hidden. |

The site picks up a change on the next page load (no cache).

## RSVPs tab: new columns

`setup` adds these at the right-hand end if they're missing (nothing is moved or deleted):

- **Event date**: the night this RSVP is for (YYYY-MM-DD). Reminders go to these people only.
- **Confirmation sent**: when the confirmation went out, `Already sent for this date` for a repeat RSVP, or `Failed: …`.
- **Reminded**: when the morning-of reminder went out (or `Already reminded` / `Failed: …`).

Columns are found by their header text, so keep those header names as they are.

## Paste and redeploy

You do this in your Google account; nothing here has access to it.

1. **Back up first.** Open the Sheet → Extensions → Apps Script. Select all of the current `Code.gs` and paste it
   into a note or a new file (File → Make a copy of the project also works). If your current script has changes
   that aren't in this repo (for example its own reminder or "next Monday" code), keep that copy to compare.
2. **Paste.** Replace everything in `Code.gs` with this file's contents → Save (Ctrl/Cmd+S).
3. **Time zone.** Project Settings (gear icon) → Time zone: (GMT-05:00) Eastern Time - New York.
4. **Run `setup`.** Pick `setup` in the function menu → Run → allow the permissions Google asks for. Check the
   Sheet: a **Settings** tab, and **Event date / Confirmation sent / Reminded** columns on RSVPs.
5. **Run `backfillEventDates`** once (fills Event date on older rows from their submitted time; sends nothing).
6. **Fill the Settings tab** (defaults are already there: Astra, the address, 9 PM–3 AM, No skip).
7. **Reminder trigger.** Run `installReminderTrigger` once. It creates one daily trigger for `sendReminders`
   between 10 and 11 AM Miami time (and removes any older one). Check it under Triggers (clock icon).
   *By hand instead:* Triggers → Add Trigger → function `sendReminders` → event source "Time-driven" →
   "Day timer" → "10am to 11am" → Save. Delete any older reminder triggers from the previous script.
8. **Redeploy the web app (same URL).** Deploy → Manage deployments → select the active web app → edit (pencil)
   → Version: **New version** → Deploy. Don't use "New deployment": that makes a new URL and the site would keep
   calling the old one.
9. **Check.**
   - Run `showCurrentEvent` → the log shows the date the site and emails will use.
   - Open the web app URL with `?action=event` on the end in a browser: you should see the settings as JSON.
   - Run `testConfirmation` → you get a test confirmation and a test reminder at the script owner's address.
   - Reload industrymondays.com: the hero, the "where" card and the confirmation screen show that date.

## Functions you can run

| Function | What it does |
|---|---|
| `setup` | Adds the Settings tab and missing RSVP columns. Safe to run again. |
| `installReminderTrigger` | Daily reminder trigger, 10–11 AM Miami time. |
| `sendReminders` | What the trigger runs. Sends only on the event date, only to that date's RSVPs, never on a skip week, once per email. |
| `showCurrentEvent` | Logs the current night, its source (auto/override) and the settings. |
| `testConfirmation` | Emails you a test confirmation and reminder. |
| `backfillEventDates` | Fills Event date on rows saved before the column existed. |
| `sendMissingConfirmations` | Sends confirmations to the upcoming night's RSVPs that have none recorded. |
| `assignMissingCodes`, `setDoorPin` | Check-in codes and the door PIN (unchanged). |

Mail limit: a consumer Gmail account can send about 100 emails a day, confirmations and reminders together.
