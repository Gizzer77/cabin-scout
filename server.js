/* CabinScout server: static files + REST API + MCP (Streamable HTTP + legacy SSE). Zero dependencies. */
const http = require('http');
const fs = require('fs');
const path = require('path');
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((l) => { const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }); } catch (e) { /* no .env */ }
const crypto = require('crypto');
const Seed = require('./seed.js');
const S = require('./services.js');
const Home = require('./home.js');
const Wild = require('./wildlife.js');
const FieldImport = require('./fieldimport.js');
const Connectors = require('./connectors.js');
const PH = require('./public/physics.js');
const Cams = require('./cameras.js');
const Scout = require('./scout.js');
const ScoutAI = require('./scoutai.js');
const ScoutVision = require('./scoutvision.js');

const PORT = Number(process.env.CABINSCOUT_PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const ENV_FILE = path.join(__dirname, '.env');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const UP_DIR = path.join(DATA_DIR, 'uploads');
const PUB = path.join(__dirname, 'public');
fs.mkdirSync(UP_DIR, { recursive: true });

/* ---------- store ---------- */
const uid = (p) => p + crypto.randomBytes(5).toString('hex');
const store = { state: null, sse: new Set(), mcp: { clients: new Map(), lastCall: null, calls: 0 } };
function load() {
  try { store.state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { store.state = null; }
  if (!store.state) {
    store.state = { token: crypto.randomBytes(18).toString('hex'), mcpEnabled: true, activeProperty: null, properties: [] };
    save(true);
  }
  syncDevices();
}
function syncDevices() {
  const st = store.state;
  if (!Array.isArray(st.devices)) st.devices = [];
  if (!Array.isArray(st.connectors)) st.connectors = [];
  if (!Array.isArray(st.inbox)) st.inbox = [];
  st.inbox = st.inbox.filter((x) => st.devices.some((d) => d.id === x.deviceId));
  st.properties.forEach((p) => { if (!Array.isArray(p.wildlife)) p.wildlife = []; if (!Array.isArray(p.hunts)) p.hunts = []; if (!Array.isArray(p.targets) || !p.targets.length) p.targets = ['deer']; });
  st.properties.forEach((p) => p.features.filter((f) => f.type === 'camera' && !st.devices.some((d) => d.featureId === f.id)).forEach((f) => {
    st.devices.push({ id: uid('dev'), name: f.name, brand: '', model: '', battery: null, notes: '', propertyId: p.id, featureId: f.id, deployedAt: Date.now(), addedAt: Date.now() });
    f.deviceId = st.devices[st.devices.length - 1].id;
  }));
}
let saveTimer = null;
function save(now) {
  const run = () => {
    const strip = JSON.stringify(store.state, (k, v) => (k === '_an' || k === '_ctxBusy' ? undefined : v));
    fs.writeFileSync(STATE_FILE + '.tmp', strip);
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  };
  if (now) return run();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(run, 250);
}
function broadcast(ev) {
  const line = 'data: ' + JSON.stringify(ev) + '\n\n';
  store.sse.forEach((res) => res.write(line));
}
store.addPin = (prop, pin) => {
  const full = { id: uid('pin'), ts: Date.now(), ...pin };
  prop.pins.push(full);
  save();
  broadcast({ type: 'pin', propertyId: prop.id, pinId: full.id });
  return full;
};
store.changed = (propId, what) => { save(); broadcast({ type: 'changed', propertyId: propId, what }); };
const prop = (id) => store.state.properties.find((p) => p.id === id);
/* Piece parcels together: each parcel becomes its own boundary outline on one property. */
function addParcels(pr, parcels, permission) {
  pr.parcels = pr.parcels || [];
  let added = 0;
  (parcels || []).forEach((q) => {
    const ring = Array.isArray(q.boundary) ? q.boundary.filter((c) => c && isFinite(c.lat) && isFinite(c.lng)).map((c) => [c.lat, c.lng]) : [];
    if (ring.length < 3) return;
    if (q.parcelId && pr.parcels.some((x) => x.id === String(q.parcelId))) return; // already part of this property
    const n = pr.parcels.length + 1;
    pr.features.push({ id: uid('f'), type: 'boundary', kind: 'polygon', name: `${pr.name} · parcel ${n}${q.owner ? ' (' + String(q.owner).slice(0, 40) + ')' : ''}`, coords: ring, parcelId: String(q.parcelId || '') });
    pr.parcels.push({ id: String(q.parcelId || 'p' + n + Date.now()), owner: String(q.owner || ''), acres: Number(q.acres) || null, source: String(q.source || 'manual'), address: String(q.address || '') });
    added++;
  });
  const all = pr.features.filter((f) => f.type === 'boundary').flatMap((f) => f.coords);
  if (all.length) { const la = all.map((c) => c[0]), ln = all.map((c) => c[1]); pr.center = { lat: (Math.min(...la) + Math.max(...la)) / 2, lng: (Math.min(...ln) + Math.max(...ln)) / 2 }; }
  const owners = [...new Set(pr.parcels.map((x) => x.owner).filter(Boolean))];
  pr.parcel = { id: pr.parcels.map((x) => x.id).join(','), owner: owners.join('; '), acres: Math.round(pr.parcels.reduce((a, x) => a + (x.acres || 0), 0) * 10) / 10 || null, source: (pr.parcels[0] || {}).source || 'manual', permission: permission || (pr.parcel && pr.parcel.permission) || 'owner', parts: pr.parcels.length };
  pr.elevation = null; pr._an = null; // terrain grid re-centers and re-sizes on the combined land
  return added;
}
function detachDevice(d) {
  const pr = prop(d.propertyId);
  if (pr) { pr.features = pr.features.filter((f) => f.id !== d.featureId); store.changed(pr.id, 'features'); }
  d.propertyId = null; d.featureId = null; d.deployedAt = null;
}
const numOrNull = (v, lo, hi, wrap) => { if (v === '' || v == null) return null; let n = Number(v); if (!isFinite(n)) return null; if (wrap) n = ((n % 360) + 360) % 360; return Math.max(lo, Math.min(hi, n)); };
function camFields(d, b) {
  if (b.fov !== undefined) d.fov = numOrNull(b.fov, 10, 180);
  if (b.rangeFt !== undefined) d.rangeFt = numOrNull(b.rangeFt, 10, 300);
  if (b.facing !== undefined) d.facing = numOrNull(b.facing, 0, 359.99, true);
}
/* a camera's lens width, reach and heading live on its map marker so the view cone can be drawn */
function applyCam(d, setFacing) {
  const pr = prop(d.propertyId), f = pr && pr.features.find((x) => x.id === d.featureId); if (!f) return;
  f.fov = d.fov || undefined; f.rangeM = d.rangeFt ? Math.round(d.rangeFt * 0.3048) : undefined;
  if (setFacing) f.facing = d.facing == null ? undefined : d.facing; else if (f.facing == null && d.facing != null) f.facing = d.facing;
  store.changed(pr.id, 'features');
}
function deployDevice(d, propId, coords) {
  const pr = prop(propId); if (!pr) return false;
  if (d.propertyId && d.propertyId !== propId) detachDevice(d);
  let f = pr.features.find((x) => x.id === d.featureId);
  if (f) f.coords = [coords];
  else { f = { id: uid('f'), type: 'camera', kind: 'point', name: d.name, coords: [coords], deviceId: d.id }; pr.features.push(f); }
  d.propertyId = propId; d.featureId = f.id; d.deployedAt = d.deployedAt || Date.now();
  store.changed(pr.id, 'features');
  applyCam(d, false);
  flushInbox(d);
  return true;
}

/* ---------- connectors: camera feeds that arrive from outside (MCP servers / JSON links) ---------- */
function camEvent(d, it) {
  const pr = prop(d.propertyId), f = pr && pr.features.find((x) => x.id === d.featureId);
  const e = Wild.build(pr, { ts: it.ts, species: it.species || 'other', method: 'camera', count: 1, note: [d.name, it.note].filter(Boolean).join(' · '), photo: it.photo || null, lat: f ? f.coords[0][0] : undefined, lng: f ? f.coords[0][1] : undefined }, uid, null);
  e.deviceId = d.id; e.extId = it.extId; pr.wildlife.push(e); store.changed(pr.id, 'wildlife');
}
function flushInbox(d) {
  const st = store.state, mine = st.inbox.filter((x) => x.deviceId === d.id);
  if (!mine.length || !prop(d.propertyId)) return;
  mine.forEach((it) => camEvent(d, it));
  st.inbox = st.inbox.filter((x) => x.deviceId !== d.id);
}
function ingest(c, items) {
  const st = store.state; let fresh = 0, newDev = 0;
  items.forEach((it) => {
    let d = st.devices.find((x) => x.sourceId === c.id && x.ext === it.cam);
    if (!d) { d = { id: uid('dev'), name: it.cam, brand: '', model: '', battery: null, notes: '', propertyId: null, featureId: null, deployedAt: null, addedAt: Date.now(), sourceId: c.id, ext: it.cam, seen: [] }; st.devices.push(d); newDev++; }
    if (it.battery != null) d.battery = Math.max(0, Math.min(100, it.battery));
    if (it.ts && it.ts > (d.lastEvent || 0)) d.lastEvent = it.ts;
    if (!it.ts || !it.species) return;
    d.seen = d.seen || [];
    if (d.seen.includes(it.extId)) return;
    d.seen.push(it.extId); if (d.seen.length > 400) d.seen.splice(0, d.seen.length - 400);
    fresh++;
    if (d.propertyId && prop(d.propertyId)) camEvent(d, it);
    else { st.inbox.push({ ...it, deviceId: d.id }); if (st.inbox.length > 600) st.inbox.shift(); }
  });
  return { fresh, newDev, total: items.length };
}
async function syncConnector(c) {
  try {
    const items = await Connectors.pull(c);
    const r = ingest(c, items); c.lastSync = Date.now(); c.lastError = null; c.lastCount = r.fresh;
    save(true); broadcast({ type: 'changed', what: 'devices' });
    return { ok: true, ...r };
  } catch (e) { c.lastSync = Date.now(); c.lastError = String(e.message || e).slice(0, 200); save(true); return { ok: false, error: c.lastError }; }
}
const pubConn = (c) => { const { token, ...rest } = c; return { ...rest, hasToken: !!token }; };
function updates(propId, limit) {
  const st = store.state, out = [];
  const add = (p, ts, kind, icon, text, extra) => ts && out.push({ ts, propertyId: p.id, property: p.name.trim(), kind, icon, text, ...(extra || {}) });
  const SPN = { deer: 'Deer', bear: 'Bear', turkey: 'Turkey', hog: 'Hog', elk: 'Elk', coyote: 'Coyote', wolf: 'Wolf', bobcat: 'Bobcat', cougar: 'Mountain lion', fox: 'Fox', human: 'Person / ATV', dog: 'Loose dog', raccoon: 'Raccoon', other: 'Animal' };
  st.properties.filter((p) => !propId || p.id === propId).forEach((p) => {
    (p.wildlife || []).forEach((e) => add(p, e.ts, e.method === 'camera' ? 'camera' : 'wildlife', e.method === 'camera' ? '\u{1F4F7}' : '\u{1F43E}', `${SPN[e.species] || 'Animal'}${e.count > 1 ? ' x' + e.count : ''} ${e.method === 'camera' ? 'on camera' : e.method === 'heard' ? 'heard' : e.method === 'seen' ? 'seen' : 'sign (' + e.method + ')'}${e.note ? ' \u00B7 ' + e.note : ''}`, { photo: e.photo && /^https?:|^\/uploads/.test(e.photo) ? e.photo : undefined }));
    (p.sightings || []).forEach((s) => add(p, s.ts, 'sighting', '\u{1F98C}', `${s.animal || 'Deer'} sighted${s.camName ? ' at ' + s.camName : ''}${s.behavior ? ' \u00B7 ' + s.behavior : ''}`));
    (p.notes || []).forEach((n) => add(p, n.ts, 'note', '\u{1F4DD}', n.text || ''));
    (p.walks || []).forEach((w) => add(p, w.ts || w.created, 'walk', '\u{1F97E}', `Scouting walk saved: ${w.name || 'walk'}`));
    (p.hunts || []).forEach((h) => add(p, h.endTs || h.startTs, 'hunt', '\u{1F3AF}', `Hunt logged${h.standName ? ' at ' + h.standName : ''}`));
    (p.pins || []).filter((x) => x.source !== 'user').forEach((x) => add(p, x.ts, 'ai', '\u{1F916}', x.title || x.text || 'AI note'));
  });
  st.devices.filter((d) => (!propId || d.propertyId === propId)).forEach((d) => {
    const p = st.properties.find((x) => x.id === d.propertyId) || { id: null, name: 'Unassigned' };
    if (d.battery != null && d.battery < 25) add(p, d.lastEvent || d.addedAt, 'device', '\u{1FAAB}', `${d.name} battery low (${d.battery}%)`);
  });
  if (!propId) st.connectors.forEach((c) => c.lastError && add({ id: null, name: 'Devices' }, c.lastSync, 'device', '\u26A0\uFE0F', `Connector "${c.name}" had a problem: ${c.lastError}`));
  if (!propId) { const waiting = st.inbox.length; if (waiting) add({ id: null, name: 'Devices' }, Math.max(...st.inbox.map((x) => x.ts || 0)), 'device', '\u{1F4E5}', `${waiting} camera photo${waiting > 1 ? 's' : ''} waiting for you to put their camera on a property`); }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit || 120);
}

/* ---------- all the cameras on a property, pieced together ---------- */
function cameraReport(pr) {
  const DAY = 86400000, since = Date.now() - 30 * DAY;
  const hourOf = (ts) => ((((ts + (Math.round(pr.center.lng / 15) * 3600 + (PH.isDST(ts) ? 3600 : 0)) * 1000) % DAY) + DAY) % DAY) / 3600000;
  const bucket = (h) => (h >= 21 || h < 5 ? 'night' : h < 9 ? 'dawn' : h < 16 ? 'midday' : 'dusk');
  const cams = {}, mk = () => ({ dawn: 0, midday: 0, dusk: 0, night: 0 }), bin = (h) => Math.round((((h % 360) + 360) % 360) / 45) % 8;
  const get = (name) => cams[name] || (cams[name] = { name, total: 0, deer: 0, species: {}, when: mk(), last: 0, battery: null, dirs: [0, 0, 0, 0, 0, 0, 0, 0] });
  pr.features.filter((f) => f.type === 'camera').forEach((f) => { const c = get(f.name); const d = store.state.devices.find((x) => x.id === f.deviceId); c.facing = f.facing == null ? null : f.facing; c.fov = f.fov || null; if (d) { c.battery = d.battery; c.deviceId = d.id; } });
  const add = (name, sp, ts, hd) => { const c = get(name); if (hd != null) c.dirs[bin(hd)]++; c.total++; c.species[sp] = (c.species[sp] || 0) + 1; if (sp === 'deer') { c.deer++; c.when[bucket(hourOf(ts))]++; } c.last = Math.max(c.last, ts); };
  (pr.wildlife || []).filter((e) => e.method === 'camera' && e.ts >= since).forEach((e) => { const d = store.state.devices.find((x) => x.id === e.deviceId); add(d ? d.name : 'Other camera', e.species, e.ts, e.travel); });
  (pr.sightings || []).filter((x) => x.ts >= since).forEach((x) => add(x.camName && x.camName !== 'Field sighting' ? x.camName : 'Logged by hand', 'deer', x.ts, x.heading));
  const list = Object.values(cams).sort((a, b) => b.deer - a.deer || b.total - a.total);
  const all = { total: 0, deer: 0, species: {}, when: mk() };
  list.forEach((c) => { all.total += c.total; all.deer += c.deer; Object.entries(c.species).forEach(([k, v]) => (all.species[k] = (all.species[k] || 0) + v)); Object.keys(c.when).forEach((k) => (all.when[k] += c.when[k])); });
  const CP = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const tips = [];
  list.forEach((c) => { const n = c.dirs.reduce((a, b) => a + b, 0); if (n >= 3) { const i = c.dirs.indexOf(Math.max(...c.dirs)); tips.push(`At ${c.name}, ${c.dirs[i]} of ${n} animals were heading ${CP[i]}. The trail there runs ${CP[i]} to ${CP[(i + 4) % 8]}. For a bow, sit 12 to 20 yards off it on a day when the wind blows from the trail toward you.`); } });
  const top = list[0];
  if (top && top.deer) { const pk = Object.entries(top.when).sort((a, b) => b[1] - a[1])[0]; tips.push(`${top.name} is your hottest camera: ${top.deer} deer in 30 days, mostly at ${pk[0]}. For a bow, set up within 20 yards of that spot and hunt the ${pk[0]} window.`); }
  if (all.deer >= 5) { const pk = Object.entries(all.when).sort((a, b) => b[1] - a[1])[0]; tips.push(`Across every camera, deer move most at ${pk[0]} (${Math.round(pk[1] / all.deer * 100)}% of ${all.deer}).`); }
  const dead = list.filter((c) => c.total === 0 && c.name !== 'Logged by hand'); if (dead.length) tips.push(`No pictures in 30 days from ${dead.map((c) => c.name).join(', ')}. Consider moving ${dead.length > 1 ? 'them' : 'it'} onto a trail.`);
  const low = list.filter((c) => c.battery != null && c.battery < 25); if (low.length) tips.push(`Low battery: ${low.map((c) => c.name + ' (' + c.battery + '%)').join(', ')}.`);
  if (!list.length) tips.push('No cameras on this property yet.');
  return { days: 30, cameras: list, all, tips };
}
const predCache = new Map();
/* the home cards cost a few seconds (weather + hunt plan), so each is remembered for 10 minutes and rebuilt only when the property changes */
const homeCache = new Map();
async function homeSummary(p) {
  const key = JSON.stringify([p.name, p.features.length, p.sightings.length, p.pins.length, (p.wildlife || []).length, p.parcel && p.parcel.acres]);
  const hit = homeCache.get(p.id);
  if (hit && hit.key === key) {
    if (Date.now() - hit.t > 600000 && !hit.busy) { hit.busy = true; Home.summary(p).then((out) => { if (out.weather) homeCache.set(p.id, { key, t: Date.now(), out }); }).catch(() => {}).finally(() => { hit.busy = false; }); } // show the old card now, refresh behind it
    return hit.out;
  }
  const out = await Home.summary(p).catch(() => ({ id: p.id, name: p.name, center: p.center, notifications: [], counts: {} }));
  if (out.weather) homeCache.set(p.id, { key, t: Date.now(), out });
  return out;
}

const terrainJobs = new Set();
const publicProp = (p) => { const { elevation, _an, _ctxBusy, ...rest } = p; return { ...rest, elevationSource: elevation ? elevation.source : null, terrain: { water: !!p.waterAt && p.waterV === 2, surroundings: !!p.context, loading: terrainJobs.has(p.id) } }; };
/* Water (ponds, wetlands, streams) and the land around a property load on their own, retrying while OpenStreetMap is busy. */
function ensureTerrain(pr, force) {
  if (force) { pr.waterAt = null; pr.context = null; }
  const ctxOk = () => pr.context && pr.context.v === 2, wOk = () => pr.waterAt && pr.waterV === 2;
  if (terrainJobs.has(pr.id) || (wOk() && ctxOk())) return;
  terrainJobs.add(pr.id);
  (async () => {
    for (let attempt = 0; attempt < 6 && (!wOk() || !ctxOk()); attempt++) {
      try { if (!wOk()) { await Home.importWater(pr, uid); pr.waterAt = Date.now(); store.changed(pr.id, 'features'); } } catch (e) { console.warn('[water]', e.message); }
      try { if (!ctxOk()) { await Home.importContext(pr); store.changed(pr.id, 'context'); } } catch (e) { console.warn('[surroundings]', e.message); }
      if (!wOk() || !ctxOk()) await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)));
    }
    terrainJobs.delete(pr.id); store.changed(pr.id, 'terrain'); save();
  })();
}

