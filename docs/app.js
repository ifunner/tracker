/* Tracker — GO Transit train PWA, vanilla app wired to the generated GTFS index. */
'use strict';

const DATA = { lines: {}, stations: [], byId: {}, schedules: {}, calendar: {}, defaults: {}, meta: null };

const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('go.' + k)) ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('go.' + k, JSON.stringify(v)); } catch (e) {} },
};

const state = {
  themeMode: LS.get('themeMode', 'auto'),   // 'auto' | 'dark' | 'light'
  theme: 'dark',                            // effective theme (computed)
  use24: LS.get('use24', false),
  modeFilter: LS.get('modeFilter', 'both'),   // 'both' | 'train' | 'bus'
  settingsOpen: false,
  saved: LS.get('saved', []),            // route favourites: [{o, d}] of stop ids
  pins: LS.get('pins', []),              // pinned departures: [{o, d, line, dayType, depMin}]
  recents: LS.get('recents', []),        // [{o, d}]
  installDismissed: LS.get('installDismissed', false),
  pickerView: LS.get('pickerView', 'grouped'),   // 'grouped' (by line) | 'az'
  screen: 'home',
  activeTab: 'home',
  origin: null, dest: null,
  picker: null, query: '',
  dateStr: '', timeStr: '', leaveNow: true,
  expanded: {},
  detail: null, backTo: 'home',
  now: Date.now(),
};

