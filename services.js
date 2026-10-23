/* Data services, MCP tool implementations and the tactical advisor. */
const P = require('./public/physics.js');
const Wild = require('./wildlife.js');

const GRID_N = 17, GRID_SPACING = 60;
const wxCache = new Map();

/* ---------- elevation ---------- */
/* spacing (m) so the 17x17 grid covers the whole property plus margin; never finer than 60 m */
function gridSpacing(prop) {
  const rings = prop.features.filter((f) => f.type === 'boundary').flatMap((f) => f.coords);
  if (!rings.length) return GRID_SPACING;
  const c = prop.center, far = Math.max(...rings.map((p) => Math.max(Math.abs(P.toXY(p, [c.lat, c.lng])[0]), Math.abs(P.toXY(p, [c.lat, c.lng])[1]))));
  return Math.min(180, Math.max(GRID_SPACING, Math.ceil(((far + 250) * 2) / (GRID_N - 1))));
}
function gridPoints(center, sp = GRID_SPACING) {
  const pts = [], h = (GRID_N - 1) / 2;
  for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) pts.push(P.offset(center.lat, center.lng, (i - h) * sp, (j - h) * sp));
  return pts;
}
const toRows = (flat) => Array.from({ length: GRID_N }, (_, j) => flat.slice(j * GRID_N, (j + 1) * GRID_N));
const fetchJson = async (url, ms = 9000) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(url.split('?')[0] + ' -> ' + r.status);
  return r.json();
};

