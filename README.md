# Tracker

**Your next GO Train, live. Always on track.**

Tracker is a fast, installable app that shows the next **GO Transit** (Toronto) train
departures for the trips you actually take. Open it and your saved trips show their
next few departures instantly — with a live countdown — and it keeps working even
with no signal underground or on the train.

It's built for the daily commuter who rides the same one or two trips every day:
no clutter, no trip-planning wizardry, just *"when's my next train and when does it
get there."*

## What you get

- **Saved trips at a glance** — pin your regular trips (e.g. Acton → Bloor) and see
  the next departures the moment you open the app.
- **Live countdowns** — "in 1 min", "in 14 min", with the exact departure and arrival
  times next to each.
- **Trip detail** — a stop-by-stop timeline for any departure, plus station amenities
  (parking, accessibility, etc.).
- **Connecting buses** — at a rail station, a read-only board shows the next bus
  departures so you can catch your connection.
- **Works offline** — once opened, the whole schedule is cached on your device.
- **Installs like an app** — add it to your home screen; it opens full-screen with no
  browser bars.
- **Dark & light themes** and **12/24-hour time**.

## How it works

Tracker is a **Progressive Web App (PWA)** — a website that installs and behaves like
a native app, with no app store needed.

- **Schedules, not guesses.** Times come from Metrolinx's official published GO
  timetable (the GTFS feed). They're the *scheduled* times — Tracker doesn't (yet)
  show real-time delays.
- **Smart about dates.** The real timetable changes through the year (spring vs.
  summer service) and on holidays. Tracker knows which schedule applies to the day
  you're looking at, so Canada Day, summer weekdays, and weekends all show the trains
  that actually run.
- **Offline-first.** The app and the full schedule are downloaded once and cached, so
  it loads instantly and keeps working with no connection. When you're online it
  quietly checks for a newer schedule in the background.
- **Tiny and private.** The entire schedule is packed into a small data file the app
  reads locally. There's no account, no tracking, and no server calls while you use it.

This is an early version: **7 rail lines, direct trips only, scheduled times.** See
[What's not included](#whats-not-included) below.

## Using it

1. Open the app and tap **Search** to pick your origin and destination.
2. Tap the star / **Add a trip** to save it — it now appears on your **Home** screen.
3. Tap any departure to see the full stop-by-stop timeline and station info.
4. To keep it handy, **install it**: on iPhone tap the Share button → *Add to Home
   Screen*; on Android/Chrome use the install prompt or the menu's *Install* option.

---

## Run it yourself

Everything below is only needed if you want to host your own copy or rebuild the
schedule data. Casual users can stop here.

### Project layout

```
build-index.js              # turns the GTFS feed into the app's compact data files
GO-GTFS Files/              # raw Metrolinx GTFS feed (.txt)
docs/                       # the app itself — this is what GitHub Pages serves
  index.html  app.js  styles.css
  manifest.webmanifest  sw.js  icon.svg  icon-maskable.svg
  data/                     # generated schedule data (index.json + trips-s*.json)
```

### 1. Build the schedule data

Turns the raw GTFS feed into the compact JSON the app loads:

```bash
node build-index.js "GO-GTFS Files" docs/data
```

This produces:

- `index.json` — stations, lines, and the date→schedule calendar.
- `trips-s1.json … trips-sN.json` — one file per distinct schedule variant
  (e.g. summer weekday, Saturday), each a list of trips and their stop times.
- `bus.json` — only when the feed includes buses; a per-station board of connecting
  bus departures.

Times are stored as **minutes after midnight** (times past midnight like `25:30` are
kept as `1530`, not wrapped), and dates are grouped into a handful of schedule
variants so the app shows the right trains for any given day.

### 2. Run locally

```bash
cd docs
python3 -m http.server 8099
# open http://localhost:8099
```

To try it on your phone on the same Wi-Fi, open `http://<your-computer-ip>:8099`.
(Installing and full offline support need HTTPS, e.g. GitHub Pages — `localhost`
also counts as secure for local testing.)

### 3. Deploy to GitHub Pages

1. Commit and push (including `docs/` and `docs/data/`).
2. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*,
   Branch = `main`, Folder = **`/docs`**.
3. Open the published URL on your phone → **Add to Home Screen**.

All paths are relative, so it works under a `/<repo>/` project-pages subpath.

### 4. Update the schedule when a new feed drops

1. Replace the contents of `GO-GTFS Files/` with the new Metrolinx GTFS feed.
2. `node build-index.js "GO-GTFS Files" docs/data`
3. Bump `CACHE` in `docs/sw.js` (e.g. `tracker-v4` → `tracker-v5`) so returning users
   pick up the new data.
4. Commit and push — returning users auto-update on next open.

## What's not included

Deliberately left out of this version:

- **Transfers / connections at Union** — cross-line searches show a "no direct trips" state.
- **Real-time delays** — times are scheduled only, not live GTFS-RT.
- **Full bus trip planning** — buses appear only as a station departures board, not as
  routable origin→destination trips.

## Appendix: data format (for contributors)

Generated by `build-index.js` into `docs/data/`:

- **`index.json`** — `{ meta, variants, defaults, calendar, lines, stations }`.
  - `stations`: ~70 rail stations, each `{ id, name, lat, lon, code, zone,
    wheelchair, amenities[], lines[] }`.
  - `meta`: includes `feedStart` / `feedEnd` (the feed's validity window) and a
    `hasBus` flag.
  - `calendar`: maps every date in the window → schedule variant id (`"none"` if no
    service). `defaults` gives the fallback variant per day-of-week for dates outside
    the window. Only rail routes (`route_type=2`) are indexed.
- **`trips-s1.json … trips-sN.json`** — one file per schedule variant; each an array of
  `{ line, dir, headsign, stops: [[stopId, departMinutes], ...] }`.
- **`bus.json`** (only if `meta.hasBus`) — `{ busDepartures }`, where
  `busDepartures[stationId][weekday|saturday|sunday] = [[line, headsign, dir, departMinutes], ...]`.
  Only bus departures **at a rail station** are kept (bus-bay stops are matched to
  their rail station via `parent_station`), grouped by day-type using the busiest
  representative service date. Referenced bus lines are added to `lines` with
  `type: "bus"`.

**Times** are minutes after midnight; values past midnight (e.g. `25:30`) are kept as
`1530`, not wrapped. Convert back with `const h = Math.floor(m/60)%24, min = m%60`.

**Schedule variants:** every `service_id` in GO's feed is a single date, and the real
timetable changes through the feed window and on holidays. The build groups dates with
an identical trip set into a small number of variants, so each day shows the trains
that actually run.
