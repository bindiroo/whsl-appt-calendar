# Jetty — Wholesale Appointment Calendar

A live appointment-booking site for trade shows and sales meetings. One link shows a grid of days × stations × time slots; click an open slot to book it. Bookings land in a Google Sheet you own, and confirmation emails go out from your own Google account.

Built to replace the manual planning spreadsheet — and to make Calendly unnecessary.

- **Front end:** plain HTML/CSS/JS, no build step, hosted on Netlify
- **Branding:** 2025 Jetty Brand Guide — Graphite / Deep Sea / Atlantic / Cloud / Grey Sky
- **Back end:** Google Apps Script Web App writing to a Google Sheet
- **Cost:** $0

---

## Who sees what

Three levels, enforced on the server — not just hidden in the page.

> **As shipped, the admin and rep passwords are both `jetty5dyol`.** Because the server checks the admin password first, that means anyone who signs in is an **admin** — so in practice you're running two tiers, not three: retailers with no password, and staff with full access. Retailers are unaffected either way. To get the limited rep tier back, run `setPasswords('adminOnly', 'repOnly')` in the Apps Script editor and re-deploy.

| | Retailer | Rep | Admin |
|---|:--:|:--:|:--:|
| Password needed | none | rep password | admin password |
| See which slots are open | ✅ | ✅ | ✅ |
| See **who** is booked in a slot | ❌ | ✅ | ✅ |
| See contact email / phone / notes | ❌ | ✅ | ✅ |
| Book an open slot | ✅ | ✅ | ✅ |
| Cancel their own booking | ✅ *(link in their email)* | ✅ | ✅ |
| Cancel anyone's booking | ❌ | ✅ | ✅ |
| Block off slots | ❌ | ❌ | ✅ |
| Create / edit events | ❌ | ❌ | ✅ |
| Export bookings | ❌ | ❌ | ✅ |

A retailer sees a taken slot as a grey **Booked** cell and nothing more. Names, emails, phone numbers and notes are stripped out of the API response before it leaves the server, so there is nothing to dig out of the page source either.

**Getting reps in.** Share the staff magic link — run `showPasswords()` in the Apps Script editor and it prints one:

```
https://your-site.netlify.app/event.html?e=surf-expo-fall-2026&k=<rep-password>
```

Clicking it once stores the password in that browser and immediately scrubs it out of the address bar. Anyone who has lost the link can use **Staff sign-in** in the header instead — one box takes either the rep or the admin password, and the server works out which. **Sign out** in the same spot drops back to the retailer view.

> The rep password is a convenience boundary, not a vault. Anyone a rep forwards the link to gets the rep view. It stops retailers seeing each other's business; it isn't built to withstand a determined attacker.

---

## Pages

| Page | Who | What it's for |
|---|---|---|
| `index.html` | anyone | List of events |
| `event.html?e=<id>` | anyone | The booking grid — **this is the link you share** |
| `new.html` | admin | Create a new event |
| `admin.html?e=<id>` | admin | All bookings, CSV export, block off slots |

Netlify also serves short links: `/e/<event-id>` and `/manage/<event-id>`.

---

## Setup (one time, ~10 minutes)

### 1. Create the database sheet