/* ---------- helpers ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const send = (res, code, body, headers = {}) => {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'content-type': isObj ? 'application/json' : 'text/plain', 'cache-control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};
const readBody = (req, limit = 10e6) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
  req.on('error', reject);
});
const isLocalHost = (h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h || '');
const allowedHost = (h) => isLocalHost(h) || process.env.ALLOW_HOST === (h || '');
const allowedOrigin = (o) => !o || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o) || (!!process.env.ALLOW_HOST && o === 'https://' + process.env.ALLOW_HOST);
/* Which property a spot belongs to: inside a boundary, else nearest center within 3 km. */
function propAt(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  let best = null, bd = 3000;
  for (const p of store.state.properties) {
    if (p.features.some((f) => f.type === 'boundary' && PH.pointInPoly([lat, lng], f.coords))) return p;
    const d = PH.distM([lat, lng], [p.center.lat, p.center.lng]);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
/* Give every un-located entry the spot of the nearest map screenshot/pin, then file everything under its property. */
function fillLocations() {
  const n = Scout.autolocate();
  Scout.list().forEach((e) => { const pr = !e.propertyId && propAt(e.lat, e.lng); if (pr) Scout.update(e.id, { propertyId: pr.id }); });
  return n;
}
/* Over the public tunnel only the Scout Log is reachable, and only with Telegram-signed credentials. */
function tunnelGate(req, url) {
  const p = url.pathname;
  if (p === '/scout.html') return true;
  if (p.startsWith('/uploads/')) return url.searchParams.get('k') === Scout.fileKey() && !!Scout.fileKey();
  if (p === '/api/scout' || p.startsWith('/api/scout/')) return Scout.authOk(req.headers['x-tg-init']);
  return false;
}

/* ---------- MCP ---------- */
const { impl: mcpImpl } = S.makeTools(store);
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
async function mcpHandle(msg, clientId) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined) return null; // notification
  try {
    switch (method) {
      case 'initialize': {
        const v = PROTOCOLS.includes(params && params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
        const c = store.mcp.clients.get(clientId) || {};
        store.mcp.clients.set(clientId, { ...c, name: params && params.clientInfo ? params.clientInfo.name : 'client', seen: Date.now() });
        broadcast({ type: 'mcp' });
        return reply({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'cabinscout', version: '1.0.0' },
          instructions: 'CabinScout: whitetail intel. Read map, sightings and live thermals, then call place_tactical_target_pin to drop a Red Target Pin on the hunter\'s board.' });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: S.TOOLS });
      case 'resources/list': return reply({ resources: [] });
      case 'prompts/list': return reply({ prompts: [] });
      case 'tools/call': {
        const name = params && params.name;
        if (!mcpImpl[name]) return fail(-32602, 'Unknown tool: ' + name);
        store.mcp.calls++; store.mcp.lastCall = { tool: name, ts: Date.now() };
        broadcast({ type: 'mcp', tool: name });
        try {
          const out = await mcpImpl[name]((params && params.arguments) || {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
        } catch (e) { return reply({ isError: true, content: [{ type: 'text', text: 'Error: ' + e.message }] }); }
      }
      default: return fail(-32601, 'Method not found: ' + method);
    }
  } catch (e) { return fail(-32603, e.message); }
}
function mcpAuth(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : new URL(req.url, 'http://x').searchParams.get('token');
  const a = Buffer.from(t || ''), b = Buffer.from(store.state.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const legacySessions = new Map();
async function mcpRoute(req, res, url) {
  if (!store.state.mcpEnabled) return send(res, 503, { error: 'MCP uplink disabled in the app' });
  if (!mcpAuth(req)) return send(res, 401, { error: 'Missing or invalid bearer token' }, { 'www-authenticate': 'Bearer' });
  if (req.method === 'GET' && url.pathname !== '/api/mcp/message') { // legacy HTTP+SSE transport
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const sid = crypto.randomBytes(8).toString('hex');
    legacySessions.set(sid, res);
    res.write(`event: endpoint\ndata: /api/mcp/message?sessionId=${sid}\n\n`);
    const ka = setInterval(() => res.write(': ka\n\n'), 20000);
    req.on('close', () => { clearInterval(ka); legacySessions.delete(sid); store.mcp.clients.delete(sid); broadcast({ type: 'mcp' }); });
    return;
  }
  if (req.method === 'DELETE') return send(res, 200, {});
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const body = await readBody(req);
  const sid = url.searchParams.get('sessionId');
  const clientId = sid || req.headers['mcp-session-id'] || 'http-' + (req.socket.remotePort || 0);
  const msgs = Array.isArray(body) ? body : [body];
  const outs = (await Promise.all(msgs.map((m) => mcpHandle(m, clientId)))).filter(Boolean);
  if (sid && legacySessions.has(sid)) {
    outs.forEach((o) => legacySessions.get(sid).write('event: message\ndata: ' + JSON.stringify(o) + '\n\n'));
    return send(res, 202, 'Accepted');
  }
  if (!outs.length) return send(res, 202, '');
  return send(res, 200, Array.isArray(body) ? outs : outs[0]);
}

/* ---------- REST ---------- */
async function api(req, res, url) {
  const p = url.pathname, m = req.method, seg = p.split('/').filter(Boolean).slice(1); // after "api"
  if (seg[0] === 'mcp') return mcpRoute(req, res, url);
  if (!allowedOrigin(req.headers.origin)) return send(res, 403, { error: 'Bad origin' });

  if (seg[0] === 'events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('data: {"type":"hello"}\n\n');
    store.sse.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 20000);
    req.on('close', () => { clearInterval(ka); store.sse.delete(res); });
    return;
  }

  if (seg[0] === 'setup') {
    const KEYS = { anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_MAPS_API_KEY', regrid: 'REGRID_TOKEN', telegram: 'TELEGRAM_BOT_TOKEN' };
    if (m === 'GET') return send(res, 200, { done: !!store.state.setupDone, properties: store.state.properties.length, keys: Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, !!process.env[v]])), scout: Scout.getSettings() });
    if (m === 'POST') {
      const b = await readBody(req);
      let restart = false;
      const keys = b.keys || {}, env = {};
      Object.entries(KEYS).forEach(([k, v]) => { const val = String(keys[k] || '').trim(); if (val && /^[\w:.\-]{8,200}$/.test(val)) { env[v] = val; if (k === 'telegram' && val !== process.env[v]) restart = true; process.env[v] = val; } });
      if (Object.keys(env).length) {
        let cur = ''; try { cur = fs.readFileSync(ENV_FILE, 'utf8'); } catch (e) { /* new file */ }
        Object.entries(env).forEach(([k, v]) => { cur = new RegExp('^' + k + '=', 'm').test(cur) ? cur.replace(new RegExp('^' + k + '=.*$', 'm'), k + '=' + v) : cur.replace(/\s*$/, '\n') + k + '=' + v + '\n'; });
        fs.writeFileSync(ENV_FILE, cur.replace(/^\n+/, ''));
      }
      if (b.scout && typeof b.scout === 'object') Scout.setSettings(b.scout);
      if (b.demo && !store.state.properties.some((p) => p.id === 'demo')) { store.state.properties.push(Seed.build()); if (!store.state.activeProperty) store.state.activeProperty = 'demo'; }
      store.state.setupDone = true; save(true);
      return send(res, 200, { ok: true, restart });
    }
  }
  if (seg[0] === 'config' && m === 'GET') {
    const origin = `http://${req.headers.host}`;
    return send(res, 200, { googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '', hasClaude: !!process.env.ANTHROPIC_API_KEY,
      mcp: { url: origin + '/api/mcp', token: store.state.token, enabled: store.state.mcpEnabled, clients: [...store.mcp.clients.values()].map((c) => c.name), calls: store.mcp.calls, lastCall: store.mcp.lastCall, tools: S.TOOLS.map((t) => t.name) } });
  }
  if (seg[0] === 'mcp-toggle' && m === 'POST') {
    const b = await readBody(req); store.state.mcpEnabled = !!b.enabled; save(); broadcast({ type: 'mcp' });
    return send(res, 200, { enabled: store.state.mcpEnabled });
  }
  if (seg[0] === 'state' && m === 'GET') return send(res, 200, { activeProperty: store.state.activeProperty, properties: store.state.properties.map(publicProp) });
  if (seg[0] === 'active' && m === 'POST') {
    const b = await readBody(req); if (!prop(b.id)) return send(res, 404, { error: 'No such property' });
    store.state.activeProperty = b.id; save(); return send(res, 200, { ok: true });
  }
  if (seg[0] === 'camera-models' && m === 'GET') return send(res, 200, { models: Cams.MODELS });
  if (seg[0] === 'updates' && m === 'GET') return send(res, 200, { updates: updates(url.searchParams.get('property') || null, Number(url.searchParams.get('limit')) || 120), inbox: store.state.inbox.length });
  if (seg[0] === 'connectors') {
    const cs = store.state.connectors, str = (v, n) => String(v == null ? '' : v).slice(0, n);
    if (seg.length === 1 && m === 'GET') return send(res, 200, { connectors: cs.map(pubConn) });
    if (seg.length === 1 && m === 'POST') {
      const b = await readBody(req);
      if (!/^https?:\/\//i.test(str(b.url, 400).trim())) return send(res, 400, { error: 'The address must start with http:// or https://' });
      const c = { id: uid('cn'), name: str(b.name || 'My camera service', 60), kind: b.kind === 'json' ? 'json' : 'mcp', url: str(b.url, 400).trim(), token: str(b.token, 400).trim(), tool: str(b.tool, 80), args: str(b.args, 400), addedAt: Date.now() };
      cs.push(c); save(true); return send(res, 200, pubConn(c));
    }
    const c = cs.find((x) => x.id === seg[1]); if (!c) return send(res, 404, { error: 'No such connector' });
    if (m === 'DELETE') { cs.splice(cs.indexOf(c), 1); save(true); return send(res, 200, { ok: true }); }
    if (seg[2] === 'discover' && m === 'POST') { try { return send(res, 200, await Connectors.discover(c)); } catch (e) { return send(res, 200, { error: String(e.message || e) }); } }
    if (seg[2] === 'sync' && m === 'POST') return send(res, 200, await syncConnector(c));
    if (m === 'PUT') {
      const b = await readBody(req);
      ['name', 'tool', 'args'].forEach((k) => b[k] !== undefined && (c[k] = str(b[k], k === 'name' ? 60 : 400)));
      if (b.url && /^https?:\/\//i.test(b.url)) c.url = str(b.url, 400).trim();
      if (b.token) c.token = str(b.token, 400).trim();
      if (b.kind) c.kind = b.kind === 'json' ? 'json' : 'mcp';
      save(true); return send(res, 200, pubConn(c));
    }
  }
  if (seg[0] === 'devices') {
    const devs = store.state.devices;
    const str = (v, n) => String(v == null ? '' : v).slice(0, n);
    if (seg.length === 1 && m === 'GET') return send(res, 200, { devices: devs.map(({ seen, ...r }) => r), inbox: store.state.inbox.length });
    if (seg.length === 1 && m === 'POST') {
      const b = await readBody(req);
      const d = { id: uid('dev'), name: str(b.name || 'Trail Cam', 60), brand: str(b.brand, 40), model: str(b.model, 40), battery: null, notes: str(b.notes, 300), propertyId: null, featureId: null, deployedAt: null, addedAt: Date.now() };
      camFields(d, b); devs.push(d); save(true); return send(res, 200, d);
    }
    const d = devs.find((x) => x.id === seg[1]);
    if (!d) return send(res, 404, { error: 'No such device' });
    if (m === 'DELETE') { detachDevice(d); store.state.inbox = store.state.inbox.filter((x) => x.deviceId !== d.id); devs.splice(devs.indexOf(d), 1); save(true); return send(res, 200, { ok: true }); }
    if (m === 'PUT') {
      const b = await readBody(req);
      ['name', 'brand', 'model', 'notes'].forEach((k) => b[k] !== undefined && (d[k] = str(b[k], k === 'notes' ? 300 : 60)));
      if (b.battery !== undefined) d.battery = b.battery === null || b.battery === '' ? null : Math.max(0, Math.min(100, Number(b.battery) || 0));
      if (b.lastChecked !== undefined) d.lastChecked = b.lastChecked ? Number(b.lastChecked) : null;
      camFields(d, b);
      if (b.pull) detachDevice(d);
      else if (b.propertyId && typeof b.lat === 'number' && typeof b.lng === 'number') { if (!deployDevice(d, b.propertyId, [b.lat, b.lng])) return send(res, 404, { error: 'No such property' }); }
      else if (b.propertyId && b.propertyId !== d.propertyId) { const tp = prop(b.propertyId); if (!tp) return send(res, 404, { error: 'No such property' }); const n = tp.features.filter((x) => x.type === 'camera').length; deployDevice(d, b.propertyId, [tp.center.lat + 0.00015 * (n % 5), tp.center.lng + 0.00015 * Math.floor(n / 5)]); }
      if (!b.pull && (b.fov !== undefined || b.rangeFt !== undefined || b.facing !== undefined)) applyCam(d, b.facing !== undefined);
      const pr = prop(d.propertyId), f = pr && pr.features.find((x) => x.id === d.featureId);
      if (f && b.name !== undefined) { f.name = d.name; store.changed(pr.id, 'features'); }
      save(true); return send(res, 200, d);
    }
  }
  if (seg[0] === 'field' && seg[1] === 'import' && m === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.items)) return send(res, 400, { error: 'Not a CabinScout field export (no items list)' });
    const r = FieldImport.importField(store, { uid, deployDevice }, b.items, b.propertyId);
    save(true); return send(res, 200, r);
  }
  if (seg[0] === 'parcel' && m === 'GET') {
    const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
    if (!isFinite(lat) || !isFinite(lng)) return send(res, 400, { error: 'lat/lng required' });
    return send(res, 200, await S.parcelAt(lat, lng));
  }
  if (seg[0] === 'home' && m === 'GET') {
    const lite = url.searchParams.get('lite') === '1';
    const props = lite ? await Promise.all(store.state.properties.map((p) => Home.summary(p, true))) : await Promise.all(store.state.properties.map((p) => homeSummary(p)));
    save();
    return send(res, 200, { activeProperty: store.state.activeProperty, properties: props, hasRegrid: !!process.env.REGRID_TOKEN });
  }
  if (seg[0] === 'neighbors' && m === 'GET') {
    const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng')), token = process.env.REGRID_TOKEN;
    const bb = (url.searchParams.get('bbox') || '').split(',').map(Number);
    if (bb.length === 4 && bb.every(isFinite) && S.inMass((bb[1] + bb[3]) / 2, (bb[0] + bb[2]) / 2)) {
      try { const ps = await S.massBox(bb[0], bb[1], bb[2], bb[3]); if (ps.length) return send(res, 200, { parcels: ps, source: 'massgis' }); } catch (e) { console.warn('[massgis]', e.message); }
    }
    if (!token || !isFinite(lat) || !isFinite(lng)) return send(res, 200, { parcels: [] });
    try {
      const r = await fetch(`https://app.regrid.com/api/v2/parcels/point?lat=${lat}&lon=${lng}&radius=${Math.min(1500, Number(url.searchParams.get('radius')) || 600)}&limit=60&return_geometry=true&token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      const out = ((j.parcels || {}).features || []).filter((f) => f.geometry).map((f) => {
        const fl = (f.properties && f.properties.fields) || {}, g = f.geometry, ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
        return ring && { parcelId: fl.parcelnumb || fl.ll_uuid || '', owner: fl.owner || '', address: fl.address || '', acres: fl.ll_gisacre || null, coords: ring.map(([x, y]) => [y, x]) };
      }).filter(Boolean);
      return send(res, 200, { parcels: out });
    } catch (e) { return send(res, 200, { parcels: [], error: e.message }); }
  }
  if (seg[0] === 'weather') {
    const pr = prop(url.searchParams.get('propertyId')) || prop(store.state.activeProperty);
    return send(res, 200, await S.getWeather(pr));
  }
  if (seg[0] === 'scout') {
    if (m === 'GET' && seg[1] === 'settings') return send(res, 200, Scout.getSettings());
    if (m === 'POST' && seg[1] === 'settings') return send(res, 200, Scout.setSettings(await readBody(req)));
    const hourOf = (p, ts) => ((ts + (Math.round(p.center.lng / 15) * 3600 + (PH.isDST(ts) ? 3600 : 0)) * 1000) % 86400000) / 3600000;
    if (m === 'GET' && seg[1] === 'day') { // sunrise / sunset for the property, for legal shooting light
      const pr = prop(url.searchParams.get('propertyId')) || prop(store.state.activeProperty) || store.state.properties[0];
      if (!pr) return send(res, 404, { error: 'No property' });
      const off = (Math.round(pr.center.lng / 15) * 3600 + (PH.isDST(Date.now()) ? 3600 : 0)) * 1000, DAY = 86400000;
      const dayStart = Math.floor((Date.now() + off) / DAY) * DAY - off, t = PH.sunTimes(pr.center.lat, pr.center.lng, dayStart);
      return send(res, 200, { sunrise: t.sunrise, sunset: t.sunset, firstLight: t.sunrise - 30 * 60000, lastLight: t.sunset + 30 * 60000, propertyName: pr.name });
    }
    if (m === 'GET' && seg[1] === 'insights') { // every logged animal and camera hit, with the weather and moon at the time
      const pid = url.searchParams.get('propertyId'), props = store.state.properties.filter((p) => !pid || p.id === pid);
      const events = [], stands = [];
      props.forEach((p) => {
        (p.wildlife || []).forEach((e) => events.push({ propertyId: p.id, species: e.species, method: e.method, count: e.count || 1, ts: e.ts, lat: e.lat, lng: e.lng, hour: hourOf(p, e.ts), wx: e.wx || null, moon: e.moon || null, src: 'wildlife' }));
        (p.sightings || []).forEach((x) => events.push({ propertyId: p.id, species: 'deer', method: x.camName === 'Field sighting' ? 'seen' : 'camera', count: 1, ts: x.ts, lat: x.lat, lng: x.lng, hour: hourOf(p, x.ts), wx: x.wx || null, moon: (() => { const mp = PH.moonPhase(x.ts); return { name: mp.name, illum: mp.illum }; })(), src: 'sighting' }));
        p.features.filter((f) => f.type === 'stand' && f.coords && f.coords[0]).forEach((f) => stands.push({ propertyId: p.id, name: f.name, lat: f.coords[0][0], lng: f.coords[0][1] }));
      });
      return send(res, 200, { events, stands });
    }
    if (m === 'POST' && seg[1] === 'buck') { // name a buck so photos and videos can be tagged to him
      const b = await readBody(req), pr = prop(b.propertyId) || prop(store.state.activeProperty);
      if (!pr || !String(b.name || '').trim()) return send(res, 400, { error: 'Pick a property and give him a name' });
      const palette = ['#EF4444', '#F59E0B', '#22C55E', '#3B82F6', '#A855F7', '#EC4899', '#14B8A6', '#94A3B8'];
      pr.bucks = pr.bucks || [];
      const buck = { id: uid('b'), name: String(b.name).trim().slice(0, 40), color: palette[pr.bucks.length % palette.length], desc: '' };
      pr.bucks.push(buck); store.changed(pr.id, 'bucks'); return send(res, 200, buck);
    }
    if (m === 'POST' && seg[1] === 'shot') { // bow shot report, with the blood trail marked afterward
      const b = await readBody(req);
      if (b.action === 'point') { const e = Scout.addPoint(String(b.id || ''), b); return e ? send(res, 200, e) : send(res, 404, { error: 'No such shot' }); }
      if (b.action === 'result') { const e = Scout.update(String(b.id || ''), { result: String(b.result || '') }); return e ? send(res, 200, e) : send(res, 404, { error: 'No such shot' }); }
      const pr = prop(b.propertyId) || propAt(b.lat, b.lng) || prop(store.state.activeProperty);
      let aLat, aLng;
      if (typeof b.lat === 'number' && typeof b.lng === 'number' && isFinite(b.dir) && isFinite(b.distYd)) { // where the animal was: that far, that way from you
        const d = Number(b.distYd) * 0.9144, r = Number(b.dir) * Math.PI / 180;
        aLat = b.lat + d * Math.cos(r) / 111200; aLng = b.lng + d * Math.sin(r) / (111320 * Math.cos(b.lat * Math.PI / 180));
      }
      return send(res, 200, Scout.add({ kind: 'shot', propertyId: pr && pr.id, huntId: b.huntId ? String(b.huntId) : undefined, species: String(b.species || 'deer').slice(0, 20), distYd: isFinite(b.distYd) && b.distYd !== '' ? Number(b.distYd) : undefined,
        dir: isFinite(b.dir) && b.dir !== '' ? Number(b.dir) : undefined, hit: String(b.hit || '').slice(0, 20), result: String(b.result || 'unknown').slice(0, 20), lat: b.lat, lng: b.lng, aLat, aLng, caption: String(b.note || '').slice(0, 400), ts: Number(b.ts) || undefined }));
    }
    if (m === 'GET' && seg[1] === 'plans') { // scouting walks planned in CabinScout
      return send(res, 200, { plans: store.state.properties.flatMap((p) => (p.walks || []).map((w) => ({ propertyId: p.id, propertyName: p.name, id: w.id, name: w.name, distM: w.distM, minutes: w.minutes, start: w.start,
        pts: (w.pts || []).filter((_, i, a) => i % 3 === 0 || i === a.length - 1), stops: (w.points || []).map((q) => ({ lat: q.coords && q.coords[0], lng: q.coords && q.coords[1], note: q.note })) }))) });
    }
    if (m === 'GET' && seg[1] === 'insight') { // what the Scout Log says about a property
      const pr = prop(url.searchParams.get('propertyId')) || prop(store.state.activeProperty);
      return pr ? send(res, 200, ScoutAI.analyze(pr, Scout.list())) : send(res, 404, { error: 'No property' });
    }
    if (m === 'GET' && seg[1] === 'track') return send(res, 200, { pts: Scout.getTrack(seg[2]) });
    if (m === 'GET') return send(res, 200, { entries: Scout.list(), k: Scout.fileKey(), properties: store.state.properties.map((p) => ({ id: p.id, name: p.name, center: p.center, bucks: (p.bucks || []).map((b) => ({ id: b.id, name: b.name, color: b.color })), houses: p.features.filter((f) => f.type === 'house' && f.coords && f.coords[0]).map((f) => f.coords[0]), boundaries: p.features.filter((f) => f.type === 'boundary' && f.coords).map((f) => f.coords), boundary: ((p.features.find((f) => f.type === 'boundary') || {}).coords) || null, stands: p.features.filter((f) => f.type === 'stand' && f.coords && f.coords[0]).map((f) => ({ name: f.name, lat: f.coords[0][0], lng: f.coords[0][1] })) })), activeProperty: store.state.activeProperty, ...Scout.status() });
    if (m === 'DELETE') return send(res, 200, { ok: Scout.remove(seg[1]) });
    if (m === 'POST' && seg[1] === 'autolocate') {
      return send(res, 200, { located: fillLocations() });
    }
    if (m === 'POST' && seg[1] === 'spot') { // a spot picked on the map
      const b = await readBody(req);
      if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return send(res, 400, { error: 'Need a location' });
      const pr = prop(b.propertyId) || propAt(b.lat, b.lng);
      return send(res, 200, Scout.add({ kind: 'location', tag: 'location', source: 'map', propertyId: pr && pr.id, lat: b.lat, lng: b.lng, caption: String(b.name || '').slice(0, 80) }));
    }
    if (m === 'POST' && seg[1] === 'hunt') { // start or end a hunt session
      const b = await readBody(req);
      if (b.action === 'track') return send(res, 200, { n: Scout.addTrack(String(b.id || ''), Array.isArray(b.pts) ? b.pts.slice(0, 500) : []) });
      if (b.action === 'arrive') { const e = Scout.update(String(b.id || ''), { arriveTs: Number(b.ts) || Date.now(), arriveLat: b.lat, arriveLng: b.lng, stand: typeof b.stand === 'string' ? b.stand : undefined }); return e ? send(res, 200, e) : send(res, 404, { error: 'No such hunt' }); }
      if (b.action === 'end') { const e = Scout.update(String(b.id || ''), { endTs: Number(b.ts) || Date.now(), open: false, caption: String(b.note || '').slice(0, 1000) }); return e ? send(res, 200, e) : send(res, 404, { error: 'No such hunt' }); }
      const pr = prop(b.propertyId) || propAt(b.lat, b.lng) || prop(store.state.activeProperty);
      return send(res, 200, Scout.add({ kind: 'hunt', open: true, wx: pr ? await currentWx(pr) : null, propertyId: pr && pr.id, stand: String(b.stand || '').slice(0, 80), lat: b.lat, lng: b.lng, caption: '' }));
    }
    if (m === 'POST' && seg[1] === 'sighting') { // "I see something": lands on the property's wildlife log and in the Scout Log
      const b = await readBody(req), pr = prop(b.propertyId) || propAt(b.lat, b.lng) || prop(store.state.activeProperty);
      if (!pr) return send(res, 400, { error: 'Pick a property' });
      const e = Wild.build(pr, { ts: Number(b.ts) || undefined, species: b.species, method: b.method, travel: b.travel, heading: b.heading, count: b.count, note: b.note, ...(typeof b.lat === 'number' && typeof b.lng === 'number' ? { lat: b.lat, lng: b.lng } : {}) }, uid, await currentWx(pr));
      if (e.species === 'deer' && e.method === 'seen' && e.lat != null && e.place !== 'direction') { // a deer you saw is a deer sighting: feeds the sightings layer and stand logic
        let bk = pr.bucks.find((x) => x.id === 'unk_field'); if (!bk) { bk = { id: 'unk_field', name: 'Unidentified deer (field)', color: '#94A3B8', desc: 'Sighted in person, not on camera.' }; pr.bucks.push(bk); }
        pr.sightings.push({ id: uid('s'), num: pr.sightings.reduce((a, s) => Math.max(a, s.num || 0), 0) + 1, animalId: bk.id, animal: bk.name, ts: e.ts, featureId: null, camName: 'Field sighting', lat: e.lat, lng: e.lng, behavior: 'Cruising', heading: e.travel != null ? e.travel : null, note: [e.count > 1 ? e.count + ' deer' : '', b.note ? String(b.note).slice(0, 300) : ''].filter(Boolean).join(', '), photo: null, wx: e.wx || null });
        store.changed(pr.id, 'sightings');
      } else { pr.wildlife.push(e); store.changed(pr.id, 'wildlife'); }
      return send(res, 200, Scout.add({ kind: 'note', ts: e.ts, propertyId: pr.id, species: e.species, count: e.count, method: e.method, huntId: b.huntId ? String(b.huntId) : undefined, lat: b.lat, lng: b.lng, caption: `${({ seen: 'Saw', heard: 'Heard', tracks: 'Tracks:', scat: 'Scat:', damage: 'Damage:' }[e.method] || 'Saw')} ${e.count > 1 ? e.count + ' ' : ''}${e.species}${b.note ? ': ' + String(b.note).slice(0, 300) : ''}` }));
    }
    if (m === 'PATCH') { const b = await readBody(req); const e = Scout.update(seg[1], b); if (e && b.lat != null) fillLocations(); return e ? send(res, 200, e) : send(res, 404, { error: 'Not found' }); }
    if (m === 'POST' && seg[1] === 'note') { const b = await readBody(req); return send(res, 200, Scout.add({ kind: 'note', propertyId: prop(b.propertyId) ? b.propertyId : (propAt(b.lat, b.lng) || {}).id, sign: b.sign ? String(b.sign).slice(0, 20) : undefined, ts: Number(b.ts) || undefined, caption: String(b.caption || '').slice(0, 1000), lat: b.lat, lng: b.lng })); }
    if (m === 'POST') { // raw file body, details in headers, so big videos stream straight to disk
      const type = req.headers['content-type'] || '', num = (h) => (req.headers[h] ? Number(req.headers[h]) : undefined);
      if (!/^(image|video)\//.test(type)) return send(res, 400, { error: 'Send an image or video' });
      const fp = String(req.headers['x-fp'] || '').slice(0, 200), dup = Scout.findFp(fp);
      if (dup) { req.resume(); return send(res, 200, { ...dup, duplicate: true }); }
      const file = await Scout.saveStream(req, type, decodeURIComponent(req.headers['x-filename'] || ''));
      const from = String(req.headers['x-from'] || '');
      const saved = Scout.add({ fp: fp || undefined, locFrom: from || undefined, pin: from ? true : undefined, huntId: req.headers['x-hunt'] ? String(req.headers['x-hunt']) : undefined, buckId: req.headers['x-buck'] ? String(req.headers['x-buck']) : undefined, propertyId: prop(req.headers['x-prop']) ? req.headers['x-prop'] : (propAt(num('x-lat'), num('x-lng')) || {}).id, tag: req.headers['x-tag'] === 'location' && type.startsWith('image') ? 'location' : undefined, kind: type.startsWith('video') ? 'video' : 'photo', file, lat: num('x-lat'), lng: num('x-lng'), caption: decodeURIComponent(req.headers['x-caption'] || '').slice(0, 1000), ts: num('x-ts') || Date.now() });
      fillLocations();
      return send(res, 200, Scout.list().find((x) => x.id === saved.id) || saved);
    }
  }
  if (seg[0] === 'upload' && m === 'POST') {
    const b = await readBody(req);
    const mm = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(b.dataUrl || '');
    if (!mm) return send(res, 400, { error: 'Expected an image data URL' });
    const name = uid('img') + '.' + (mm[1] === 'png' ? 'png' : mm[1] === 'webp' ? 'webp' : 'jpg');
    fs.writeFileSync(path.join(UP_DIR, name), Buffer.from(mm[2], 'base64'));
    return send(res, 200, { url: '/uploads/' + name });
  }
  if (seg[0] === 'chat' && m === 'POST') {
    const b = await readBody(req);
    if (!b.message) return send(res, 400, { error: 'message required' });
    return send(res, 200, await S.chat(store, b));
  }

  if (seg[0] === 'properties') {
    if (m === 'POST' && seg.length === 1) {
      const b = await readBody(req);
      if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return send(res, 400, { error: 'lat/lng required' });
      const np = { id: uid('prop'), name: String(b.name || 'New Property').slice(0, 80), address: String(b.address || ''), center: { lat: b.lat, lng: b.lng }, zoom: 17,
        terrainKind: 'rolling', elevationMode: 'live', features: [], sightings: [], bucks: [], pins: [], notes: [], wildlife: [], hunts: [], targets: ['deer'] };
      const parcels = Array.isArray(b.parcels) ? b.parcels : (Array.isArray(b.boundary) ? [{ boundary: b.boundary, parcelId: b.parcelId, owner: b.owner, acres: b.acres, source: b.source, address: b.address }] : []);
      addParcels(np, parcels, String(b.permission || 'owner'));
      if (!np.parcel) np.parcel = { id: '', owner: '', acres: null, source: 'manual', permission: String(b.permission || 'owner') };
      if (!np.address) np.address = await S.reverseGeocode(np.center.lat, np.center.lng);
      np.place = await S.placeInfo(np.center.lat, np.center.lng);
      store.state.properties.push(np);
      ensureTerrain(np); store.state.activeProperty = np.id; save(true);
      return send(res, 200, publicProp(np));
    }
    const pr = prop(seg[1]);
    if (!pr) return send(res, 404, { error: 'No such property' });
    const sub = seg[2], sid = seg[3];
    if (!sub) {
      if (m === 'DELETE') {
        store.state.devices.forEach((d) => { if (d.propertyId === pr.id) { d.propertyId = null; d.featureId = null; d.deployedAt = null; } }); // cameras go back to storage
        store.state.properties = store.state.properties.filter((x) => x !== pr);
        if (store.state.activeProperty === pr.id) store.state.activeProperty = store.state.properties[0] ? store.state.properties[0].id : null;
        save(true); return send(res, 200, { ok: true });
      }
      if (m === 'PUT') { const b = await readBody(req); if (Array.isArray(b.targets)) { const t = b.targets.filter((x) => Wild.SPECIES[x]); pr.targets = t.length ? t : ['deer']; } ['name', 'address'].forEach((k) => b[k] !== undefined && (pr[k] = String(b[k]).slice(0, 120))); store.changed(pr.id, 'property'); return send(res, 200, publicProp(pr)); }
    }
    if (sub === 'parcels' && m === 'POST') {
      const b = await readBody(req), n = addParcels(pr, b.parcels, b.permission);
      if (!n) return send(res, 400, { error: 'Nothing new to add (those parcels are already part of this property)' });
      pr.address = pr.address || await S.reverseGeocode(pr.center.lat, pr.center.lng);
      ensureTerrain(pr, true);
      store.changed(pr.id, 'features'); save(true); return send(res, 200, publicProp(pr));
    }
    if (sub === 'wildlife-intel' && m === 'GET') return send(res, 200, { intel: Wild.intel(pr), events: pr.wildlife, targets: pr.targets });
    if (sub === 'export' && m === 'GET') {
      const { elevation, _an, ...rest } = pr;
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${pr.name.replace(/[^\w.-]+/g, '_')}-data.json"` });
      return res.end(JSON.stringify({ exportedAt: new Date().toISOString(), property: rest, wildlifeIntel: Wild.intel(pr), devices: store.state.devices.filter((d) => d.propertyId === pr.id) }, null, 2));
    }
    if (sub === 'wildlife' && m === 'POST') {
      const e = Wild.build(pr, await readBody(req), uid, await currentWx(pr)); pr.wildlife.push(e); store.changed(pr.id, 'wildlife'); return send(res, 200, e);
    }
    if (sub === 'terrain' && m === 'POST') {
      try { const r = await Home.importWater(pr, uid); pr.waterAt = Date.now(); r.context = await Home.importContext(pr).catch(() => null); store.changed(pr.id, 'features'); return send(res, 200, r); } catch (e) { return send(res, 502, { error: 'Water lookup failed: ' + e.message }); }
    }
    if (sub === 'walk' && sid === 'route' && m === 'POST') {
      const b = await readBody(req); let an = null; try { an = await S.getAnalysis(pr); } catch (e) { /* terrain optional */ }
      const pts = (b.points || []).filter((q) => Array.isArray(q) && isFinite(q[0]) && isFinite(q[1])).slice(0, 30);
      if (!pts.length) return send(res, 400, { error: 'Add at least one point first.' });
      return send(res, 200, Home.walkRoute(pr, an, Array.isArray(b.start) ? b.start : null, pts, !!b.reorder));
    }
    if (sub === 'scout' && m === 'POST' && url.searchParams.get('mode') === 'candidates') {
      let an = null, wx = null; try { an = await S.getAnalysis(pr); } catch (e) { /* optional */ } try { wx = await S.getWeather(pr); } catch (e) { /* optional */ }
      const r = Home.scoutPlan(pr, wx, an, { candidates: true }); save(); return send(res, r.error ? 400 : 200, r);
    }
    if (sub === 'scout' && m === 'POST') { const r = await S.makeTools(store).impl.plan_scouting_walk({ property_id: pr.id }); return send(res, r.error ? 400 : 200, r); }
    if (sub === 'overlays') {
      if (m === 'GET') return send(res, 200, pr.overlays || []);
      if (m === 'DELETE') { pr.overlays = sid ? (pr.overlays || []).filter((o) => o.id !== sid) : []; store.changed(pr.id, 'overlays'); return send(res, 200, { ok: true }); }
    }
    if (sub === 'camera-report' && m === 'GET') return send(res, 200, cameraReport(pr));
    if (sub === 'predict' && m === 'GET') {
      let an = null, wx = null;
      try { an = await S.getAnalysis(pr); } catch (e) { /* terrain optional */ }
      try { wx = await S.getWeather(pr); } catch (e) { /* weather optional */ }
      ensureTerrain(pr);
      const key = crypto.createHash('md5').update(JSON.stringify([pr.features.map((f) => [f.id, f.type, f.coords]), (pr.sightings || []).length, (pr.wildlife || []).length, pr.context && pr.context.ts, pr.waterAt, pr.center, Math.floor(Date.now() / 3600000), !!an, !!wx])).digest('hex');
      const hit = predCache.get(pr.id); if (hit && hit.key === key) return send(res, 200, hit.out);
      const out = Home.predict(pr, wx, an); predCache.set(pr.id, { key, out });
      save(); return send(res, 200, out);
    }
    if (sub === 'elevation' && m === 'GET') {
      const g = await S.getGrid(pr, { refresh: url.searchParams.get('refresh') === '1', mode: url.searchParams.get('mode') || undefined });
      save(); return send(res, 200, g);
    }
    pr.walks = pr.walks || [];
    const colls = { walks: 'walks', wildlife: 'wildlife', features: 'features', sightings: 'sightings', pins: 'pins', notes: 'notes', bucks: 'bucks' };
    if (colls[sub]) {
      const list = pr[colls[sub]];
      if (m === 'POST') {
        const b = await readBody(req); b.id = uid(sub[0]);
        if (sub === 'features') { if (!b.type || !Array.isArray(b.coords) || !b.coords.length) return send(res, 400, { error: 'type + coords required' }); b.kind = b.kind || (b.coords.length === 1 ? 'point' : 'line'); }
        if (sub === 'sightings') { b.num = list.reduce((a, s) => Math.max(a, s.num || 0), 0) + 1; b.ts = b.ts || Date.now(); b.wx = b.wx || (await currentWx(pr)); }
        if (sub === 'notes') b.ts = Date.now();
        if (sub === 'pins') { b.ts = Date.now(); b.source = b.source || 'user'; }
        if (sub === 'features' && b.type === 'camera' && !b.deviceId) {
          const d = { id: uid('dev'), name: b.name || 'Trail Cam', brand: '', model: '', battery: null, notes: '', propertyId: pr.id, featureId: b.id, deployedAt: Date.now(), addedAt: Date.now() };
          store.state.devices.push(d); b.deviceId = d.id;
        }
        list.push(b); store.changed(pr.id, sub); return send(res, 200, b);
      }
      const item = list.find((x) => x.id === sid);
      if (!item) return send(res, 404, { error: 'Not found' });
      if (m === 'PUT') { const b = await readBody(req); delete b.id; Object.assign(item, b); store.changed(pr.id, sub); return send(res, 200, item); }
      if (m === 'DELETE') { if (sub === 'features' && item.deviceId) { const dv = store.state.devices.find((x) => x.id === item.deviceId); if (dv) { dv.propertyId = null; dv.featureId = null; dv.deployedAt = null; } } list.splice(list.indexOf(item), 1); store.changed(pr.id, sub); return send(res, 200, { ok: true }); }
    }
  }
  return send(res, 404, { error: 'Not found' });
}
async function currentWx(pr) {
  try { const w = await S.getWeather(pr); const x = S.wxAt(w, Date.now()); return { tempF: x.tempF, pressureInHg: x.pressureInHg, windMph: x.windMph, windDir: x.windDir, cloud: x.cloud }; } catch (e) { return null; }
}