/* ---- time + color helpers ------------------------------------------------ */

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtTime(ms) {
  const d = new Date(ms); let h = d.getHours(); const m = d.getMinutes();
  if (state.use24) return pad(h) + ':' + pad(m);
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12; if (h === 0) h = 12;
  return h + ':' + pad(m) + ' ' + ap;
}
function applyTheme() {
  state.theme = state.themeMode === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : state.themeMode;
}
function dayTypeOf(d) { const g = d.getDay(); return g === 0 ? 'sunday' : g === 6 ? 'saturday' : 'weekday'; }
function ymd(d) { return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; }
function endOfToday() { const d = startOfDay(state.now); d.setDate(d.getDate() + 1); return d.getTime(); }
function dayLabel(ms) {
  const diff = Math.round((startOfDay(ms).getTime() - startOfDay(state.now).getTime()) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

// Trips that actually run on a given date (handles spring/summer/holiday changes).
// Dates inside the feed window use their exact schedule variant; dates outside
// fall back to the default variant for that day-of-week.
function tripsForDate(d) {
  const key = DATA.calendar[ymd(d)];
  if (key === 'none') return null;
  if (key && DATA.schedules[key]) return DATA.schedules[key];
  const def = DATA.defaults[dayTypeOf(d)];
  return def ? DATA.schedules[def] : null;
}
function feedExpired() { return DATA.meta && DATA.meta.feedEnd && ymd(new Date(state.now)) > DATA.meta.feedEnd; }
function fmtFeedDate(s) {
  if (!s) return '';
  const dt = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function inLabel(depAbs) {
  const mins = Math.ceil((depAbs - state.now) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return 'in ' + mins + ' min';
  const h = Math.floor(mins / 60), m = mins % 60;
  return 'in ' + h + 'h ' + pad(m) + 'm';
}
function mmss(depAbs) {
  let s = Math.floor((depAbs - state.now) / 1000); if (s < 0) s = 0;
  if (s >= 3600) return inLabel(depAbs);
  return Math.floor(s / 60) + 'm ' + pad(s % 60) + 's';
}
// A departure is "soon" when it's today and leaves within the next 30 minutes.
function isSoon(depAbs) {
  const diff = depAbs - state.now;
  return diff >= 0 && diff < 30 * 60000;
}

function mix(hex, t) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
  return 'rgb(' + Math.round(r + (255 - r) * t) + ',' + Math.round(g + (255 - g) * t) + ',' + Math.round(b + (255 - b) * t) + ')';
}
function lineColor(code) { return (DATA.lines[code] || {}).color || '#777'; }
function lineDisp(code) { const c = lineColor(code); return state.theme === 'dark' ? mix(c, 0.34) : c; }
function lineName(code) { return (DATA.lines[code] || {}).long || code; }
function lineMode(code) { return (DATA.lines[code] || {}).type === 'bus' ? 'bus' : 'train'; }
function showTrains() { return state.modeFilter !== 'bus'; }
function showBuses() { return state.modeFilter !== 'train'; }
// Small inline glyph distinguishing rail vs bus services (uses currentColor).
function modeIcon(mode) {
  const train = '<path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5V21h2.5l1.5-1.5h4L15.5 21H18v-.5L16.5 19A3.5 3.5 0 0 0 20 15.5V6c0-3.5-4-4-8-4ZM7.5 17A1.5 1.5 0 1 1 9 15.5 1.5 1.5 0 0 1 7.5 17ZM11 11H6V6h5Zm2 0V6h5v5Zm3.5 6a1.5 1.5 0 1 1 1.5-1.5 1.5 1.5 0 0 1-1.5 1.5Z"/>';
  const bus = '<path d="M4 16c0 .88.39 1.67 1 2.22V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4S4 2.5 4 6Zm3.5 1A1.5 1.5 0 1 1 9 15.5 1.5 1.5 0 0 1 7.5 17Zm9 0a1.5 1.5 0 1 1 1.5-1.5 1.5 1.5 0 0 1-1.5 1.5ZM18 11H6V6h12Z"/>';
  return `<svg class="mode-ic" viewBox="0 0 24 24" aria-hidden="true">${mode === 'bus' ? bus : train}</svg>`;
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function shortName(id) {
  const st = DATA.byId[id]; if (!st) return id;
  return st.name.replace(' Station GO', '').replace(' GO', '');
}
function cleanHeadsign(h) { return (h || '').replace(/^[A-Z]{2}\s*-\s*/, '').replace(' Station GO', '').replace(' GO', ''); }

/* ---- trip search --------------------------------------------------------- */

function searchPair(oid, did, fromDate, count) {
  const out = [];
  for (let off = 0; off < 3 && out.length < count; off++) {
    const base = startOfDay(fromDate.getTime()); base.setDate(base.getDate() + off);
    const trips = tripsForDate(base);
    if (!trips) continue;
    const baseMs = base.getTime();
    const fromMin = off === 0 ? fromDate.getHours() * 60 + fromDate.getMinutes() : -1;
    const hits = [];
    for (const t of trips) {
      let oi = -1, di = -1;
      for (let i = 0; i < t.stops.length; i++) {
        if (t.stops[i][0] === oid && oi < 0) oi = i;
        else if (t.stops[i][0] === did) { di = i; }
      }
      if (oi < 0 || di < 0 || di <= oi) continue;
      const depMin = t.stops[oi][1];
      if (off === 0 && depMin < fromMin) continue;
      const arrMin = t.stops[di][1];
      hits.push({ trip: t, oi, di, line: t.line, depAbs: baseMs + depMin * 60000, arrAbs: baseMs + arrMin * 60000, duration: arrMin - depMin });
    }
    hits.sort((a, b) => a.depAbs - b.depAbs);
    for (const h of hits) { out.push(h); if (out.length >= count) break; }
  }
  return out;
}

// Ordered station list per line, taken from the longest trip (preferring the
// inbound direction so the outer terminus is first and Union is last).
function buildLineStations() {
  DATA.lineStations = {};
  for (const code of Object.keys(DATA.lines)) {
    let best = null;
    for (const k in DATA.schedules) {
      for (const t of DATA.schedules[k]) {
        if (t.line !== code) continue;
        if (!best) { best = t; continue; }
        const better = t.stops.length > best.stops.length ||
          (t.stops.length === best.stops.length && t.dir === 1 && best.dir !== 1);
        if (better) best = t;
      }
    }
    DATA.lineStations[code] = best ? best.stops.map((s) => s[0]) : [];
  }
}

function commonLine(oid, did) {
  const a = (DATA.byId[oid] || {}).lines || [], b = (DATA.byId[did] || {}).lines || [];
  const c = a.find((x) => b.includes(x));
  return c || a[0] || b[0] || 'LW';
}

/* ---- persistence actions ------------------------------------------------- */

function save(k) { LS.set(k, state[k]); }
function toggleSaveTrip(oid, did) {
  const i = state.saved.findIndex((t) => t.o === oid && t.d === did);
  if (i >= 0) { state.saved.splice(i, 1); save('saved'); toast('Route removed from Home'); }
  else { state.saved.push({ o: oid, d: did }); save('saved'); toast('Route saved to Home'); }
  render();
}

function findPin(o, d, line, dayType, depMin) {
  return state.pins.findIndex((p) => p.o === o && p.d === d && p.line === line && p.dayType === dayType && p.depMin === depMin);
}
function isPinned(o, d, line, dayType, depMin) { return findPin(o, d, line, dayType, depMin) >= 0; }
function togglePin(o, d, line, dayType, depMin) {
  const i = findPin(o, d, line, dayType, depMin);
  if (i >= 0) { state.pins.splice(i, 1); save('pins'); toast('Departure unpinned'); }
  else { state.pins.push({ o, d, line, dayType, depMin }); save('pins'); toast('Departure pinned to Home'); }
  render();
}
function removePin(o, d, line, dayType, depMin) {
  const i = findPin(o, d, line, dayType, depMin);
  if (i >= 0) { state.pins.splice(i, 1); save('pins'); render(); }
}
// Day-type of the service day a departure belongs to (handles past-midnight times).
function serviceDayType(depAbs, depMin) { return dayTypeOf(new Date(depAbs - depMin * 60000)); }
// Next occurrence of a pinned departure: scan upcoming dates (same day-class)
// and return the first where this exact train actually runs in that date's schedule.
function nextPinOccurrence(p) {
  for (let off = 0; off < 120; off++) {
    const base = startOfDay(state.now); base.setDate(base.getDate() + off);
    if (dayTypeOf(base) !== p.dayType) continue;
    const trips = tripsForDate(base);
    if (!trips) continue;
    for (const t of trips) {
      if (t.line !== p.line) continue;
      let oi = -1, di = -1;
      for (let i = 0; i < t.stops.length; i++) {
        if (t.stops[i][0] === p.o && t.stops[i][1] === p.depMin && oi < 0) oi = i;
        else if (t.stops[i][0] === p.d) di = i;
      }
      if (oi >= 0 && di > oi) {
        const depAbs = base.getTime() + p.depMin * 60000;
        if (depAbs >= state.now - 60000) {
          return { depAbs, arrAbs: base.getTime() + t.stops[di][1] * 60000, duration: t.stops[di][1] - p.depMin, trip: t, oi, di };
        }
      }
    }
  }
  return null;
}
function dayTypeLabel(dt) { return dt === 'weekday' ? 'Weekday' : dt === 'saturday' ? 'Saturday' : 'Sunday'; }
function pushRecent(oid, did) {
  state.recents = [{ o: oid, d: did }].concat(state.recents.filter((r) => !(r.o === oid && r.d === did))).slice(0, 4);
  save('recents');
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/* ---- rendering ----------------------------------------------------------- */

function statusbar() {
  const isDark = state.theme === 'dark';
  return `<div class="statusbar">
    <div class="brand" aria-label="Tracker">
      <svg class="brand-mark" viewBox="0 0 12 30" aria-hidden="true">
        <rect class="rail" x="4.5" y="2.5" width="3" height="25" rx="1.5"/>
        <circle class="rail" cx="6" cy="3.5" r="2.4"/>
        <circle class="rail" cx="6" cy="26.5" r="2.4"/>
        <circle class="live" cx="6" cy="12" r="3.8"/>
      </svg>
      <span class="brand-name">Tracker</span>
    </div>
    <div class="right">
      <button class="theme-btn" data-act="toggleTheme" aria-label="Toggle theme">
        ${isDark ? '<div class="moon"></div>' : '<div class="sun"></div>'}
      </button>
      <button class="theme-btn gear-btn" data-act="openSettings" aria-label="Settings">⚙</button>
    </div>
  </div>`;
}

function settingsSheet() {
  if (!state.settingsOpen) return '';
  const m = state.themeMode;
  const seg = (mode, label) => `<button class="${m === mode ? 'on' : ''}" data-act="setTheme" data-mode="${mode}">${label}</button>`;
  const mf = state.modeFilter;
  const segMode = (mode, label) => `<button class="${mf === mode ? 'on' : ''}" data-act="setMode" data-mode="${mode}">${label}</button>`;
  const valid = (DATA.meta && DATA.meta.feedStart)
    ? `Schedule valid ${fmtFeedDate(DATA.meta.feedStart)} – ${fmtFeedDate(DATA.meta.feedEnd)}` : '';
  return `<div class="sheet-backdrop" data-act="closeSettings"></div>
    <div class="sheet" role="dialog" aria-label="Settings">
      <div class="sheet-head"><div class="t">Settings</div><button class="x" data-act="closeSettings" aria-label="Close">×</button></div>
      <div class="set-row"><div class="set-label">Appearance</div><div class="seg3">${seg('auto', 'Auto')}${seg('dark', 'Dark')}${seg('light', 'Light')}</div></div>
      <div class="set-row"><div class="txt"><div class="set-label">Services</div><div class="set-sub">Show trains, buses, or both</div></div><div class="seg3">${segMode('both', 'Both')}${segMode('train', 'Train')}${segMode('bus', 'Bus')}</div></div>
      <button class="set-row toggle" data-act="toggle24" aria-pressed="${state.use24}">
        <div class="txt"><div class="set-label">24-hour time</div><div class="set-sub">Show 17:30 instead of 5:30 PM</div></div>
        <div class="switch ${state.use24 ? 'on' : ''}"><div class="knob"></div></div></button>
      ${valid ? `<div class="set-info">${valid}</div>` : ''}
    </div>`;
}

function tabbar() {
  const t = state.activeTab;
  return `<nav class="tabbar" aria-label="Primary">
    <button class="tab ${t === 'home' ? 'on' : ''}" data-act="goHome" ${t === 'home' ? 'aria-current="page"' : ''}><div class="ic-home"></div><span class="label">Home</span></button>
    <button class="tab ${t === 'search' ? 'on' : ''}" data-act="goSearch" ${t === 'search' ? 'aria-current="page"' : ''}><div class="ic-search"></div><span class="label">Search</span></button>
    <button class="tab ${t === 'saved' ? 'on' : ''}" data-act="goSaved" ${t === 'saved' ? 'aria-current="page"' : ''}><div class="ic-star">${t === 'saved' ? '★' : '☆'}</div><span class="label">Saved</span></button>
  </nav>`;
}

function depRowHtml(h, o, d) {
  return `<div class="dep-row" data-act="openDetail" role="button" tabindex="0" data-o="${o}" data-d="${d}" data-dep="${h.depAbs}">
    <div class="l"><span class="time">${fmtTime(h.depAbs)}</span><span class="sub">arr ${fmtTime(h.arrAbs)}</span></div>
    <span class="in" data-live="in" data-dep="${h.depAbs}">${inLabel(h.depAbs)}</span>
  </div>`;
}
function cardHtml(trip) {
  const { o, d } = trip;
  const deps = searchPair(o, d, new Date(state.now), 6);
  const code = deps[0] ? deps[0].line : commonLine(o, d);
  const key = o + '>' + d;
  const expanded = !!state.expanded[key];
  const head = `<div class="card-top">
      <div class="card-od">
        <span class="badge" style="background:${lineColor(code)}">${code}</span>
        <div class="od-text">${esc(shortName(o))} <span class="arr">→</span> ${esc(shortName(d))}</div>
      </div>
      <button class="icon-btn" data-act="reverse" data-o="${o}" data-d="${d}" aria-label="Reverse direction">⇅</button>
    </div>`;

  if (!deps.length) {
    return `<div class="card" data-act="noop">${head}
      <div class="svc-done"><div class="ic"><div class="moon"></div></div>
        <div><div class="t">No upcoming service</div><div class="s">No trips found for this route</div></div></div></div>`;
  }

  const soonest = deps[0];
  const serviceDone = soonest.depAbs >= endOfToday();
  if (serviceDone) {
    return `<div class="card" data-act="openDetail" role="button" tabindex="0" data-o="${o}" data-d="${d}" data-dep="${soonest.depAbs}">${head}
      <div class="svc-done"><div class="ic"><div class="moon"></div></div>
        <div><div class="t">Service done for today</div>
        <div class="s">Next train · <span style="color:var(--text);font-weight:600">${fmtTime(soonest.depAbs)}</span></div></div></div></div>`;
  }

  const more = deps.slice(1, expanded ? 5 : 3);
  return `<div class="card" data-act="toggleCard" data-key="${key}">${head}
    <div class="hero-row" data-act="openDetail" role="button" tabindex="0" data-o="${o}" data-d="${d}" data-dep="${soonest.depAbs}">
      <div class="hero-time">${fmtTime(soonest.depAbs)}</div>
      <div class="hero-meta">
        <div class="in-pill" data-live="in" data-dep="${soonest.depAbs}">${inLabel(soonest.depAbs)}</div>
        <div class="hero-sub"><span data-live="mmss" data-dep="${soonest.depAbs}">${mmss(soonest.depAbs)}</span> · arr ${fmtTime(soonest.arrAbs)} · ${soonest.duration} min</div>
      </div>
    </div>
    <div class="dep-list">
      ${more.map((h) => depRowHtml(h, o, d)).join('')}
      <div class="expand" data-act="toggleCard" data-key="${key}" role="button" tabindex="0">${expanded ? 'Show less ▴' : 'Show more departures ▾'}</div>
    </div>
  </div>`;
}

function pinCardHtml(p) {
  const code = p.line;
  const data = `data-o="${p.o}" data-d="${p.d}" data-line="${code}" data-daytype="${p.dayType}" data-depmin="${p.depMin}"`;
  const head = `<div class="card-top">
      <div class="card-od">
        <span class="badge" style="background:${lineColor(code)}">${code}</span>
        <div class="od-text">${esc(shortName(p.o))} <span class="arr">→</span> ${esc(shortName(p.d))}</div>
      </div>
      <button class="icon-btn" data-act="unpin" ${data} aria-label="Unpin departure">×</button>
    </div>`;
  const occ = nextPinOccurrence(p);
  if (!occ) {
    return `<div class="card pin-card">
      <div class="eyebrow-pin">Pinned departure · ${dayTypeLabel(p.dayType)}</div>${head}
      <div class="svc-done"><div class="ic"><div class="moon"></div></div>
        <div><div class="t">No upcoming run</div><div class="s">This departure isn't in the current schedule</div></div></div></div>`;
  }
  return `<div class="card pin-card" data-act="openDetail" role="button" tabindex="0" data-o="${p.o}" data-d="${p.d}" data-dep="${occ.depAbs}">
    <div class="eyebrow-pin">Pinned departure · ${dayTypeLabel(p.dayType)}</div>${head}
    <div class="hero-row">
      <div class="hero-time">${fmtTime(occ.depAbs)}</div>
      <div class="hero-meta">
        <div class="in-pill" data-live="in" data-dep="${occ.depAbs}">${inLabel(occ.depAbs)}</div>
        <div class="hero-sub">arr ${fmtTime(occ.arrAbs)} · ${occ.duration} min</div>
      </div>
    </div>
  </div>`;
}

function homeScreen() {
  const hasRoutes = state.saved.length > 0;
  const hasPins = state.pins.length > 0;
  const greetHour = new Date(state.now).getHours();
  const greeting = greetHour < 12 ? 'Good morning' : greetHour < 18 ? 'Good afternoon' : 'Good evening';
  let body;
  if (!hasRoutes && !hasPins) {
    body = `<div class="empty"><div class="box">★</div>
      <div class="h">No saved trips yet</div>
      <div class="p">Search a route, then save the whole route or pin a specific departure. We'll show your next trains the moment you open the app.</div>
      <button class="btn-primary" data-act="goSearch">Find a trip</button></div>`;
  } else {
    const routesSection = hasRoutes
      ? (hasPins ? '<div class="section-label">Saved routes</div>' : '') + state.saved.map(cardHtml).join('')
      : '';
    const pinsSection = hasPins
      ? '<div class="section-label">Pinned departures</div>' + state.pins.map(pinCardHtml).join('')
      : '';
    body = installBanner() + routesSection + pinsSection +
      `<button class="add-trip" data-act="goSearch">+  Add a trip</button>`;
  }
  return `<div class="screen"><div class="scroll" data-scroll="home">
    <div class="head">
      <div class="eyebrow">${greeting}</div><div class="title">Your trips</div>
    </div>
    ${freshnessBanner()}
    ${body}
  </div></div>`;
}

let deferredPrompt = null;
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream; }
function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
function installBanner() {
  if (state.installDismissed || isStandalone()) return '';
  if (deferredPrompt) {
    return `<div class="install">
      <div class="logo">GO</div>
      <div class="body"><div class="t">Install Tracker</div><div class="s">Add to home screen · works offline</div></div>
      <div class="actions"><button class="go" data-act="doInstall">Install</button>
      <button class="x" data-act="dismissInstall" aria-label="Dismiss">×</button></div></div>`;
  }
  if (isIOS()) {
    return `<div class="install">
      <div class="logo">GO</div>
      <div class="body"><div class="t">Install Tracker</div><div class="s">Tap Share, then “Add to Home Screen”</div></div>
      <button class="x" data-act="dismissInstall" aria-label="Dismiss">×</button></div>`;
  }
  return '';
}

function freshnessBanner() {
  if (!feedExpired()) return '';
  return `<div class="stale-banner">
    <div class="ic">!</div>
    <div><div class="t">Schedule out of date</div>
      <div class="s">This timetable expired ${fmtFeedDate(DATA.meta.feedEnd)}. Times shown may be wrong until the app data is updated.</div></div>
  </div>`;
}

function stRowHtml(s, dotColor, rightCode) {
  return `<div class="st-row" data-act="pickStation" role="button" tabindex="0" data-id="${s.id}">
    <div class="dot" style="background:${dotColor}"></div>
    <div class="name">${esc(s.name)}</div><span class="code">${rightCode}</span></div>`;
}

function stationListHtml() {
  const q = state.query.trim().toLowerCase();
  const match = (s) => !q || s.name.toLowerCase().includes(q);

  if (state.pickerView === 'az') {
    const rows = DATA.stations.filter(match).map((s) => {
      const hub = s.lines.length > 1;
      return stRowHtml(s, hub ? '#8b949a' : lineDisp(s.lines[0]), hub ? 'HUB' : s.lines[0]);
    }).join('');
    return rows || `<div class="picker-empty">No stations match “${esc(state.query)}”.</div>`;
  }

  // grouped by line, stations listed in order along the line
  let html = '';
  for (const code of Object.keys(DATA.lines)) {
    const ids = DATA.lineStations[code] || [];
    const rows = ids.map((id) => DATA.byId[id]).filter((s) => s && match(s));
    if (!rows.length) continue;
    html += `<div class="st-group">
      <span class="badge sm" style="background:${lineColor(code)}">${code}</span>
      <span class="st-group-name">${esc(lineName(code))}</span></div>`;
    html += rows.map((s) => stRowHtml(s, lineDisp(code), s.code || s.id)).join('');
  }
  return html || `<div class="picker-empty">No stations match “${esc(state.query)}”.</div>`;
}

function setPickerView(v) {
  state.pickerView = v; save('pickerView');
  const list = document.getElementById('stlist');
  if (list) list.innerHTML = stationListHtml();
  document.querySelectorAll('.picker-toggle button').forEach((b) => {
    b.classList.toggle('on', (v === 'grouped' && b.dataset.act === 'pickerGrouped') || (v === 'az' && b.dataset.act === 'pickerAZ'));
  });
}

function searchScreen() {
  const isoDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const todayStr = isoDate(new Date(state.now));
  const tmr = new Date(state.now); tmr.setDate(tmr.getDate() + 1);
  const tomorrowStr = isoDate(tmr);
  const recents = state.recents.map((r) => {
    const code = commonLine(r.o, r.d);
    return `<div class="recent" data-act="runRecent" role="button" tabindex="0" data-o="${r.o}" data-d="${r.d}">
      <span class="ic">↺</span>
      <div class="od">${esc(shortName(r.o))} <span class="arr">→</span> ${esc(shortName(r.d))}</div>
      <span class="badge sm" style="background:${lineColor(code)}">${code}</span>
      <button class="recent-x" data-act="removeRecent" data-o="${r.o}" data-d="${r.d}" aria-label="Remove recent search">×</button></div>`;
  }).join('');
  const canSearch = state.origin && state.dest && state.origin !== state.dest;
  const sameStation = state.origin && state.dest && state.origin === state.dest;
  const picker = state.picker ? `<div class="picker">
    <div class="picker-head"><button class="back" data-act="closePicker" aria-label="Back">←</button>
      <div class="t">${state.picker === 'origin' ? 'From' : 'To'}</div></div>
    <div class="picker-search"><input id="q" type="text" placeholder="Search stations" value="${esc(state.query)}" data-act="query" autocomplete="off"></div>
    <div class="picker-toggle">
      <button class="${state.pickerView === 'grouped' ? 'on' : ''}" data-act="pickerGrouped">By line</button>
      <button class="${state.pickerView === 'az' ? 'on' : ''}" data-act="pickerAZ">A–Z</button>
    </div>
    <div class="picker-list" id="stlist">${stationListHtml()}</div></div>` : '';

  return `<div class="screen"><div class="scroll" data-scroll="search">
    <div class="head"><div class="title">Plan a trip</div></div>
    <div class="od-group">
      <div class="od-field" data-act="openOrigin" role="button" tabindex="0">
        <div class="od-marker from"></div>
        <div><div class="lbl">From</div><div class="val ${state.origin ? '' : 'empty'}">${state.origin ? esc(DATA.byId[state.origin].name) : 'Choose station'}</div></div>
      </div>
      <div class="od-divider"></div>
      <div class="od-field" data-act="openDest" role="button" tabindex="0">
        <div class="od-marker to"></div>
        <div><div class="lbl">To</div><div class="val ${state.dest ? '' : 'empty'}">${state.dest ? esc(DATA.byId[state.dest].name) : 'Choose station'}</div></div>
      </div>
      <button class="swap" data-act="swap" aria-label="Swap origin and destination">⇅</button>
    </div>
    <div class="dt-row">
      <label class="dt-field"><div class="lbl">Date</div><input type="date" value="${state.dateStr}" data-act="date"></label>
      <label class="dt-field"><div class="lbl">Time</div><input type="time" value="${state.timeStr}" data-act="time"></label>
    </div>
    <div class="quick-chips">
      <button class="now-chip ${state.leaveNow ? 'on' : ''}" data-act="leaveNow"><div class="dot"></div>Leave now</button>
      <button class="now-chip ${(!state.leaveNow && state.dateStr === todayStr) ? 'on' : ''}" data-act="setToday">Today</button>
      <button class="now-chip ${(state.dateStr === tomorrowStr) ? 'on' : ''}" data-act="setTomorrow">Tomorrow</button>
    </div>
    <button class="search-btn" data-act="runSearch" ${canSearch ? '' : 'disabled'}>Search trips</button>
    ${sameStation ? `<div class="search-hint">Origin and destination are the same — pick different stations.</div>` : ''}
    ${recents ? `<div class="section-label">Recent</div>${recents}` : ''}
  </div>${picker}</div>`;
}

function selectedFromDate() {
  if (state.leaveNow) return new Date(state.now);
  const t = new Date(state.dateStr + 'T' + state.timeStr);
  return isNaN(t) ? new Date(state.now) : t;
}

function resultsScreen() {
  const o = state.origin, d = state.dest;
  const from = selectedFromDate();
  const deps = showTrains() ? searchPair(o, d, from, 9) : [];
  const code = deps[0] ? deps[0].line : commonLine(o, d);
  const ctx = showTrains() ? ('After ' + fmtTime(from.getTime()) + ' · ' + lineName(code)) : 'Bus connections';
  const saved = state.saved.some((t) => t.o === o && t.d === d);
  let list = '';
  if (showTrains() && !deps.length) {
    const co = (DATA.byId[o] || {}), cd = (DATA.byId[d] || {});
    const sameLine = (co.lines || []).some((x) => (cd.lines || []).includes(x));
    list = `<div class="empty"><div class="box">⤫</div>
      <div class="h">No direct trips</div>
      <div class="p">${sameLine ? 'No more direct departures were found for this route in the schedule.' :
        esc(shortName(o)) + ' and ' + esc(shortName(d)) + ' aren\'t on the same line. Most riders connect at Union Station.'}</div>
      <button class="btn-primary" data-act="goSearch">Edit search</button></div>`;
  } else {
    let prevDay = null;
    list = `<div class="res-head">Next departures</div>` + deps.map((h, i) => {
      const stopsBetween = h.di - h.oi - 1;
      const stopsLabel = stopsBetween <= 0 ? 'Nonstop' : stopsBetween + ' stops';
      const depMin = h.trip.stops[h.oi][1];
      const dt = serviceDayType(h.depAbs, depMin);
      const pinned = isPinned(o, d, h.line, dt, depMin);
      const pinData = `data-o="${o}" data-d="${d}" data-line="${h.line}" data-daytype="${dt}" data-depmin="${depMin}"`;
      const dayKey = startOfDay(h.depAbs).getTime();
      const divider = (prevDay !== null && dayKey !== prevDay) ? `<div class="res-day">${dayLabel(h.depAbs)}</div>` : '';
      prevDay = dayKey;
      return divider + `<div class="res-row ${isSoon(h.depAbs) ? 'soon' : ''}" data-act="openDetail" role="button" tabindex="0" data-o="${o}" data-d="${d}" data-dep="${h.depAbs}">
        <div class="bar" style="background:${lineDisp(h.line)}"></div>
        <div class="mid">
          <div class="times"><span class="dep">${fmtTime(h.depAbs)}</span><span class="to">→</span><span class="arr">${fmtTime(h.arrAbs)}</span></div>
          <div class="info"><span class="badge sm" style="background:${lineColor(h.line)}">${h.line}</span>${modeIcon(lineMode(h.line))}
            <span class="hs">To ${esc(cleanHeadsign(h.trip.headsign) || shortName(h.trip.stops[h.trip.stops.length - 1][0]))}</span>
            <span class="stops">· ${stopsLabel}</span></div>
        </div>
        <div class="right">
          <div class="mins" data-live="in" data-dep="${h.depAbs}">${inLabel(h.depAbs)}</div>
          <div class="dur">${h.duration} min</div>
          <button class="pin-btn ${pinned ? 'on' : ''}" data-act="togglePin" ${pinData} aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin this departure' : 'Pin this departure'}">${pinned ? 'Pinned' : 'Pin'}</button>
        </div>
      </div>`;
    }).join('');
  }
  if (state.modeFilter === 'bus') {
    const boards = busBoardHtml(o, 'Buses from ' + shortName(o)) + busBoardHtml(d, 'Buses from ' + shortName(d));
    list = boards || `<div class="empty"><div class="box">${modeIcon('bus')}</div>
      <div class="h">No bus connections</div>
      <div class="p">${DATA.busDepartures ? 'No buses serve these stations in the schedule.' : 'Bus data hasn\u2019t been added to this app yet — rebuild with the GTFS feed to enable it.'}</div>
      <button class="btn-primary" data-act="goSearch">Edit search</button></div>`;
  }
  const saveBtn = (showTrains() && deps.length) ? `<button class="route-save ${saved ? 'on' : ''}" data-act="toggleSaveRoute" data-o="${o}" data-d="${d}" aria-pressed="${saved}" aria-label="${saved ? 'Remove from saved' : 'Save this route'}"><span class="ic">${saved ? '★' : '☆'}</span>${saved ? 'Saved' : 'Save'}</button>` : '';
  return `<div class="screen">
    <div class="pushhead"><button class="back" data-act="back" aria-label="Back">←</button>
      <div class="ttl"><div class="od">${esc(shortName(o))} <span class="arr">→</span> ${esc(shortName(d))}</div><div class="ctx">${ctx}</div></div>
      ${saveBtn}</div>
    <div class="res-list" data-scroll="results">${list}</div>
  </div>`;
}

// Informational "connecting buses" board for a rail station. Renders nothing
// unless bus departure data (data/bus.json) has been loaded for that station.
function busBoardHtml(stationId, title) {
  const bd = DATA.busDepartures && DATA.busDepartures[stationId];
  if (!bd) return '';
  const collect = (dayOffset) => {
    const day = new Date(state.now); day.setDate(day.getDate() + dayOffset);
    const dt = dayTypeOf(day);
    const base = startOfDay(day.getTime()).getTime();
    return (bd[dt] || []).map(([line, hs, dir, m]) => ({ line, hs, dir, depAbs: base + m * 60000 }));
  };
  let items = collect(0).filter((x) => x.depAbs >= state.now - 60000);
  if (items.length < 4) items = items.concat(collect(1));
  items.sort((a, b) => a.depAbs - b.depAbs);
  items = items.slice(0, 8);
  if (!items.length) return '';
  const rows = items.map((x) => `<div class="bus-row">
    <span class="badge sm" style="background:${lineColor(x.line)}">${esc(x.line)}</span>
    <span class="bus-hs">${esc(cleanHeadsign(x.hs) || lineName(x.line) || 'Bus')}</span>
    <span class="bus-tm"><span class="t">${fmtTime(x.depAbs)}</span> <span class="in" data-live="in" data-dep="${x.depAbs}">${inLabel(x.depAbs)}</span></span>
  </div>`).join('');
  const heading = title || ('Connecting buses at ' + shortName(stationId));
  return `<div class="section-label" style="margin-left:0">${modeIcon('bus')} ${esc(heading)}</div>
    <div class="bus-board">${rows}</div>`;
}

function detailScreen() {
  const { o, d, dep } = state.detail;
  const all = searchPair(o, d, new Date(dep - 1000), 4);
  const h = all.find((x) => Math.abs(x.depAbs - dep) < 60000) || all[0];
  if (!h) { return `<div class="screen"><div class="pushhead"><button class="back" data-act="back">←</button><div class="static">Trip details</div></div><div class="detail-scroll">Trip not found.</div></div>`; }
  const code = h.line, accent = lineDisp(code);
  const base = startOfDay(h.depAbs).getTime();
  const seq = h.trip.stops.slice(h.oi, h.di + 1);
  const lastIdx = seq.length - 1;
  const stops = seq.map((s, i) => {
    const isEnd = i === 0 || i === lastIdx;
    const t = base + s[1] * 60000;
    const passed = t < state.now;
    return `<div class="stop">
      <div class="dotwrap"><div class="dot" style="width:${isEnd ? '15px' : '10px'};height:${isEnd ? '15px' : '10px'};background:${isEnd ? accent : (passed ? 'var(--text-3)' : 'var(--surface)')};box-shadow:${isEnd ? '0 0 0 transparent' : '0 0 0 1.5px ' + accent}"></div></div>
      <div class="row"><span class="nm" style="font-size:${isEnd ? '16px' : '14px'};font-weight:${isEnd ? '700' : '500'};color:${isEnd ? 'var(--text)' : (passed ? 'var(--text-3)' : 'var(--text-2)')}">${esc(shortName(s[0]))}</span>
        <span class="tm">${fmtTime(t)}</span></div></div>`;
  }).join('');
  const amen = (DATA.byId[o] || {}).amenities || [];
  const amenHtml = amen.length ? amen.map((a) => `<div class="amenity"><div class="dot"></div><span>${esc(a)}</span></div>`).join('')
    : `<div class="amenity"><div class="dot"></div><span>No amenity data</span></div>`;
  const depMin = h.trip.stops[h.oi][1];
  const dt = serviceDayType(h.depAbs, depMin);
  const pinned = isPinned(o, d, code, dt, depMin);
  const pinData = `data-o="${o}" data-d="${d}" data-line="${code}" data-daytype="${dt}" data-depmin="${depMin}"`;
  return `<div class="screen">
    <div class="pushhead"><button class="back" data-act="back" aria-label="Back">←</button><div class="static">Trip details</div>
      <button class="route-save ${pinned ? 'on' : ''}" data-act="togglePin" ${pinData} aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin departure' : 'Pin departure'}"><span class="ic">${pinned ? '★' : '☆'}</span>${pinned ? 'Pinned' : 'Pin'}</button></div>
    <div class="detail-scroll" data-scroll="detail">
      <div class="detail-card">
        <div class="detail-line"><span class="badge sm" style="background:${lineColor(code)}">${code}</span>${modeIcon(lineMode(code))}<span class="nm">${esc(lineName(code))}</span>
          <span class="detail-in" data-live="in" data-dep="${h.depAbs}">${inLabel(h.depAbs)}</span></div>
        <div class="detail-od">
          <div><div class="t">${fmtTime(h.depAbs)}</div><div class="s">${esc(shortName(o))}</div></div>
          <div class="mid"><div class="dur">${h.duration} min</div><div class="track"><div class="tri">▶</div></div></div>
          <div style="text-align:right"><div class="t">${fmtTime(h.arrAbs)}</div><div class="s">${esc(shortName(d))}</div></div>
        </div>
      </div>
      <div class="section-label" style="margin-left:0">At ${esc(shortName(o))}</div>
      <div class="amenities">${amenHtml}</div>
      <div class="section-label" style="margin-left:0">Stops</div>
      <div class="timeline"><div class="spine" style="background:${accent}"></div>${stops}</div>
      ${showBuses() ? busBoardHtml(d) : ''}
    </div>
  </div>`;
}

function savedScreen() {
  const hasRoutes = state.saved.length > 0;
  const hasPins = state.pins.length > 0;
  let body;
  if (!hasRoutes && !hasPins) {
    body = `<div class="empty"><div class="box">★</div>
      <div class="h">Nothing saved</div>
      <div class="p">Save a whole route, or pin a specific departure, from the search results — they'll show up here for one-tap access.</div>
      <button class="btn-primary" data-act="goSearch">Find a trip</button></div>`;
  } else {
    const routeRows = state.saved.map((t) => {
      const deps = searchPair(t.o, t.d, new Date(state.now), 1);
      const code = deps[0] ? deps[0].line : commonLine(t.o, t.d);
      const nx = deps[0] ? `Next departs ${fmtTime(deps[0].depAbs)} · <span class="in" data-live="in" data-dep="${deps[0].depAbs}">${inLabel(deps[0].depAbs)}</span>` : 'No upcoming service';
      const dep = deps[0] ? deps[0].depAbs : 0;
      return `<div class="saved-row" data-act="openDetail" role="button" tabindex="0" data-o="${t.o}" data-d="${t.d}" data-dep="${dep}">
        <div class="bar" style="background:${lineDisp(code)}"></div>
        <div class="mid">
          <div class="od"><span class="badge sm" style="background:${lineColor(code)}">${code}</span>
            <span class="nm">${esc(shortName(t.o))} <span class="arr">→</span> ${esc(shortName(t.d))}</span></div>
          <div class="nx">${nx}</div>
        </div>
        <div class="actions">
          <button class="icon-btn" data-act="reverse" data-o="${t.o}" data-d="${t.d}" aria-label="Reverse">⇅</button>
          <button class="icon-btn" data-act="remove" data-o="${t.o}" data-d="${t.d}" aria-label="Remove">×</button>
        </div></div>`;
    }).join('');
    const pinRows = state.pins.map((p) => {
      const occ = nextPinOccurrence(p);
      const nx = occ ? `Departs ${fmtTime(occ.depAbs)} · <span class="in" data-live="in" data-dep="${occ.depAbs}">${inLabel(occ.depAbs)}</span>` : 'No upcoming run';
      const dep = occ ? occ.depAbs : 0;
      const pinData = `data-o="${p.o}" data-d="${p.d}" data-line="${p.line}" data-daytype="${p.dayType}" data-depmin="${p.depMin}"`;
      return `<div class="saved-row" data-act="openDetail" role="button" tabindex="0" data-o="${p.o}" data-d="${p.d}" data-dep="${dep}">
        <div class="bar" style="background:${lineDisp(p.line)}"></div>
        <div class="mid">
          <div class="od"><span class="badge sm" style="background:${lineColor(p.line)}">${p.line}</span>
            <span class="nm">${esc(shortName(p.o))} <span class="arr">→</span> ${esc(shortName(p.d))}</span></div>
          <div class="nx">${dayTypeLabel(p.dayType)} · ${nx}</div>
        </div>
        <div class="actions">
          <button class="icon-btn" data-act="unpin" ${pinData} aria-label="Unpin departure">×</button>
        </div></div>`;
    }).join('');
    body = (hasRoutes ? (hasPins ? '<div class="section-label">Saved routes</div>' : '') + routeRows : '') +
      (hasPins ? '<div class="section-label">Pinned departures</div>' + pinRows : '') +
      `<button class="add-trip" data-act="goSearch">+  Add a trip</button>`;
  }
  return `<div class="screen"><div class="scroll" data-scroll="saved">
    <div class="head"><div class="title">Saved trips</div><div class="subhead">Tap to view · routes show all departures, pins show one</div></div>
    ${body}
  </div></div>`;
}

const SCROLLS = {};
function render() {
  document.body.setAttribute('data-theme', state.theme);
  const app = document.getElementById('app');
  const scrollEls = app.querySelectorAll('[data-scroll]');
  scrollEls.forEach((el) => { SCROLLS[el.getAttribute('data-scroll')] = el.scrollTop; });

  let screen;
  switch (state.screen) {
    case 'home': screen = homeScreen(); break;
    case 'search': screen = searchScreen(); break;
    case 'results': screen = resultsScreen(); break;
    case 'detail': screen = detailScreen(); break;
    case 'saved': screen = savedScreen(); break;
    default: screen = homeScreen();
  }
  // results/detail render their own top bar (pushhead); skip the global status
  // bar there so the time/header isn't shown twice and doesn't overlap.
  const ownsTopBar = state.screen === 'results' || state.screen === 'detail';
  app.innerHTML = (ownsTopBar ? '' : statusbar()) + screen + tabbar() + settingsSheet();

  app.querySelectorAll('[data-scroll]').forEach((el) => {
    const k = el.getAttribute('data-scroll');
    if (SCROLLS[k] != null) el.scrollTop = SCROLLS[k];
  });
  const q = document.getElementById('q');
  if (q && state.picker) { q.focus(); const v = q.value; q.value = ''; q.value = v; }
}

/* ---- actions ------------------------------------------------------------- */

function goTab(tab) { state.screen = tab; state.activeTab = tab; state.picker = null; render(); }
function back() {
  if (state.screen === 'detail') { state.screen = state.backTo; state.activeTab = (state.backTo === 'results' || state.backTo === 'search') ? 'search' : state.backTo; }
  else if (state.screen === 'results') { state.screen = 'search'; state.activeTab = 'search'; }
  render();
}
function reverse(o, d) {
  const i = state.saved.findIndex((t) => t.o === o && t.d === d);
  if (i >= 0) { state.saved[i] = { o: d, d: o }; save('saved'); }
  render();
}
function remove(o, d) { state.saved = state.saved.filter((t) => !(t.o === o && t.d === d)); save('saved'); render(); }

const handlers = {
  toggleTheme() { state.themeMode = state.theme === 'dark' ? 'light' : 'dark'; save('themeMode'); applyTheme(); render(); },
  openSettings() { state.settingsOpen = true; render(); },
  closeSettings() { state.settingsOpen = false; render(); },
  setTheme(el) { state.themeMode = el.dataset.mode; save('themeMode'); applyTheme(); render(); },
  setMode(el) { state.modeFilter = el.dataset.mode; save('modeFilter'); render(); },
  toggle24() { state.use24 = !state.use24; save('use24'); render(); },
  setToday() { const d = new Date(state.now); state.dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); state.timeStr = pad(d.getHours()) + ':' + pad(d.getMinutes()); state.leaveNow = false; render(); },
  setTomorrow() { const d = new Date(state.now); d.setDate(d.getDate() + 1); state.dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); state.timeStr = '00:00'; state.leaveNow = false; render(); },
  goHome() { goTab('home'); }, goSearch() { goTab('search'); }, goSaved() { goTab('saved'); },
  dismissInstall() { state.installDismissed = true; save('installDismissed'); render(); },
  async doInstall() {
    if (!deferredPrompt) { toast('Use your browser menu to install'); return; }
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch (e) {}
    deferredPrompt = null; render();
  },
  toggleCard(el) { const k = el.dataset.key; state.expanded[k] = !state.expanded[k]; render(); },
  reverse(el) { reverse(el.dataset.o, el.dataset.d); },
  remove(el) { remove(el.dataset.o, el.dataset.d); },
  openDetail(el) { const dep = +el.dataset.dep; if (!dep) { toast('No upcoming trip to show'); return; } state.detail = { o: el.dataset.o, d: el.dataset.d, dep }; state.backTo = state.screen; state.screen = 'detail'; render(); },
  openOrigin() { state.picker = 'origin'; state.query = ''; render(); },
  openDest() { state.picker = 'dest'; state.query = ''; render(); },
  pickerGrouped() { setPickerView('grouped'); },
  pickerAZ() { setPickerView('az'); },
  removeRecent(el) { state.recents = state.recents.filter((r) => !(r.o === el.dataset.o && r.d === el.dataset.d)); save('recents'); render(); },
  closePicker() { state.picker = null; render(); },
  pickStation(el) { const id = el.dataset.id; if (state.picker === 'origin') state.origin = id; else state.dest = id; state.picker = null; render(); },
  swap() { const o = state.origin; state.origin = state.dest; state.dest = o; render(); },
  leaveNow() { const d = new Date(); state.leaveNow = true; state.dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); state.timeStr = pad(d.getHours()) + ':' + pad(d.getMinutes()); render(); },
  runSearch() {
    if (!state.origin || !state.dest) { toast('Pick origin & destination'); return; }
    if (state.origin === state.dest) { toast('Pick two different stations'); return; }
    pushRecent(state.origin, state.dest); state.screen = 'results'; state.activeTab = 'search'; render();
  },
  runRecent(el) { state.origin = el.dataset.o; state.dest = el.dataset.d; state.leaveNow = true; pushRecent(el.dataset.o, el.dataset.d); state.screen = 'results'; state.activeTab = 'search'; render(); },
  toggleSaveRoute(el) { toggleSaveTrip(el.dataset.o, el.dataset.d); },
  togglePin(el) { togglePin(el.dataset.o, el.dataset.d, el.dataset.line, el.dataset.daytype, +el.dataset.depmin); },
  unpin(el) { removePin(el.dataset.o, el.dataset.d, el.dataset.line, el.dataset.daytype, +el.dataset.depmin); },
  back() { back(); },
  noop() {},
};

function bind() {
  const app = document.getElementById('app');
  app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el || !app.contains(el)) return;
    const act = el.dataset.act;
    if (handlers[act]) { e.preventDefault(); e.stopPropagation(); handlers[act](el, e); }
  });
  // Enter/Space activate non-button controls (role="button" rows/cards).
  app.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const el = e.target.closest('[data-act]'); if (!el || !app.contains(el)) return;
    if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'A') return;
    if (el.getAttribute('tabindex') === null) return;
    const act = el.dataset.act;
    if (handlers[act]) { e.preventDefault(); handlers[act](el, e); }
  });
  app.addEventListener('input', (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    if (el.dataset.act === 'query') {
      state.query = el.value;
      const list = document.getElementById('stlist');
      if (list) list.innerHTML = stationListHtml();
    }
  });
  app.addEventListener('change', (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    if (el.dataset.act === 'date') { state.dateStr = el.value; state.leaveNow = false; render(); }
    if (el.dataset.act === 'time') { state.timeStr = el.value; state.leaveNow = false; render(); }
  });
}

