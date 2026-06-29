#!/usr/bin/env node
/*
 * build-index.js
 * Turns the raw GO Transit GTFS feed into the compact JSON the PWA loads.
 *
 *   node build-index.js ["GO-GTFS Files"] [docs/data]
 *
 * Output (in the out dir):
 *   index.json              { meta, dayTypes, lines, stations }
 *   trips-weekday.json      [ { id, line, dir, headsign, stops:[[stopId, depMin], ...] }, ... ]
 *   trips-saturday.json
 *   trips-sunday.json
 *
 * Times are minutes after midnight; GTFS times past 24h (e.g. 25:30) are preserved (1530).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SRC = process.argv[2] || 'GO-GTFS Files';
const OUT = process.argv[3] || path.join('docs', 'data');

// --- tiny CSV helpers -------------------------------------------------------

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      out.push(cur); cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function stripBom(s) { return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }

// Read an entire (smaller) CSV file into array-of-objects.
function readCsv(file) {
  const text = fs.readFileSync(path.join(SRC, file), 'utf8');
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(stripBom(lines[0])).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = parseCsvLine(lines[i]);
    const o = {};
    for (let j = 0; j < header.length; j++) o[header[j]] = cells[j];
    rows.push(o);
  }
  return rows;
}

// Stream a large CSV line-by-line, invoking cb(obj) per row.
function streamCsv(file, cb) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(SRC, file)),
      crlfDelay: Infinity,
    });
    let header = null;
    rl.on('line', (line) => {
      if (header === null) { header = parseCsvLine(stripBom(line)).map((h) => h.trim()); return; }
      if (!line) return;
      const cells = parseCsvLine(line);
      const o = {};
      for (let j = 0; j < header.length; j++) o[header[j]] = cells[j];
      cb(o);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

// --- time helpers -----------------------------------------------------------

// "HH:MM:SS" -> minutes after midnight (preserves 24h+). Empty -> null.
function toMinutes(hms) {
  if (!hms) return null;
  const p = hms.split(':');
  if (p.length < 2) return null;
  return (+p[0]) * 60 + (+p[1]);
}

// YYYYMMDD -> JS day of week (0=Sun..6=Sat) using UTC to avoid TZ drift.
function dayOfWeek(ymd) {
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function dayTypeOf(ymd) {
  const dow = dayOfWeek(ymd);
  if (dow === 0) return 'sunday';
  if (dow === 6) return 'saturday';
  return 'weekday';
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log(`Reading GTFS from "${SRC}" -> "${OUT}"`);

  // 1. Routes. Rail (route_type 2) drives trip planning; bus (route_type 3)
  //    is kept only to build a connecting-departures board at rail stations.
  const routes = readCsv('routes.txt');
  const railRoutes = new Map(); // route_id -> { code, long, color, textColor }
  const busRoutes = new Map();  // route_id -> { code, long, color, textColor }
  const lines = {};             // code -> line meta (rail; used bus lines added later)
  for (const r of routes) {
    const meta = {
      code: r.route_short_name || r.route_long_name || r.route_id,
      long: r.route_long_name,
      color: '#' + (r.route_color || '777777'),
      textColor: '#' + (r.route_text_color || 'FFFFFF'),
    };
    if (r.route_type === '2') {
      railRoutes.set(r.route_id, meta);
      lines[meta.code] = { id: meta.code, short: meta.code, long: meta.long, type: 'train', color: meta.color, textColor: meta.textColor };
    } else if (r.route_type === '3') {
      busRoutes.set(r.route_id, meta);
    }
  }
  console.log(`  rail lines: ${Object.keys(lines).join(', ')}`);
  console.log(`  bus routes: ${busRoutes.size}`);

  // 2. Rail trips. Count trips per service_id to pick a representative date.
  const trips = readCsv('trips.txt');
  const tripMeta = new Map();        // trip_id -> { code, service, headsign, dir }
  const svcCount = new Map();        // service_id -> rail trip count
  const busTripMeta = new Map();     // trip_id -> { code, service, headsign, dir }
  const busSvcCount = new Map();     // service_id -> bus trip count
  for (const t of trips) {
    const route = railRoutes.get(t.route_id);
    if (route) {
      tripMeta.set(t.trip_id, {
        code: route.code,
        service: t.service_id,
        headsign: t.trip_headsign || '',
        dir: +(t.direction_id || 0),
      });
      svcCount.set(t.service_id, (svcCount.get(t.service_id) || 0) + 1);
      continue;
    }
    const broute = busRoutes.get(t.route_id);
    if (broute) {
      busTripMeta.set(t.trip_id, {
        code: broute.code,
        service: t.service_id,
        headsign: t.trip_headsign || '',
        dir: +(t.direction_id || 0),
      });
      busSvcCount.set(t.service_id, (busSvcCount.get(t.service_id) || 0) + 1);
    }
  }
  console.log(`  rail trips: ${tripMeta.size}   bus trips: ${busTripMeta.size}`);

  // 3. Feed window. In this feed service_id === a YYYYMMDD date, so the set of
  //    trips actually depends on the date (spring vs summer schedule, holidays).
  let feedStart = null, feedEnd = null;
  try {
    const fi = readCsv('feed_info.txt')[0] || {};
    feedStart = fi.feed_start_date || null;
    feedEnd = fi.feed_end_date || null;
  } catch (e) { /* optional */ }
  const allServices = [...svcCount.keys()].filter((s) => /^\d{8}$/.test(s)).sort();
  if (!feedStart) feedStart = allServices[0];
  if (!feedEnd) feedEnd = allServices[allServices.length - 1];
  console.log(`  feed window: ${feedStart} → ${feedEnd}`);

  // Keep every rail trip whose service date falls inside the window.
  const keepTrips = new Map(); // trip_id -> meta (incl. service)
  for (const [id, meta] of tripMeta) {
    if (/^\d{8}$/.test(meta.service) && meta.service >= feedStart && meta.service <= feedEnd) {
      keepTrips.set(id, meta);
    }
  }

  // 4. Stream stop_times, collecting stops for kept trips only.
  const tripStops = new Map(); // trip_id -> [ [seq, stopId, depMin], ... ]
  const usedStops = new Set();
  await streamCsv('stop_times.txt', (r) => {
    if (!keepTrips.has(r.trip_id)) return;
    const dep = toMinutes(r.departure_time || r.arrival_time);
    if (dep === null) return;
    if (!tripStops.has(r.trip_id)) tripStops.set(r.trip_id, []);
    tripStops.get(r.trip_id).push([+r.stop_sequence, r.stop_id, dep]);
    usedStops.add(r.stop_id);
  });

  // 5. Stops + amenities (only for stops we actually use).
  const amenities = new Map(); // stop_id -> [labels]
  try {
    for (const a of readCsv('stop_amenities.txt')) {
      const list = [];
      if (a.shelter === '1') list.push('Shelter');
      if (a.washroom === '1') list.push('Washroom');
      if (a.bike_rack === '1') list.push('Bike rack');
      if (a.bench === '1') list.push('Bench');
      amenities.set(a.stop_id, list);
    }
  } catch (e) { console.warn('  (no stop_amenities.txt)'); }

  const stopInfo = new Map();
  const parentOf = {}; // stop_id -> parent_station (for matching bus bays to stations)
  for (const s of readCsv('stops.txt')) {
    parentOf[s.stop_id] = s.parent_station || '';
    if (!usedStops.has(s.stop_id)) continue;
    stopInfo.set(s.stop_id, {
      id: s.stop_id,
      name: s.stop_name,
      lat: +s.stop_lat,
      lon: +s.stop_lon,
      code: s.stop_code || s.stop_id,
      zone: s.zone_id || '',
      wheelchair: s.wheelchair_boarding === '1',
      amenities: amenities.get(s.stop_id) || [],
      lines: [],
    });
  }

  // 5b. Bus connections board. Buses board at a station's bus-bay stop ids, which
  //     share a parent_station with the rail platform. Resolve both to a canonical
  //     station id, then keep only the bus departures that occur at a rail station.
  const canon = (id) => parentOf[id] || id;
  const railCanonToStation = new Map(); // canonical station -> rail station output id
  for (const id of usedStops) { const c = canon(id); if (!railCanonToStation.has(c)) railCanonToStation.set(c, id); }

  // Representative bus service per day-type = the in-window date with the most bus trips.
  const inWindow = (s) => /^\d{8}$/.test(s) && s >= feedStart && s <= feedEnd;
  const bestBus = { weekday: [null, -1], saturday: [null, -1], sunday: [null, -1] };
  for (const [svc, n] of busSvcCount) {
    if (!inWindow(svc)) continue;
    const dt = dayTypeOf(svc);
    if (n > bestBus[dt][1]) bestBus[dt] = [svc, n];
  }
  const repBusByService = new Map(); // service_id -> dayType
  for (const dt of ['weekday', 'saturday', 'sunday']) if (bestBus[dt][0]) repBusByService.set(bestBus[dt][0], dt);
  const keepBusTrips = new Map();    // trip_id -> { code, headsign, dir, dt }
  for (const [id, m] of busTripMeta) {
    const dt = repBusByService.get(m.service);
    if (dt) keepBusTrips.set(id, { code: m.code, headsign: m.headsign, dir: m.dir, dt });
  }

  const busDepRecords = []; // { station, dt, line, headsign, dir, depMin }
  if (keepBusTrips.size) {
    await streamCsv('stop_times.txt', (r) => {
      const m = keepBusTrips.get(r.trip_id);
      if (!m) return;
      const station = railCanonToStation.get(canon(r.stop_id));
      if (!station) return;
      const dep = toMinutes(r.departure_time || r.arrival_time);
      if (dep === null) return;
      busDepRecords.push({ station, dt: m.dt, line: m.code, headsign: m.headsign, dir: m.dir, depMin: dep });
    });
  }
  console.log(`  bus departures at rail stations: ${busDepRecords.length}`);

  // 6. Build the canonical trip list for each service date, and record which
  //    lines serve each station (union across all dates).
  const tripsByService = new Map(); // service_id -> [tripObj]
  const stationLines = new Map();   // stop_id -> Set(code)
  for (const [id, meta] of keepTrips) {
    const stopsRaw = tripStops.get(id);
    if (!stopsRaw || stopsRaw.length < 2) continue;
    stopsRaw.sort((a, b) => a[0] - b[0]);
    const stops = stopsRaw.map((s) => [s[1], s[2]]);
    for (const s of stopsRaw) {
      if (!stationLines.has(s[1])) stationLines.set(s[1], new Set());
      stationLines.get(s[1]).add(meta.code);
    }
    if (!tripsByService.has(meta.service)) tripsByService.set(meta.service, []);
    tripsByService.get(meta.service).push({ line: meta.code, dir: meta.dir, headsign: meta.headsign, stops });
  }
  // Sort each service's trips by first departure (stable, canonical order).
  for (const arr of tripsByService.values()) {
    arr.sort((a, b) => (a.stops[0][1] - b.stops[0][1]) || a.line.localeCompare(b.line));
  }

  // 6b. Group identical service dates into a small set of schedule variants.
  const sigToKey = new Map();   // signature -> variant key
  const variants = {};          // key -> trips[]
  const signatureOf = (arr) => arr.map((t) =>
    t.line + ':' + t.dir + ':' + (t.headsign || '') + ':' + t.stops.map((s) => s[0] + '@' + s[1]).join('>')
  ).join('|');
  let nextKey = 1;
  const serviceToKey = new Map();
  for (const [service, arr] of tripsByService) {
    const sig = signatureOf(arr);
    let key = sigToKey.get(sig);
    if (!key) { key = 's' + (nextKey++); sigToKey.set(sig, key); variants[key] = arr; }
    serviceToKey.set(service, key);
  }

  // 6c. Calendar: every date in the window -> variant key (or 'none').
  const addDay = (ymd, n) => {
    const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return '' + dt.getUTCFullYear() + String(dt.getUTCMonth() + 1).padStart(2, '0') + String(dt.getUTCDate()).padStart(2, '0');
  };
  const calendar = {};
  const dayClassKeyVotes = { weekday: {}, saturday: {}, sunday: {} };
  for (let cur = feedStart; cur <= feedEnd; cur = addDay(cur, 1)) {
    const key = serviceToKey.get(cur) || 'none';
    calendar[cur] = key;
    if (key !== 'none') {
      const cls = dayTypeOf(cur);
      dayClassKeyVotes[cls][key] = (dayClassKeyVotes[cls][key] || 0) + 1;
    }
  }
  // Fallback variant per natural day class (for dates outside the feed window).
  const defaults = {};
  for (const cls of ['weekday', 'saturday', 'sunday']) {
    const votes = dayClassKeyVotes[cls];
    defaults[cls] = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0] || null;
  }

  // Attach serving lines to stations; drop stations with no rail service.
  const stations = [];
  for (const [id, info] of stopInfo) {
    const set = stationLines.get(id);
    if (!set || set.size === 0) continue;
    info.lines = [...set].sort();
    stations.push(info);
  }
  stations.sort((a, b) => a.name.localeCompare(b.name));

  // 6d. Assemble the per-station bus board and the bus lines it references.
  const busDepartures = {}; // stationId -> { weekday|saturday|sunday: [[line, headsign, dir, depMin], ...] }
  const usedBusLines = new Set();
  for (const rec of busDepRecords) {
    const st = busDepartures[rec.station] || (busDepartures[rec.station] = { weekday: [], saturday: [], sunday: [] });
    st[rec.dt].push([rec.line, rec.headsign, rec.dir, rec.depMin]);
    usedBusLines.add(rec.line);
  }
  for (const st of Object.values(busDepartures)) {
    for (const dt of ['weekday', 'saturday', 'sunday']) {
      const seen = new Set();
      st[dt] = st[dt]
        .filter((x) => { const k = x[0] + '|' + x[3] + '|' + x[1]; if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => a[3] - b[3]);
    }
  }
  for (const [, br] of busRoutes) {
    if (!usedBusLines.has(br.code) || lines[br.code]) continue;
    lines[br.code] = { id: br.code, short: br.code, long: br.long, type: 'bus', color: br.color, textColor: br.textColor };
  }
  const hasBus = Object.keys(busDepartures).length > 0;

  // 7. Write output.
  fs.mkdirSync(OUT, { recursive: true });
  const variantKeys = Object.keys(variants);
  const meta = {
    generatedAt: new Date().toISOString(),
    source: 'GO Transit GTFS',
    feedStart, feedEnd,
    stationCount: stations.length,
    variantCount: variantKeys.length,
    hasBus,
    busStationCount: Object.keys(busDepartures).length,
  };
  const index = { meta, variants: variantKeys, defaults, calendar, lines, stations };
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
  for (const key of variantKeys) {
    fs.writeFileSync(path.join(OUT, `trips-${key}.json`), JSON.stringify(variants[key]));
  }
  if (hasBus) fs.writeFileSync(path.join(OUT, 'bus.json'), JSON.stringify({ busDepartures }));

  // Report.
  const kb = (f) => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1) + ' KB';
  console.log(`  schedule variants: ${variantKeys.length}`);
  console.log(`  defaults: weekday=${defaults.weekday} saturday=${defaults.saturday} sunday=${defaults.sunday}`);
  console.log('\nWrote:');
  console.log(`  index.json          ${kb('index.json')}  (${stations.length} stations)`);
  let total = +kb('index.json').split(' ')[0];
  for (const key of variantKeys) {
    console.log(`  trips-${key}.json`.padEnd(22) + `${kb(`trips-${key}.json`)}  (${variants[key].length} trips)`);
    total += +kb(`trips-${key}.json`).split(' ')[0];
  }
  if (hasBus) {
    console.log(`  bus.json`.padEnd(22) + `${kb('bus.json')}  (${Object.keys(busDepartures).length} stations w/ bus connections)`);
    total += +kb('bus.json').split(' ')[0];
  }
  console.log(`  total payload: ${total.toFixed(1)} KB`);
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