1. Go to [sheets.new](https://sheets.new) and name it something like **Jetty Appointments — Bookings**.
2. **Extensions → Apps Script.**
3. Delete whatever is in `Code.gs` and paste in the contents of [`apps-script/Code.gs`](apps-script/Code.gs). Save.
4. Click **+** next to *Files*, add a script file named `Seed`, and paste in [`apps-script/Seed.gs`](apps-script/Seed.gs). Save.
5. In the function dropdown at the top, choose **`setup`** and press **Run**. Approve the permissions prompt (it will warn that the app isn't verified — that's normal for your own script; choose *Advanced → Go to …*).

You should now see three tabs in the sheet (**Events**, **Bookings**, **Blocks**), and the execution log will confirm your staff password:

```
  STAFF password : jetty5dyol
```

`showPasswords()` prints it again any time. To change it:

```js
setPasswords('newAdminPassword', 'newRepPassword')   // two tiers
useDefaultPasswords()                                 // back to jetty5dyol for both
```

If you'd already run `setup()` before and it generated something random, `useDefaultPasswords()` resets both.

### 2. Deploy the API

1. **Deploy → New deployment.**
2. Gear icon next to *Select type* → **Web app**.
3. **Execute as:** `Me` · **Who has access:** `Anyone`
4. **Deploy**, then copy the **Web app URL** (ends in `/exec`).

> **Who has access: Anyone** is required — the booking page calls this URL from visitors' browsers. It gives nobody access to your Google account or the sheet itself; they can only do what this script allows, which is what the table above describes.

### 3. Connect the website

Open [`config.js`](config.js) in this repo (GitHub's pencil icon works fine) and replace the placeholder:

```js
window.SHOWTIME_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfy..../exec',
  REFRESH_MS: 15000
};
```

Commit. Netlify redeploys in about 30 seconds.

### 4. Tell the script where the site lives

Back in Apps Script, run:

```js
setSiteUrl('https://your-site.netlify.app')
```

This is what puts a working **Cancel this appointment** link in confirmation emails, and it makes `showPasswords()` print a ready-to-share rep magic link.

### 5. Create the Surf Expo event

Either fill in the form at `/new.html`, or run the shortcut: pick **`seedSurfExpo`** in the Apps Script editor and press **Run**. That creates *Surf Expo — Fall 2026*, Sept 16–18, Orange County Convention Center, four stations, 60-minute slots, 9am–6pm.

To carry over the appointments already penciled into the old planning sheet, run **`seedSurfExpoBookings`** as well. It writes them in silently — no emails fire.

---

## After any change to the Apps Script

**Deploy → Manage deployments → pencil icon → Version: New version → Deploy.**
The URL stays the same, so you never have to touch `config.js` again.

---

## How double-booking is prevented

Every write goes through `LockService.getScriptLock()`. Inside the lock the script re-reads the Bookings sheet, rejects the write if that date + station + time is already taken, and flushes the write before releasing the lock. Two people hitting *Confirm* on the same slot at the same moment means one succeeds and the other gets *"that slot was just taken — pick another one"* (deliberately without naming who got it). The grid also re-polls every 15 seconds, so open pages stay current.

## Emails

Sent by `MailApp` from the Google account that owns the script. Every booking sends:

- the retailer an HTML + plain-text confirmation, an `.ics` calendar invite, and a private **Cancel this appointment** link
- you a copy, if the event has a **Notify Email** set (without the retailer's private cancel link)

Cancellations email both parties. Google Workspace accounts can send ~1,500 emails/day; free Gmail accounts ~100/day.

## Data

Everything lives in the sheet, so you can filter, pivot, or export it however you like.

- **Events** — one row per event; days and stations are stored as JSON
- **Bookings** — one row per appointment; cancelling flips `status` to `cancelled` rather than deleting the row, so you keep the history
- **Blocks** — slots that are off-limits (lunch, walkthroughs, hard stops)

`cancel_token` is the secret behind each retailer's self-cancel link. It is never included in any list the API returns — only in that one confirmation email.

## Reusing this for the next show

**New Event** → name, venue, dates, per-day hours, stations, slot length. Nothing is hard-coded to Surf Expo; the station names just default to the four from the current planning sheet. Share the new link and you're running.

## Local development

```bash
node docs/unit.js            # unit checks on the Apps Script time/date helpers
node docs/test.js            # full end-to-end suite (starts its own mock server)
node docs/mock-server.js     # or run the mock alone: http://localhost:8787
```

`docs/test.js` boots a throwaway copy of the mock on its own port, so it starts from identical state every run and needs nothing set up first. The mock stands in for Apps Script — three roles included — so you can work on the front end without deploying; its test passwords are `admin-pass-1234` and `rep-pass-5678`. Nothing in `docs/` ships to production.

The suite checks permissions at the API level, not just in the UI — it calls the endpoints directly as each role to confirm the server, not the stylesheet, is what's keeping retailers out.

## Branding

Colours come straight from the 2025 Brand Guide and live as CSS custom properties at the top of `assets/styles.css`:

| Token | Hex | Use |
|---|---|---|
| `--graphite` | `#252933` | Banner, headings, primary buttons |
| `--deep-sea` | `#43575E` | Accents, booked-slot marker, focus rings |
| `--atlantic` | `#586D72` | Higher-contrast variant on dark grounds |
| `--cloud` | `#F6F7F7` | Page background, reversed text |
| `--grey-sky` | `#EDECED` | Time column, anonymous booked cells |

Logo files are in `assets/brand/`, extracted from the supplied artwork onto transparency so they sit on any ground: `jetty-logo-white.png` (banner), `otis-coin-white.png`, `otis-coin-dark.png` (favicon, footer, password gate), and `bathymetry.png` — the seamless map pattern, lightened to a whisper and tiled behind the page.

**Fonts.** The guide specifies Gilroy for headlines and Blacker Text for body. Both are licensed, so the CSS asks for them first and falls back to Montserrat and Petrona from Google Fonts. If you have the webfont files, drop them in `assets/fonts/` and uncomment the `@font-face` block at the top of `assets/styles.css` — nothing else needs to change.

---

*Draw Your Own Line®*