/* ---- boot ---------------------------------------------------------------- */

function liveScreen() { return state.screen === 'home' || state.screen === 'results' || state.screen === 'saved' || state.screen === 'detail'; }

// Update only the time-dependent text each second (no DOM rebuild = no flashing).
// Trigger a single full re-render when a shown departure rolls past its minute,
// so the list advances to the next train.
function tick() {
  state.now = Date.now();
  const app = document.getElementById('app');
  if (!app) return;
  const nowMin = Math.floor(state.now / 60000);
  let needFull = false;
  app.querySelectorAll('[data-live]').forEach((el) => {
    const kind = el.dataset.live;
    if (kind === 'clock') { el.textContent = fmtTime(state.now); return; }
    const dep = +el.dataset.dep;
    if (kind === 'in') el.textContent = inLabel(dep);
    else if (kind === 'mmss') el.textContent = mmss(dep);
    if (dep && Math.floor(dep / 60000) < nowMin) needFull = true;
  });
  if (needFull && liveScreen() && !state.picker &&
      !(document.activeElement && document.activeElement.tagName === 'INPUT')) {
    render();
  }
}

async function boot() {
  try {
    const idx = await fetch('data/index.json').then((r) => r.json());
    DATA.lines = idx.lines; DATA.stations = idx.stations; DATA.meta = idx.meta;
    DATA.calendar = idx.calendar || {}; DATA.defaults = idx.defaults || {};
    DATA.byId = {}; idx.stations.forEach((s) => { DATA.byId[s.id] = s; });
    const keys = idx.variants && idx.variants.length ? idx.variants : [];
    const loaded = await Promise.all(keys.map((k) => fetch('data/trips-' + k + '.json').then((r) => r.json()).catch(() => [])));
    keys.forEach((k, i) => { DATA.schedules[k] = loaded[i]; });
    buildLineStations();

    // Optional bus connections board (absent until build-index.js emits it).
    if (idx.hasBus) {
      fetch('data/bus.json').then((r) => r.json())
        .then((b) => { DATA.busDepartures = b.busDepartures || b; if (state.screen === 'detail') render(); })
        .catch(() => {});
    }

    // seed a sensible default search if user has none saved yet
    const d = new Date();
    state.dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    state.timeStr = pad(d.getHours()) + ':' + pad(d.getMinutes());

    applyTheme();
    bind();
    render();
    setInterval(tick, 1000);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.themeMode === 'auto') { applyTheme(); render(); }
    });

    if ('serviceWorker' in navigator) {
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return; reloading = true; location.reload();
      });
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  } catch (e) {
    document.getElementById('app').innerHTML =
      '<div class="boot"><div class="splash-name" style="font-size:34px">Tracker</div><div class="splash-tag">Couldn\'t load the schedule. Try refreshing.</div></div>';
    console.error(e);
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  if (state.screen === 'home') render();
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null; state.installDismissed = true; save('installDismissed');
  if (state.screen === 'home') render();
});

boot();