async function googleElevation(pts, key) {
  const out = [];
  for (let i = 0; i < pts.length; i += 100) {
    const locs = pts.slice(i, i + 100).map((p) => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join('|');
    const j = await fetchJson('https://maps.googleapis.com/maps/api/elevation/json?locations=' + locs + '&key=' + key);
    if (j.status !== 'OK') throw new Error('Google Elevation ' + j.status);
    j.results.forEach((r) => out.push(r.elevation));
  }
  return out;
}
async function openMeteoElevation(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i += 100) {
    const s = pts.slice(i, i + 100);
    const j = await fetchJson('https://api.open-meteo.com/v1/elevation?latitude=' + s.map((p) => p[0].toFixed(5)).join(',') + '&longitude=' + s.map((p) => p[1].toFixed(5)).join(','));
    out.push(...j.elevation);
  }
  return out;
}
async function usgsElevation(pts) {
  const out = new Array(pts.length);
  let next = 0, fails = 0;
  const worker = async () => {
    while (next < pts.length && fails < 6) {
      const k = next++;
      try {
        const j = await fetchJson('https://epqs.nationalmap.gov/v1/json?x=' + pts[k][1] + '&y=' + pts[k][0] + '&units=Meters&wkid=4326&includeDate=false', 7000);
        const v = Number(j.value);
        if (!isFinite(v) || v < -1000) throw new Error('no data');
        out[k] = v;
      } catch (e) { fails++; }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  if (fails >= 6 || out.some((v) => v === undefined)) throw new Error('USGS 3DEP unavailable');
  return out;
}

async function buildGrid(prop, mode) {
  const center = prop.center, sp = gridSpacing(prop), pts = gridPoints(center, sp);
  const h = (GRID_N - 1) / 2;
  const synth = (kind) => {
    const rows = Array.from({ length: GRID_N }, (_, j) => Array.from({ length: GRID_N }, (_, i) => P.syntheticElevation(kind, (i - h) * sp, (j - h) * sp)));
    return rows;
  };
  const base = { n: GRID_N, spacing: sp, center, ts: Date.now() };
  if (mode === 'model') return { ...base, source: 'TERRAIN MODEL', elevM: synth(prop.terrainKind || 'rolling') };
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const tries = [];
  if (key) tries.push(['GOOGLE ELEVATION', () => googleElevation(pts, key)]);
  tries.push(['USGS 3DEP LIDAR', () => usgsElevation(pts)], ['OPEN-METEO DEM', () => openMeteoElevation(pts)]); // 1 m lidar in the US first, coarser global DEM as backup
  for (const [name, fn] of tries) {
    try { return { ...base, source: name, elevM: toRows(await fn()) }; } catch (e) { console.warn('[elevation]', name, e.message); }
  }
  return { ...base, source: 'SIMULATED (offline)', elevM: synth(prop.terrainKind || 'rolling') };
}
async function getGrid(prop, { refresh = false, mode } = {}) {
  if (mode) { prop.elevationMode = mode; refresh = true; }
  if (!prop.elevation || refresh) { prop.elevation = await buildGrid(prop, prop.elevationMode || 'live'); prop._an = null; }
  return prop.elevation;
}
async function getAnalysis(prop) {
  const g = await getGrid(prop);
  if (!prop._an || prop._an.ts !== g.ts) prop._an = { ts: g.ts, an: P.analyzeGrid(g) };
  return prop._an.an;
}

/* ---------- weather ---------- */
async function getWeather(prop) {
  const key = prop.center.lat.toFixed(2) + ',' + prop.center.lng.toFixed(2);
  const hit = wxCache.get(key);
  if (hit && Date.now() - hit.ts < 10 * 60000) return hit.data;
  let data;
  try {
    const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + prop.center.lat + '&longitude=' + prop.center.lng +
      '&hourly=temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,shortwave_radiation,precipitation_probability' +
      '&daily=sunrise,sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&timeformat=unixtime&past_days=1&forecast_days=8';
    const j = await fetchJson(u);
    const H = j.hourly;
    data = {
      source: 'OPEN-METEO', utcOffsetSec: j.utc_offset_seconds, tz: j.timezone,
      hours: H.time.map((t, i) => ({
        ms: t * 1000, tempF: H.temperature_2m[i], pressureInHg: Math.round(H.pressure_msl[i] * 0.02953 * 100) / 100,
        windMph: H.wind_speed_10m[i], windDir: H.wind_direction_10m[i], gustMph: H.wind_gusts_10m[i], cloud: H.cloud_cover[i],
        solar: H.shortwave_radiation[i], precip: H.precipitation_probability[i] ?? 0,
      })),
      daily: j.daily.time.map((t, i) => ({ ms: t * 1000, sunrise: j.daily.sunrise[i] * 1000, sunset: j.daily.sunset[i] * 1000 })),
    };
  } catch (e) {
    console.warn('[weather] falling back to simulation:', e.message);
    const { lat, lng } = prop.center;
    const off = Math.round(lng / 15) * 3600 + (P.isDST(Date.now()) ? 3600 : 0);
    const start = Math.floor(Date.now() / 3600000) * 3600000 - 24 * 3600000;
    const hours = [];
    for (let k = 0; k < 24 * 9; k++) {
      const ms = start + k * 3600000, w = P.synthWx(ms, lat, lng);
      hours.push({ ms, ...w, gustMph: Math.round(w.windMph * 1.5), solar: 0, precip: w.cloud > 85 ? 40 : 5 });
    }
    const daily = [];
    for (let d = 0; d < 9; d++) {
      const dayStart = Math.floor((start + off * 1000) / 86400000) * 86400000 - off * 1000 + d * 86400000;
      daily.push({ ms: dayStart, ...P.sunTimes(lat, lng, dayStart) });
    }
    data = { source: 'SIMULATED (offline)', utcOffsetSec: off, tz: 'local', hours, daily };
  }
  wxCache.set(key, { ts: Date.now(), data });
  return data;
}
function wxAt(wx, ms) {
  const H = wx.hours;
  let i = H.findIndex((h) => h.ms > ms) - 1;
  if (i < 0) i = ms < H[0].ms ? 0 : H.length - 2;
  const a = H[i], b = H[Math.min(H.length - 1, i + 1)];
  const t = b.ms === a.ms ? 0 : P.clamp((ms - a.ms) / (b.ms - a.ms), 0, 1);
  const L = (k) => a[k] + (b[k] - a[k]) * t;
  const ux = Math.sin(a.windDir * P.D2R) * (1 - t) + Math.sin(b.windDir * P.D2R) * t;
  const uy = Math.cos(a.windDir * P.D2R) * (1 - t) + Math.cos(b.windDir * P.D2R) * t;
  return {
    ms, tempF: round(L('tempF'), 1), pressureInHg: round(L('pressureInHg'), 2), windMph: round(L('windMph'), 1),
    windDir: Math.round(P.norm360(Math.atan2(ux, uy) / P.D2R)), cloud: Math.round(L('cloud')), precip: Math.round(L('precip')),
  };
}
const round = (v, d = 0) => { const m = 10 ** d; return Math.round(v * m) / m; };
const trend = (wx, ms, hrs = 6) => round(wxAt(wx, ms).pressureInHg - wxAt(wx, ms - hrs * 3600000).pressureInHg, 2);

/* ---------- field + scent ---------- */
const waterFn = (prop) => {
  const polys = prop.features.filter((f) => f.type === 'water' && f.kind === 'polygon');
  return (lat, lng) => polys.some((f) => P.pointInPoly([lat, lng], f.coords));
};
async function fieldAt(prop, wx, ms) {
  const an = await getAnalysis(prop);
  const w = wxAt(wx, ms);
  return { field: P.computeField(an, w, { utcMs: ms }, waterFn(prop)), wx: w };
}
const stands = (prop) => prop.features.filter((f) => f.type === 'stand');
function standScents(prop, field) {
  return stands(prop).map((s) => ({ id: s.id, name: s.name, ...omit(P.scentCone(s.coords[0], field, prop.features), ['polygon']) }));
}
const omit = (o, ks) => Object.fromEntries(Object.entries(o).filter(([k]) => !ks.includes(k)));

const fmtTime = (ms, off) => new Date(ms + off * 1000).toUTCString().slice(17, 22);
const fmtDay = (ms, off) => new Date(ms + off * 1000).toUTCString().slice(0, 11);
const localDayStart = (ms, off) => Math.floor((ms + off * 1000) / 86400000) * 86400000 - off * 1000;
const hm12 = (ms, off) => {
  const d = new Date(ms + off * 1000); let h = d.getUTCHours(); const m = d.getUTCMinutes();
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
};
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekday = (ms, off) => WD[new Date(ms + off * 1000).getUTCDay()];

/* ---------- sightings ---------- */
function sightingStats(prop, { animal, sinceDays, behavior } = {}) {
  let list = prop.sightings.slice();
  if (animal) list = list.filter((s) => (s.animal + ' ' + s.animalId).toLowerCase().includes(animal.toLowerCase()));
  if (behavior) list = list.filter((s) => s.behavior.toLowerCase() === behavior.toLowerCase());
  if (sinceDays) list = list.filter((s) => s.ts >= Date.now() - sinceDays * 86400000);
  return list;
}

/* ---------- hunt planner ---------- */
function parseWhen(text, wx) {
  const t = (text || '').toLowerCase();
  const off = wx.utcOffsetSec;
  const today = localDayStart(Date.now(), off);
  let day = null;
  WD.forEach((w, i) => {
    if (t.includes(w.toLowerCase()) || t.includes(w.slice(0, 3).toLowerCase() + ' ') || t.includes(w.slice(0, 3).toLowerCase() + '.')) {
      const cur = new Date(today + off * 1000).getUTCDay();
      day = today + ((i - cur + 7) % 7) * 86400000;
    }
  });
  if (/tomorrow/.test(t)) day = today + 86400000;
  if (/\btoday|tonight|this (morning|evening|afternoon)\b/.test(t)) day = today;
  let period = null;
  if (/morning|dawn|sunrise|\bam\b|first light/.test(t)) period = 'AM';
  if (/evening|afternoon|\bpm\b|sunset|tonight|dusk|last light/.test(t)) period = period ? null : 'PM';
  return { day, period, front: /front|pressure|barometer/.test(t) };
}

async function planHunt(prop, text = '') {
  const wx = await getWeather(prop);
  const off = wx.utcOffsetSec;
  const want = parseWhen(text, wx);
  const ss = stands(prop);
  if (!ss.length) return { error: 'No stands on this property yet. Drop a Tree Stand pin on the map so I can plan around it.' };
  const now = Date.now();
  const options = [];
  const days = want.day !== null ? [want.day] : Array.from({ length: 6 }, (_, k) => localDayStart(now, off) + k * 86400000);
  const an = await getAnalysis(prop);
  const water = waterFn(prop);
  const ix = Wild.intel(prop);
  for (const d of days) {
    const sun = wx.daily.find((x) => Math.abs(x.ms - d) < 18 * 3600000) || { sunrise: d + 6.5 * 3600000, sunset: d + 17.5 * 3600000 };
    const periods = [
      ['AM', sun.sunrise - 30 * 60000, sun.sunrise + 150 * 60000],
      ['PM', sun.sunset - 180 * 60000, sun.sunset + 15 * 60000],
    ].filter(([p, , e]) => (!want.period || want.period === p) && e > now);
    for (const [period, s, e] of periods) {
      const steps = [];
      for (let t = Math.max(s, Math.ceil(now / 1800000) * 1800000); t <= e; t += 1800000) steps.push(t);
      if (!steps.length) continue;
      const mid = steps[Math.floor(steps.length / 2)];
      const w0 = wxAt(wx, steps[0]);
      const tr = trend(wx, steps[0], 12);
      const fields = steps.map((t) => ({ t, w: wxAt(wx, t), f: P.computeField(an, wxAt(wx, t), { utcMs: t }, water) }));
      for (const st of ss) {
        const cones = fields.map(({ f }) => P.scentCone(st.coords[0], f, prop.features));
        const sv = cones.map((c) => (c.status === 'green' ? 1 : c.status === 'yellow' ? 0.3 : -1.5));
        const scent = sv.reduce((a, b) => a + b, 0) / sv.length;
        const reds = cones.filter((c) => c.status === 'red').length;
        const act0 = activity(prop, st, s, e, off);
        const T = prop.targets && prop.targets.length ? prop.targets : ['deer'];
        const ta = Wild.targetActivity(prop, st, T, s, e, off);
        const act = T.includes('deer') ? { ...act0, score: Math.min(1, act0.score + ta.score), inWindow: act0.inWindow + ta.inWindow } : { score: ta.score, inWindow: ta.inWindow, targets: 0 };
        const pred = Wild.nearPressure(prop, st.coords[0], ix);
        const press = (tr > 0.06 && w0.pressureInHg >= 29.95 ? 1 : tr > 0.02 ? 0.5 : tr < -0.06 ? 0.6 : 0) * (want.front ? 1.4 : 1);
        const temp = w0.tempF < 40 ? 1 : w0.tempF < 50 ? 0.7 : w0.tempF < 60 ? 0.3 : -0.3;
        const wind = w0.windMph > 16 ? -1 : w0.windMph < 2 ? -0.4 : 0.5;
        const rain = w0.precip > 60 ? -0.8 : 0;
        const score = 3 * scent + 3 * act.score + 1.5 * press + temp + wind + rain - reds * 0.3 - 1.4 * pred;
        options.push({ stand: st, period, start: s, end: e, mid, w0, tr, cones, scent, reds, act, pred, score, cone: cones[Math.floor(cones.length / 2)], sun });
      }
    }
  }
  if (!options.length) return { error: 'No remaining legal shooting windows match that request.' };
  options.sort((a, b) => b.score - a.score);
  const best = options[0];
  return { best: decorate(prop, best, wx), alternatives: options.slice(1).filter((o) => o.stand.id !== best.stand.id || o.period !== best.period).slice(0, 2).map((o) => decorate(prop, o, wx)), want };
}

function activity(prop, stand, s, e, off) {
  const near = prop.sightings.filter((x) => P.distM(stand.coords[0], [x.lat, x.lng]) < 240);
  const winStart = (((s + off * 1000) % 86400000) / 3600000), winEnd = winStart + (e - s) / 3600000;
  let sum = 0, tgt = 0, n = 0;
  near.forEach((x) => {
    const age = (Date.now() - x.ts) / 86400000;
    const hr = (((x.ts + off * 1000) % 86400000) / 3600000);
    const inWin = hr >= winStart - 1 && hr <= winEnd + 1;
    const buck = /buck/i.test(x.animal) && !/spike/i.test(x.animal);
    const w = (inWin ? 1 : 0.15) * Math.exp(-age / 30) * (buck ? 1.8 : 1) * (/Rubb|Scrap/.test(x.behavior) ? 1.3 : 1);
    sum += w; if (inWin) { n++; if (buck) tgt++; }
  });
  return { score: Math.min(1, sum / 5), inWindow: n, targets: tgt };
}

function decorate(prop, o, wx) {
  const off = wx.utcOffsetSec;
  const st = o.stand, c = o.cone;
  const sp = st.coords[0];
  const access = prop.features.find((f) => f.id === st.accessId) || nearestAccess(prop, sp);
  const bedding = prop.features.filter((f) => f.type === 'bedding').map((b) => ({ name: b.name, d: Math.round(P.distM(sp, P.centroid(b.coords))), brg: P.bearing(sp, P.centroid(b.coords)) })).sort((a, b) => a.d - b.d);
  const why = [];
  why.push(`Scent check: ${c.status.toUpperCase()}. ${c.reason}`);
  if (o.act.inWindow) why.push(`${o.act.inWindow} logged sighting${o.act.inWindow > 1 ? 's' : ''} within 240 m of this stand at this time of day${o.act.targets ? ` (${o.act.targets} of them target bucks)` : ''}.`);
  else why.push('Limited camera history at this time of day near this stand; this is mostly a wind/thermal play.');
  const w = o.w0;
  if (o.tr > 0.06) why.push(`Barometer climbing (+${o.tr.toFixed(2)} inHg over 12 h) to ${w.pressureInHg.toFixed(2)} inHg: post-front movement window.`);
  else if (o.tr < -0.06) why.push(`Barometer falling (${o.tr.toFixed(2)} inHg over 12 h): deer feed hard ahead of the front.`);
  if (w.tempF < 45) why.push(`Cold start (${Math.round(w.tempF)}°F) keeps deer on their feet longer in daylight.`);
  const ix = Wild.intel(prop);
  if (o.pred > 0.2) why.push(`Predator / disturbance pressure sits within about 200 m of this stand (${ix.zones.filter((z) => P.distM(sp, [z.lat, z.lng]) < z.r + 80).map((z) => z.label.toLowerCase()).join(', ')}): deer here are likely warier and moving later.`);
  else if (ix.pressure > 0.25 && ix.effects[0]) why.push(ix.headline);
  const fm = o.cones[Math.floor(o.cones.length / 2)];
  why.push(`Thermals: ${o.period === 'AM' ? 'morning flow rises off the sun-warmed slopes; expect a switch near first light' : 'evening cooling drains air downslope toward the swamp basin'}${fm.mode ? ' (stand cell: ' + fm.mode + ')' : ''}.`);
  const route = entryRoute(prop, st, access, c, bedding, o.period);
  const dayLabel = `${weekday(o.start, off)} ${fmtDay(o.start, off).slice(5)}`;
  const window = `${dayLabel}, ${hm12(o.start + (o.period === 'AM' ? 30 * 60000 : 0), off)} – ${hm12(o.end, off)}`;
  return {
    standId: st.id, standName: st.name, lat: sp[0], lng: sp[1], period: o.period, startMs: o.start, endMs: o.end,
    window, score: round(o.score, 1), scent: { status: c.status, reason: c.reason, compass: c.compass, azimuth: c.azimuth, speedMph: c.speedMph },
    conditions: {
      window, barometer: `${w.pressureInHg.toFixed(2)} inHg (${o.tr >= 0 ? '+' : ''}${o.tr.toFixed(2)} / 12 h)`,
      wind: `${P.compass(w.windDir)} (${w.windDir}°) ${Math.round(w.windMph)} mph`, temp: `${Math.round(w.tempF)}°F`, cloud: `${w.cloud}%`,
    },
    why, entryRoute: route,
  };
}
function nearestAccess(prop, p) {
  const a = prop.features.filter((f) => f.type === 'access');
  return a.sort((x, y) => P.distToLine(p, x.coords) - P.distToLine(p, y.coords))[0] || null;
}
function entryRoute(prop, st, access, cone, bedding, period) {
  const steps = [];
  const sp = st.coords[0];
  const scentDir = cone.compass;
  if (access) {
    const start = access.coords[0];
    const approachFrom = P.compass(P.bearing(sp, start));
    steps.push(`Stage at the start of "${access.name}" (${P.compass(P.bearing(sp, start))} of the stand). Park / exit the house on the far side from the cover.`);
    steps.push(`Walk "${access.name}" slowly in the dark; the final approach to the stand comes in from the ${approachFrom} while your scent drifts ${scentDir}.`);
  } else steps.push('No access trail mapped for this stand. Draw one with the Access Trail tool, then re-run the plan.');
  const near = bedding.slice(0, 2).filter((b) => b.d < 150);
  near.forEach((b) => steps.push(`Do not cross within ~60 m of "${b.name}" (${b.d} m ${P.compass(b.brg)}); stay on the downwind side of it.`));
  steps.push(period === 'AM'
    ? 'Be in the stand 45 min before first light; pull gear up by rope, no flashlight, hold still through the thermal switch at dawn.'
    : 'Walk in with a cooling air mass (scent drains down-slope); be settled 2 h before dark and stay put until 30 min after legal light.');
  steps.push(period === 'AM' ? 'Exit after 10:30 or when movement dies, along the same access trail.' : 'Exit by headlamp-off, low, along the same trail; let deer clear the food source first.');
  return steps;
}

function planToText(prop, plan) {
  if (plan.error) return plan.error;
  const b = plan.best;
  let t = `**RECOMMENDED SIT: ${b.standName}**\n**Window:** ${b.window}\n**Conditions:** ${b.conditions.barometer}, ${b.conditions.wind}, ${b.conditions.temp}\n\n**Why attack here**\n${b.why.map((x) => '- ' + x).join('\n')}\n\n**Stealth entry**\n${b.entryRoute.map((x, i) => `${i + 1}. ${x}`).join('\n')}`;
  if (plan.alternatives.length) t += `\n\n**Backups:** ${plan.alternatives.map((a) => `${a.standName} (${a.window}, scent ${a.scent.status.toUpperCase()})`).join(' | ')}`;
  return t;
}

/* ---------- tool implementations (shared by MCP + chat) ---------- */
const TOOLS = [
  { name: 'get_scout_log', description: "Returns the hunter's Scout Log: photos, videos, notes and hunts uploaded from the phone (Telegram bot / mini app) with GPS spot, time, caption, what the photo shows (when analyzed), and a where/when read (nearest stand, repeat activity, nearby sightings). Plus a property summary and hot spot. Use it to ground scouting and stand advice in what the hunter actually saw.",
    inputSchema: { type: 'object', properties: { property_id: { type: 'string' }, limit: { type: 'number', description: 'Max entries, newest first (default 40).' } } } },
  { name: 'get_property_map_data', description: 'Returns the hunting property boundary, bedding areas, food sources, water, pinch points, stands, trail cameras, access trails and a summarized elevation grid (benches, ridges, drains).',
    inputSchema: { type: 'object', properties: { property_id: { type: 'string', description: 'Property id; defaults to the active property.' } } } },
  { name: 'get_trail_cam_sightings', description: 'Returns logged animal sightings with timestamps, behavior, travel direction and the weather at the time (wind, barometer, temperature), plus summary statistics.',
    inputSchema: { type: 'object', properties: { property_id: { type: 'string' }, animal: { type: 'string', description: 'Filter by animal name or id fragment, e.g. "8-point".' }, behavior: { type: 'string', enum: ['Bedding', 'Cruising', 'Feeding', 'Rubbing', 'Scraping'] }, since_days: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'get_live_weather_and_thermals', description: 'Returns current wind, barometric pressure (inHg), temperature, a 12 h trend, the computed thermal regime (rising / falling / switch) and the live scent-cone status for each stand. Optionally forecasts hours ahead.',
    inputSchema: { type: 'object', properties: { property_id: { type: 'string' }, hours_ahead: { type: 'number', description: '0-72; returns an hourly forecast with thermal mode.' } } } },
  { name: 'place_tactical_target_pin', description: 'Drops a pulsing Red Target Pin on the hunter\'s map board with ideal conditions, tactical reasoning and a stealth entry route. Pass stand_id to snap to a stand, or lat/lng.',
    inputSchema: { type: 'object', required: ['title'], properties: { property_id: { type: 'string' }, title: { type: 'string' }, stand_id: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' },
      ideal_time: { type: 'string', description: 'e.g. "Saturday 6:15 AM - 9:00 AM"' }, barometer: { type: 'string', description: 'e.g. "rising to 30.15 inHg"' }, wind: { type: 'string', description: 'e.g. "NW 6 mph"' }, temp: { type: 'string' },
      reasoning: { type: 'string' }, entry_route: { type: 'array', items: { type: 'string' } } } } },
  { name: 'recommend_hunt_plan', description: 'Runs the built-in tactical planner: scores every stand/time window over the next days using thermals, scent cones, camera history and barometer, and returns the best attack plan. Accepts natural language like "Saturday morning cold front".',
    inputSchema: { type: 'object', properties: { property_id: { type: 'string' }, request: { type: 'string' }, drop_pin: { type: 'boolean', description: 'Also place a red target pin for the top recommendation.' } } } },
  { name: 'get_wildlife_log', description: 'Returns every logged non-deer animal and sign (bear, coyote heard, turkey, hogs, people/ATVs...) with time, method, location and weather, plus predator-pressure analysis and how it likely changes deer movement. Also lists which game the hunter is targeting.',
    inputSchema: { type: 'object', properties: { property_id: { type: 'string' }, species: { type: 'string' }, since_days: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'log_wildlife_event', description: 'Logs a wildlife observation the hunter just told you about (e.g. "heard coyotes last night", "bear walked through the back yard"). Use when the hunter reports it in conversation.',
    inputSchema: { type: 'object', required: ['species'], properties: { property_id: { type: 'string' }, species: { type: 'string', enum: Object.keys(Wild.SPECIES) }, method: { type: 'string', enum: Wild.METHODS }, count: { type: 'number' },
      when_iso: { type: 'string', description: 'ISO time; defaults to now. For "last night" use about 10 PM yesterday.' }, heard_from_compass: { type: 'string', description: 'N, NE, E... if heard from a direction' }, note: { type: 'string' } } } },
  { name: 'show_deer_movement', description: 'Draws animated herds of deer moving along the predicted travel routes on the hunter\'s map. Use this whenever the hunter asks how/where deer will move, bed, feed or travel. when = morning (feed to bed), evening (bed to feed), night or all.',
    inputSchema: { type: 'object', properties: { property_id: { type: 'string' }, when: { type: 'string', enum: ['morning', 'evening', 'night', 'all'] }, max_routes: { type: 'number' } } } },
  { name: 'add_map_marker', description: 'Puts a stand, camera, pinch point, scrape or house on the hunter\'s map. Give lat/lng, or set suggested=true to place the best terrain-based setup that is not already used.',
    inputSchema: { type: 'object', required: ['type'], properties: { property_id: { type: 'string' }, type: { type: 'string', enum: ['stand', 'camera', 'pinch', 'scrape', 'house', 'start'] }, name: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' }, suggested: { type: 'boolean' }, notes: { type: 'string' } } } },
  { name: 'move_map_marker', description: 'Moves an existing stand/camera/pinch/scrape/house/pin to a new spot. Identify it by id or name. Give lat/lng, or to_marker (another marker\'s name) with offset_m to put it beside that one.',
    inputSchema: { type: 'object', properties: { property_id: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' }, to_marker: { type: 'string' }, offset_m: { type: 'number' } } } },
  { name: 'show_on_map', description: 'Draws something temporary on the hunter\'s map to explain an answer: a pulsing labelled spot (style label), an arrow route such as a walk-in path (style route, 2+ points) or a shaded zone (style zone with radius_m).',
    inputSchema: { type: 'object', required: ['label', 'points'], properties: { property_id: { type: 'string' }, label: { type: 'string' }, style: { type: 'string', enum: ['label', 'route', 'zone'] }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[[lat,lng],...]' }, radius_m: { type: 'number' }, note: { type: 'string' }, color: { type: 'string' } } } },
  { name: 'plan_scouting_walk', description: 'Draws a beginner scouting walk on the map: where to start (the hunter\'s Start marker, or the property edge nearest a road), numbered stops, what to look for at each, and wind warnings. Use when the hunter asks how or where to scout or walk the property.',
    inputSchema: { type: 'object', properties: { property_id: { type: 'string' } } } },
  { name: 'clear_ai_overlays', description: 'Removes everything the AI drew on the map (herds, routes, labels).',
    inputSchema: { type: 'object', properties: { property_id: { type: 'string' } } } },
];

function makeTools(store) {
  const getProp = (id) => {
    const p = store.state.properties.find((x) => x.id === (id || store.state.activeProperty)) || store.state.properties[0];
    if (!p) throw new Error('No property found');
    return p;
  };
  const impl = {
    async get_property_map_data(a) {
      const p = getProp(a.property_id), g = await getGrid(p), an = await getAnalysis(p);
      const roles = {}; an.cells.forEach((c) => (roles[c.role] = (roles[c.role] || 0) + 1));
      const pick = (r) => an.cells.filter((c) => c.role === r).slice(0, 12).map((c) => ({ ...llOf(an, c), elevFt: Math.round(c.z * P.FT) }));
      const F = (t) => p.features.filter((f) => f.type === t).map((f) => ({ id: f.id, name: f.name, kind: f.kind, coords: f.coords, notes: f.notes, ...(f.facing != null ? { facing_deg: Math.round(f.facing), facing: P.compass(f.facing) } : {}), ...(f.fov ? { sees_degrees_wide: f.fov } : {}), ...(f.rangeM ? { reach_ft: Math.round(f.rangeM * 3.28) } : {}) }));
      return {
        property: { id: p.id, name: p.name, address: p.address, center: p.center },
        boundary: F('boundary'), stands: F('stand'), trail_cameras: F('camera'), bedding_areas: F('bedding'), food_sources: F('food'), water: F('water'),
        pinch_points: F('pinch'), scrapes: F('scrape'), rub_lines: F('rubline'), access_trails: F('access'), buffers: F('buffer'),
        tactical_pins: p.pins.map((x) => ({ id: x.id, title: x.title, lat: x.lat, lng: x.lng })),
        elevation: { source: g.source, gridSpacingM: g.spacing, size: g.n + 'x' + g.n, minFt: Math.round(an.minM * P.FT), maxFt: Math.round(an.maxM * P.FT),
          terrainRoles: roles, benches: pick('bench'), ridges: pick('ridge'), creekDrains: pick('drain'), basins: pick('basin'),
          rowsFt_south_to_north: g.elevM.map((r) => r.map((z) => Math.round(z * P.FT))) },
      };
    },
    async get_scout_log(a) {
      const p = getProp(a.property_id), Sc = require('./scout.js'), ai = require('./scoutai.js').analyze(p, Sc.list());
      const ents = Sc.list().filter((e) => e.propertyId === p.id && e.kind !== 'location').slice(0, Math.min(Number(a.limit) || 40, 200));
      return { property: p.name, summary: ai.summary, caveat: ai.caveat, entries: ents.map((e) => ({ kind: e.kind, ts: new Date(e.ts).toISOString(), lat: e.lat, lng: e.lng, caption: e.caption || '', stand: e.stand, photo_shows: ai.items[e.id] && ai.items[e.id].see, read: ai.items[e.id] && ai.items[e.id].read, adds: ai.items[e.id] && ai.items[e.id].adds })) };
    },
    async get_trail_cam_sightings(a) {
      const p = getProp(a.property_id);
      const list = sightingStats(p, { animal: a.animal, sinceDays: a.since_days, behavior: a.behavior });
      const lim = Math.min(Number(a.limit) || 60, 200);
      const wx = await getWeather(p), off = wx.utcOffsetSec;
      const hist = {}, windDirs = {}, byBeh = {};
      list.forEach((s) => {
        const h = new Date(s.ts + off * 1000).getUTCHours(); hist[h] = (hist[h] || 0) + 1;
        const wd = P.compass(s.wx.windDir); windDirs[wd] = (windDirs[wd] || 0) + 1; byBeh[s.behavior] = (byBeh[s.behavior] || 0) + 1;
      });
      return {
        total: list.length,
        summary: { by_behavior: byBeh, by_local_hour: hist, wind_direction_at_sighting: windDirs },
        sightings: list.slice().sort((x, y) => y.ts - x.ts).slice(0, lim).map((s) => ({
          number: s.num, animal: s.animal, time: new Date(s.ts).toISOString(), local: weekday(s.ts, off) + ' ' + hm12(s.ts, off), camera: s.camName,
          lat: s.lat, lng: s.lng, behavior: s.behavior, travel_heading: s.heading ? s.heading + '° ' + P.compass(s.heading) : null, note: s.note,
          weather: { tempF: s.wx.tempF, barometer_inHg: s.wx.pressureInHg, wind: P.compass(s.wx.windDir) + ' ' + Math.round(s.wx.windMph) + ' mph' },
        })),
      };
    },
    async get_live_weather_and_thermals(a) {
      const p = getProp(a.property_id), wx = await getWeather(p), off = wx.utcOffsetSec, now = Date.now();
      const { field, wx: w } = await fieldAt(p, wx, now);
      const hrs = Math.min(Math.max(Number(a.hours_ahead) || 0, 0), 72);
      const forecast = [];
      if (hrs) {
        const an = await getAnalysis(p), water = waterFn(p);
        for (let h = 1; h <= hrs; h++) {
          const t = now + h * 3600000, ww = wxAt(wx, t), f = P.computeField(an, ww, { utcMs: t }, water);
          forecast.push({ local: weekday(t, off) + ' ' + hm12(t, off), tempF: ww.tempF, barometer_inHg: ww.pressureInHg, wind: P.compass(ww.windDir) + ' ' + Math.round(ww.windMph) + ' mph', cloudPct: ww.cloud, thermal_regime: f.mode, sun_elevation_deg: round(f.sunE, 1),
            stand_scent: Object.fromEntries(stands(p).map((s) => [s.name, P.scentCone(s.coords[0], f, p.features).status])) });
        }
      }
      const moon = P.moonPhase(now);
      return {
        source: wx.source, property: p.name, local_time: weekday(now, off) + ' ' + hm12(now, off),
        current: { tempF: w.tempF, barometer_inHg: w.pressureInHg, barometer_trend_6h_inHg: trend(wx, now, 6), wind: P.compass(w.windDir) + ' (' + w.windDir + '°) ' + w.windMph + ' mph', cloudPct: w.cloud },
        thermals: { regime: field.mode, sun_elevation_deg: round(field.sunE, 1), thermal_switch_active: field.transition, explanation: field.transition ? 'Dawn/dusk transition: rising and falling currents collide, expect swirling, unreliable scent.' : field.mode === 'rising' ? 'Sun-heated slopes pull air upslope.' : 'Radiative cooling sends dense air downhill into the creek/swamp drains.' },
        stand_scent_cones: standScents(p, field), moon: moon.name + ' (' + moon.illum + '%)', forecast,
      };
    },
    async get_wildlife_log(a) {
      const p = getProp(a.property_id), now = Date.now();
      let list = (p.wildlife || []).filter((e) => (!a.species || e.species === a.species) && (!a.since_days || e.ts >= now - a.since_days * 86400000));
      return { targets: p.targets || ['deer'], intel: Wild.intel(p), total: list.length, events: list.sort((x, y) => y.ts - x.ts).slice(0, Math.min(Number(a.limit) || 60, 200)).map((e) => ({ species: e.species, method: e.method, count: e.count, time: new Date(e.ts).toISOString(), place: e.place, lat: e.lat, lng: e.lng, note: e.note, wind: e.wx ? P.compass(e.wx.windDir) + ' ' + Math.round(e.wx.windMph) + ' mph' : null, tempF: e.wx ? e.wx.tempF : null, moon: e.moon && e.moon.name })) };
    },
    async log_wildlife_event(a) {
      const p = getProp(a.property_id); p.wildlife = p.wildlife || [];
      const idx = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'].indexOf(String(a.heard_from_compass || '').toUpperCase());
      const ev = Wild.build(p, { species: a.species, method: a.method || 'seen', count: a.count, ts: a.when_iso ? Date.parse(a.when_iso) : Date.now(), heading: idx >= 0 ? idx * 22.5 : null, note: a.note }, (x) => x + Math.random().toString(36).slice(2, 9), null);
      p.wildlife.push(ev); store.changed(p.id, 'wildlife');
      return { ok: true, id: ev.id, intel: Wild.intel(p).headline };
    },
    async show_deer_movement(a) {
      const p = getProp(a.property_id), Home = require('./home.js');
      let an = null, wx = null; try { an = await getAnalysis(p); } catch (e) { /* optional */ } try { wx = await getWeather(p); } catch (e) { /* optional */ }
      const r = Home.predict(p, wx, an), when = a.when || 'evening';
      const rts = r.paths.slice().sort((x, y) => y.strength - x.strength).slice(0, Math.min(Math.max(Number(a.max_routes) || 4, 1), 8));
      if (!rts.length) return { error: 'No travel routes yet. The terrain or surroundings are still loading; try again in a minute.' };
      p.overlays = (p.overlays || []).filter((o) => o.kind !== 'herd');
      rts.forEach((t, i) => {
        const bedFood = !t.terrain, rev = when === 'morning' ? bedFood : (!bedFood && i % 2 === 1);
        const pts = rev ? t.pts.slice().reverse() : t.pts, count = Math.min(7, 1 + Math.round(t.strength * 4) + Math.min(t.sightings, 2));
        const dir = bedFood ? (rev ? 'feeding area to bedding' : 'bedding to feeding area') : (t.terrain === 'bench' ? 'along the bench' : 'along the creek');
        p.overlays.push({ id: 'o' + Math.random().toString(36).slice(2, 9), kind: 'herd', name: t.name, pts, count, when, source: 'advisor', ts: Date.now(),
          off: !!t.off, note: `${t.off ? 'On neighbor land (no access). ' : ''}${count} deer, ${dir}. ${t.terrain ? t.why : `Between ${t.from} and ${t.to}.`} ${t.sightings ? t.sightings + ' camera sightings agree.' : 'Terrain guess, no camera sightings on it yet.'}${t.predator ? ' Predator activity nearby weakens it.' : ''}` });
      });
      store.changed(p.id, 'overlays');
      const when2 = { morning: 'this morning (heading to bed)', evening: 'this evening (heading to feed)', night: 'at night', all: 'through the day' }[when];
      return { ok: true, routes: rts.map((t) => ({ name: t.name, confidence: Math.round(t.strength * 100) + '%', sightings: t.sightings })), summary: `Animated ${rts.length} deer herds on the map ${when2}.` };
    },
    async add_map_marker(a) {
      const p = getProp(a.property_id); let lat = a.lat, lng = a.lng, name = a.name, notes = a.notes || '';
      if (a.suggested || typeof lat !== 'number') {
        const Home = require('./home.js'); let an = null, wx = null; try { an = await getAnalysis(p); } catch (e) { /* optional */ } try { wx = await getWeather(p); } catch (e) { /* optional */ }
        const sites = Home.predict(p, wx, an).sites.filter((x) => !p.features.some((f) => f.type === 'stand' && P.distM(f.coords[0], x.coords) < 25));
        if (sites.length) { [lat, lng] = sites[0].coords; name = name || sites[0].name.replace('Suggested setup', 'Stand'); notes = notes || sites[0].why + ' Best winds from ' + sites[0].goodWinds + '.'; }
        else {
          const fb = Home.bestSpot(p, an);
          if (!fb) throw new Error('I could not find a good spot: the open, dry ground on this property is too close to houses, water, the edge of the property or your existing stands. Place one by hand (click the map) or tell me where.');
          [lat, lng] = fb.coords; notes = notes || fb.why;
        }
      }
      const label = { stand: 'Stand', camera: 'Camera', pinch: 'Pinch Point', scrape: 'Scrape', house: 'House', start: 'My Start' }[a.type];
      const f = { id: 'f' + Math.random().toString(36).slice(2, 9), type: a.type, kind: 'point', name: name || label + ' ' + (p.features.filter((x) => x.type === a.type).length + 1), coords: [[lat, lng]], notes };
      p.features.push(f); store.changed(p.id, 'features');
      return { ok: true, id: f.id, name: f.name, lat, lng };
    },
    async move_map_marker(a) {
      const p = getProp(a.property_id), low = (x) => String(x || '').toLowerCase();
      const find = (id, nm) => p.features.find((f) => f.kind === 'point' && (f.id === id || (nm && low(f.name) === low(nm)))) || (nm && p.features.find((f) => f.kind === 'point' && low(f.name).includes(low(nm))));
      const f = find(a.id, a.name); if (!f) throw new Error('Could not find that marker. Use get_property_map_data for names and ids.');
      let lat = a.lat, lng = a.lng;
      if (a.to_marker) { const t = find(null, a.to_marker); if (!t) throw new Error('Could not find ' + a.to_marker); const o = P.offset(t.coords[0][0], t.coords[0][1], Number(a.offset_m) || 12, 0); [lat, lng] = o; }
      if (typeof lat !== 'number' || typeof lng !== 'number') throw new Error('Give lat/lng or to_marker');
      f.coords = [[lat, lng]]; store.changed(p.id, 'features');
      return { ok: true, id: f.id, name: f.name, lat, lng };
    },
    async show_on_map(a) {
      const p = getProp(a.property_id), pts = (a.points || []).filter((q) => Array.isArray(q) && typeof q[0] === 'number' && typeof q[1] === 'number');
      if (!pts.length) throw new Error('points required');
      p.overlays = p.overlays || [];
      const o = { id: 'o' + Math.random().toString(36).slice(2, 9), kind: a.style || (pts.length > 1 ? 'route' : 'label'), name: String(a.label).slice(0, 80), pts, radius: a.radius_m, note: a.note || '', color: a.color || null, source: 'advisor', ts: Date.now() };
      p.overlays.push(o); store.changed(p.id, 'overlays'); return { ok: true, id: o.id };
    },
    async plan_scouting_walk(a) {
      const p = getProp(a.property_id), Home = require('./home.js');
      let an = null, wx = null; try { an = await getAnalysis(p); } catch (e) { /* optional */ } try { wx = await getWeather(p); } catch (e) { /* optional */ }
      const r = Home.scoutPlan(p, wx, an); if (r.error) return { error: r.error };
      p.overlays = (p.overlays || []).filter((o) => o.kind !== 'scout');
      p.overlays.push({ id: 'o' + Math.random().toString(36).slice(2, 9), kind: 'scout', name: 'Scouting walk', pts: r.pts, stops: r.stops, tips: r.tips, start: r.start, startAssumed: r.startAssumed, distM: r.distM, minutes: r.minutes, note: r.note, source: 'advisor', ts: Date.now() });
      store.changed(p.id, 'overlays');
      return { ok: true, start: r.startAssumed ? 'assumed (no Start marker yet)' : 'your Start marker', distance_ft: Math.round(r.distM * 3.28), minutes: r.minutes, stops: r.stops.map((s) => ({ n: s.n, name: s.name, why: s.why, look_for: s.look, wind: s.wind || undefined })), tips: r.tips, note: r.note };
    },
    async clear_ai_overlays(a) {
      const p = getProp(a.property_id), n = (p.overlays || []).length; p.overlays = []; store.changed(p.id, 'overlays'); return { ok: true, removed: n };
    },
    async place_tactical_target_pin(a) {
      const p = getProp(a.property_id);
      let lat = a.lat, lng = a.lng, standId = a.stand_id;
      if (standId) { const s = p.features.find((f) => f.id === standId); if (!s) throw new Error('Unknown stand_id ' + standId); [lat, lng] = s.coords[0]; }
      if (typeof lat !== 'number' || typeof lng !== 'number') throw new Error('Provide stand_id or lat/lng');
      const pin = store.addPin(p, {
        title: String(a.title).slice(0, 120), lat, lng, standId: standId || null, source: 'mcp',
        conditions: { window: a.ideal_time || '', barometer: a.barometer || '', wind: a.wind || '', temp: a.temp || '' },
        why: [].concat(a.reasoning || []), entryRoute: Array.isArray(a.entry_route) ? a.entry_route.map(String) : a.entry_route ? [String(a.entry_route)] : [],
      });
      return { ok: true, pin_id: pin.id, message: 'Red Target Pin placed on the war board.' };
    },
    async recommend_hunt_plan(a) {
      const p = getProp(a.property_id), plan = await planHunt(p, a.request || '');
      if (plan.error) return { error: plan.error };
      let pin = null;
      if (a.drop_pin) pin = store.addPin(p, pinFromPlan(plan.best, 'mcp'));
      return { text: planToText(p, plan), best: plan.best, alternatives: plan.alternatives, pin_id: pin && pin.id };
    },
  };
  return { impl, getProp };
}
const llOf = (an, c) => { const r = P.offset(an.center.lat, an.center.lng, c.x, c.y); return { lat: round(r[0], 6), lng: round(r[1], 6) }; };
function pinFromPlan(b, source = 'advisor') {
  return { title: 'ATTACK: ' + b.standName, lat: b.lat, lng: b.lng, standId: b.standId, source, conditions: b.conditions, why: b.why, entryRoute: b.entryRoute, startMs: b.startMs, endMs: b.endMs, scent: b.scent };
}

/* ---------- chat (rule-based advisor, upgraded to Claude when a key is configured) ---------- */
async function chat(store, { message, propertyId, history = [] }) {
  const { impl, getProp } = makeTools(store);
  const p = getProp(propertyId);
  if (process.env.ANTHROPIC_API_KEY) {
    try { return await claudeChat(store, p, message, history, impl); } catch (e) { console.warn('[chat] Claude failed, using local advisor:', e.message); }
  }
  const t = message.toLowerCase();
  const planish = /where|sit|hunt|stand|plan|best|when|tomorrow|saturday|sunday|monday|tuesday|wednesday|thursday|friday|morning|evening|front/.test(t);
  if (/\bhelp\b|what can you/.test(t)) return { reply: 'I\'m your CabinScout advisor. Ask me things like:\n- "Where should I sit this Saturday morning for a cold front?"\n- "What are the thermals doing right now?"\n- "Show me what the Swamp 8-Point has been doing."\nI\'ll read your cameras, the live weather and the thermal model, then hand you a plan with a Red Target Pin.', actions: [] };
  const mapTools = (nm, args) => impl[nm]({ property_id: p.id, ...args });
  if (/\b(clear|remove|erase|hide|reset)\b.*\b(drawing|drawings|overlay|overlays|herds?|map)\b/.test(t)) {
    const r = await mapTools('clear_ai_overlays', {}); return { reply: r.removed ? 'Cleared my drawings from the map.' : 'There was nothing of mine on the map.', actions: [], mapChanged: true };
  }
  if (/\b(scout|scouting)\b|\b(where|how)\b.*\b(walk|go in|go in to|start)\b.*\b(property|land|woods|scout)\b|\bwalk the (property|land)\b/.test(t)) {
    try {
      const r = await mapTools('plan_scouting_walk', {}); if (r.error) return { reply: r.error, actions: [] };
      return { reply: `**Scouting walk drawn on your map.** About ${r.distance_ft} ft, roughly ${r.minutes} minutes. Start: ${r.start}.${r.start.startsWith('assumed') ? ' Drop a **Start** marker where you really begin (click the map, then Start) and ask again.' : ''}\n\n${r.stops.map((s) => `${s.n}. **${s.name}**: ${s.why} Look for: ${s.look_for.slice(0, 3).join('; ')}.${s.wind ? ' ' + s.wind : ''}`).join('\n')}\n\n**How to walk it**\n${r.tips.map((x) => '- ' + x).join('\n')}\n\n${r.note}`, actions: [], mapChanged: true };
    } catch (e) { return { reply: e.message, actions: [] }; }
  }
  const mv = /\bmove\s+(?:the\s+)?(.+?)\s+(?:to|next to|beside|near)\s+(?:the\s+)?(.+?)[.!?]*$/.exec(t);
  if (mv) {
    try { const r = await mapTools('move_map_marker', { name: mv[1], to_marker: mv[2] }); return { reply: `Moved **${r.name}** next to ${mv[2]}. You can also drag any marker on the map.`, actions: [], mapChanged: true }; } catch (e) { /* fall through to the other intents */ }
  }
  if (/\b(add|put|place|drop|set)\b.*\b(stand|setup)s?\b/.test(t) && /best|suggest|good|where|spot|anywhere|for me|a stand|up/.test(t)) {
    try { const r = await mapTools('add_map_marker', { type: 'stand', suggested: true }); return { reply: `Put **${r.name}** on the map at the best unused terrain setup. Drag it if you want it somewhere else, or click it for why I picked it.`, actions: [], mapChanged: true }; } catch (e) { return { reply: e.message, actions: [] }; }
  }
  if (/\b(deer|herds?|movement|moving|travel|patterns?|routes?)\b/.test(t) && /\b(show|where|how|animate|draw|display|move|moving|go|going|travel|pattern|patterns|herds?|walk)\b/.test(t) && !/\bsit\b/.test(t)) {
    const hr = new Date().getHours();
    const when = /morning|dawn|sunrise|am\b/.test(t) ? 'morning' : /evening|dusk|sunset|tonight|afternoon|pm\b/.test(t) ? 'evening' : /night|overnight/.test(t) ? 'night' : hr < 12 ? 'morning' : 'evening';
    const r = await mapTools('show_deer_movement', { when });
    if (r.error) return { reply: r.error, actions: [] };
    return { reply: `${r.summary} These are terrain and land-cover guesses, not confirmed. They avoid water, houses and yards. Click a route for why I think they use it; routes on neighbor land are shown faded because you can't hunt them.
${r.routes.map((x) => `- ${x.name}: ${x.confidence} confidence${x.sightings ? ', ' + x.sightings + ' sightings' : ''}`).join('\n')}
Say "clear the map" to remove them.`.replace(/\\n/g, '\n'), actions: [], mapChanged: true };
  }
  if (!planish && /thermal|wind|weather|pressure|barometer|scent/.test(t)) {
    const r = await impl.get_live_weather_and_thermals({ property_id: p.id });
    const lines = r.stand_scent_cones.map((s) => `- ${s.name}: **${s.status.toUpperCase()}**. ${s.reason}`);
    return { reply: `**Live conditions · ${r.local_time}**\n${r.current.tempF}°F, ${r.current.barometer_inHg} inHg (${r.current.barometer_trend_6h_inHg >= 0 ? '+' : ''}${r.current.barometer_trend_6h_inHg} / 6 h), wind ${r.current.wind}\n**Thermals:** ${r.thermals.regime.toUpperCase()}. ${r.thermals.explanation}\n\n**Scent status by stand**\n${lines.join('\n')}`, actions: [] };
  }
  if (!planish || /sighting|camera|buck|seen/.test(t) && !/where|sit/.test(t)) {
    const animal = /8.?point|swamp/.test(t) ? '8-Point' : /10.?point|ridge/.test(t) ? '10-Point' : /doe/.test(t) ? 'Doe' : undefined;
    const r = await impl.get_trail_cam_sightings({ property_id: p.id, animal, limit: 6 });
    const best = Object.entries(r.summary.by_local_hour).sort((a, b) => b[1] - a[1])[0];
    return { reply: `**${r.total} sightings${animal ? ' of ' + animal : ''}.** Behaviors: ${Object.entries(r.summary.by_behavior).map(([k, v]) => k + ' ' + v).join(', ')}.${best ? ` Peak hour: ${best[0]}:00.` : ''}\n\nMost recent:\n${r.sightings.slice(0, 5).map((s) => `- #${s.number} ${s.animal}, ${s.local}, ${s.behavior} at ${s.camera}, wind ${s.weather.wind}`).join('\n')}\n\nAsk "where should I sit" and I'll turn this into a plan.`, actions: [] };
  }
  const plan = await planHunt(p, message);
  if (plan.error) return { reply: plan.error, actions: [] };
  const pin = pinFromPlan(plan.best);
  const auto = /\b(pin|drop|mark)\b/.test(t);
  let placed = null;
  if (auto) placed = store.addPin(p, pin);
  return { reply: planToText(p, plan) + (placed ? '\n\nRed Target Pin dropped on the board.' : ''), actions: placed ? [] : [{ type: 'pin', label: 'PIN THIS SIT ON THE MAP', pin }], alt: plan.alternatives.map((a) => ({ type: 'pin', label: a.standName, pin: pinFromPlan(a) })) };
}

async function claudeChat(store, prop, message, history, impl) {
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
  const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const system = `You are the CabinScout tactical advisor for a beginner whitetail hunter. Active property: "${prop.name}" (id ${prop.id}). Always ground answers in tool data (trail-cam sightings, live weather, thermals, scent cones). Give concrete attack plans: stand, time window, wind/barometer, why, and a stealth entry route. When you recommend a specific stand, call place_tactical_target_pin (or recommend_hunt_plan with drop_pin) so a Red Target Pin appears on the map. You can also draw on the map: show_deer_movement animates deer herds along predicted routes, add_map_marker and move_map_marker place or move stands/cameras, show_on_map draws labels, walk-in routes or zones. Prefer showing it on the map over only describing it. Keep it concise and plain-spoken.`;
  const messages = [...history.slice(-8).map((m) => ({ role: m.role, content: m.text })), { role: 'user', content: message }];
  let pinsPlaced = 0, mapChanged = false;
  for (let i = 0; i < 6; i++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1800, system, tools, messages }), signal: AbortSignal.timeout(60000),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error && j.error.message ? j.error.message : 'API ' + r.status);
    messages.push({ role: 'assistant', content: j.content });
    if (j.stop_reason !== 'tool_use') return { reply: j.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), actions: [], pinsPlaced, mapChanged };
    const results = [];
    for (const b of j.content.filter((x) => x.type === 'tool_use')) {
      let out;
      try { out = await impl[b.name]({ property_id: prop.id, ...b.input }); if (/pin|plan/.test(b.name) && out.pin_id) pinsPlaced++; if (/show_deer|add_map|move_map|show_on|clear_ai|plan_scouting/.test(b.name)) mapChanged = true; } catch (e) { out = { error: e.message }; }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out).slice(0, 60000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'I ran out of reasoning steps. Try a narrower question.', actions: [] };
}


/* ---------- property map: parcel lookup + place enrichment ---------- */
const ringsOf = (g) => (!g ? [] : g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : []);
const ringArea = (r) => Math.abs(r.reduce((a, c, i) => { const d = r[(i + 1) % r.length]; return a + (c[0] * d[1] - d[0] * c[1]); }, 0));
async function getJson(url, opts) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'CabinScout/1.0' }, ...opts });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
/* Returns { parcel: {boundary:[{lat,lng}], parcelId, owner, address, acres, source} | null, source, hint }.
   Regrid (REGRID_TOKEN) gives real county parcel lines; without it the OSM land polygon under the click is used if there is one. */
/* Massachusetts: free statewide assessor parcels (MassGIS), real lot lines with owner + address. */
const MASS = 'https://services1.arcgis.com/hGdibHYSPO59RG1h/ArcGIS/rest/services/Massachusetts_Property_Tax_Parcels/FeatureServer/0/query';
const inMass = (lat, lng) => lat > 41.2 && lat < 42.9 && lng > -73.55 && lng < -69.85;
function simplifyRing(r, tolM) {
  if (r.length < 8) return r;
  const keep = new Array(r.length).fill(false); keep[0] = keep[r.length - 1] = true;
  const st = [[0, r.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let best = -1, bd = tolM;
    for (let i = a + 1; i < b; i++) { const d = P.distToSeg(r[i], r[a], r[b]); if (d > bd) { bd = d; best = i; } }
    if (best >= 0) { keep[best] = true; st.push([a, best], [best, b]); }
  }
  return r.filter((_, i) => keep[i]);
}
const ringAcres = (r) => { const o = r[0], xy = r.map((p) => P.toXY(p, o)); let a = 0; xy.forEach((p, i) => { const q = xy[(i + 1) % xy.length]; a += p[0] * q[1] - q[0] * p[1]; }); return Math.abs(a) / 2 / 4046.86; };
async function massQuery(geom, type, limit) {
  const u = `${MASS}?where=1%3D1&geometry=${encodeURIComponent(geom)}&geometryType=${type}&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=LOC_ID,SITE_ADDR,CITY,OWNER1,USE_CODE&returnGeometry=true&geometryPrecision=6&resultRecordCount=${limit}&f=geojson`;
  const j = await getJson(u);
  return (j.features || []).map((f) => {
    const g = f.geometry; if (!g) return null;
    const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];
    const ring = rings.map((r) => r.map(([x, y]) => [y, x])).sort((a, b) => ringAcres(b) - ringAcres(a))[0]; if (!ring) return null;
    const pr = f.properties || {}, b = simplifyRing(ring.slice(0, -1), 0.6);
    return { parcelId: 'ma-' + (pr.LOC_ID || f.id), owner: pr.OWNER1 || '', address: [pr.SITE_ADDR, pr.CITY].filter(Boolean).join(', '), acres: round(ringAcres(b), 2), coords: b, source: 'massgis' };
  }).filter(Boolean);
}
const massBox = (w, s, e, n, limit = 1200) => massQuery(`${w},${s},${e},${n}`, 'esriGeometryEnvelope', limit);
async function parcelAt(lat, lng) {
  const token = process.env.REGRID_TOKEN;
  if (inMass(lat, lng)) {
    try {
      const m = (await massQuery(`${lng},${lat}`, 'esriGeometryPoint', 1))[0];
      if (m) return { source: 'massgis', parcel: { boundary: m.coords.map(([a, b]) => ({ lat: a, lng: b })), parcelId: m.parcelId, owner: m.owner, address: m.address, acres: m.acres, source: 'massgis' } };
    } catch (e) { /* fall through */ }
  }
  if (token) {
    try {
      const j = await getJson(`https://app.regrid.com/api/v2/parcels/point?lat=${lat}&lon=${lng}&limit=1&return_geometry=true&token=${encodeURIComponent(token)}`);
      const f = ((j.parcels || j).features || [])[0];
      if (f) {
        const fl = (f.properties && f.properties.fields) || f.properties || {};
        const ring = ringsOf(f.geometry).sort((a, b) => ringArea(b) - ringArea(a))[0];
        if (ring) return { source: 'regrid', parcel: { boundary: ring.slice(0, -1).map(([x, y]) => ({ lat: y, lng: x })), parcelId: fl.parcelnumb || fl.ll_uuid || '', owner: fl.owner || '', address: fl.address || '', acres: fl.ll_gisacre ? round(fl.ll_gisacre, 2) : null, source: 'regrid' } };
      }
      return { source: 'regrid', parcel: null, hint: 'No parcel at that point. Click inside a lot, or trace it by hand.' };
    } catch (e) { /* fall through to OSM */ }
  }
  try {
    const q = `[out:json][timeout:10];is_in(${lat},${lng})->.a;way(pivot.a)[landuse];out geom;way(pivot.a)[leisure~"park|nature_reserve"];out geom;`;
    const j = await getJson('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'CabinScout/1.0' } });
    const ways = (j.elements || []).filter((w) => w.geometry && w.geometry.length > 3).sort((a, b) => a.geometry.length - b.geometry.length);
    const w = ways[0];
    if (w) {
      const ring = w.geometry.map((g) => ({ lat: g.lat, lng: g.lon }));
      if (ring.length > 3 && ring[0].lat === ring[ring.length - 1].lat) ring.pop();
      return { source: 'osm', parcel: { boundary: ring, parcelId: 'osm-' + w.id, owner: (w.tags && (w.tags.name || w.tags.operator)) || '', address: '', acres: null, source: 'osm' },
        hint: 'Approximate land-use outline from OpenStreetMap, not a legal parcel line. Add REGRID_TOKEN for county parcel boundaries.' };
    }
  } catch (e) { /* ignore */ }
  return { source: token ? 'regrid' : 'none', parcel: null, hint: token ? 'No parcel found there.' : 'No parcel data here. Set REGRID_TOKEN for county parcel lines, or trace the boundary by hand.' };
}
async function reverseGeocode(lat, lng) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  try {
    if (key) { const j = await getJson(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`); if (j.results && j.results[0]) return j.results[0].formatted_address; }
    const j = await getJson(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
    return j.display_name || '';
  } catch (e) { return ''; }
}
/* Google Places "nearby" snapshot (roads, parks, businesses). Needs GOOGLE_MAPS_API_KEY with Places API (New) enabled; otherwise empty. */
async function placeInfo(lat, lng) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  try {
    const j = await getJson('https://places.googleapis.com/v1/places:searchNearby', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key, 'x-goog-fieldmask': 'places.displayName,places.types,places.location' },
      body: JSON.stringify({ maxResultCount: 10, locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 800 } } }) });
    return { fetched: Date.now(), nearby: (j.places || []).map((p) => ({ name: p.displayName && p.displayName.text, types: (p.types || []).slice(0, 3), lat: p.location && p.location.latitude, lng: p.location && p.location.longitude })) };
  } catch (e) { return null; }
}

module.exports = { massBox, inMass, parcelAt, reverseGeocode, placeInfo, TOOLS, makeTools, chat, getWeather, getGrid, getAnalysis, wxAt, trend, planHunt, pinFromPlan, fieldAt, standScents, GRID_N, GRID_SPACING };