/* ---------- http ---------- */
const server = http.createServer(async (req, res) => {
  try {
    if (!allowedHost(req.headers.host)) return send(res, 403, 'Forbidden host');
    const url = new URL(req.url, 'http://localhost');
    if (!isLocalHost(req.headers.host) && !tunnelGate(req, url)) return send(res, 403, 'Forbidden');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (!store.state.setupDone && isLocalHost(req.headers.host) && (url.pathname === '/' || url.pathname === '/index.html')) { res.writeHead(302, { location: '/setup.html' }); return res.end(); }
    let rel = decodeURIComponent(url.pathname);
    let root = PUB;
    if (rel.startsWith('/uploads/')) { root = UP_DIR; rel = rel.slice(8); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root)) return send(res, 403, 'Forbidden');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'Not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(buf);
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});
load();
Scout.startTelegram();
setInterval(() => { (store.state.connectors || []).forEach((c) => syncConnector(c)); }, 20 * 60 * 1000);
server.listen(PORT, HOST, () => {
  ScoutVision.start();
  if (!store.state.setupDone && !process.env.NO_OPEN) { const u = `http://localhost:${PORT}/setup.html`, c = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]]; try { require('child_process').spawn(c[0], c[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch (e) { /* print only */ } console.log(`
  First run: open ${u} to set up CabinScout`); }
  console.log(`\n  CABINSCOUT online  ->  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  store.state.properties.forEach((p, i) => setTimeout(() => ensureTerrain(p), 4000 + i * 6000));
  store.state.properties.forEach((p) => homeSummary(p)); // warm the home cards
  console.log(`  MCP endpoint                 ->  http://${HOST}:${PORT}/api/mcp   (Bearer token shown in the app's MCP modal)\n`);
});
