/* CabinScout Field: phone GPS + compass logger for trail cams, stands, sightings and hunts.
   Everything is stored on this phone (localStorage). Export a JSON file and import it into CabinScout. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const D2R = Math.PI / 180, COMP = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (d) => COMP[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
const norm = (d) => ((d % 360) + 360) % 360;
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const offset = (lat, lng, e, n) => [lat + n / 111320, lng + e / (111320 * Math.cos(lat * D2R))];
const YD = 0.9144;

/* ---------- storage ---------- */
const KEY = 'tsf_v1';
let DB = { settings: { decl: null }, items: [], active: null };
try { const j = JSON.parse(localStorage.getItem(KEY) || 'null'); if (j) DB = Object.assign(DB, j); } catch (e) { /* private mode */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch (e) { toast('Phone storage is full or blocked. Export now.'); } };
function toast(msg, ok) { const t = document.createElement('div'); t.className = 'toast' + (ok ? ' ok' : ''); t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4000); }
function add(it) { it.id = it.id || uid(it.kind[0]); it.ts = it.ts || Date.now(); DB.items.push(it); save(); return it; }

/* ---------- GPS (high accuracy, averaged on lock) ---------- */
const G = { fix: null, fixes: [], err: '' };
function startGPS() {
  if (!navigator.geolocation) { G.err = 'No GPS in this browser'; return renderStatus(); }
  navigator.geolocation.watchPosition((p) => {
    G.fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, ts: Date.now() };
    G.fixes.push(G.fix); if (G.fixes.length > 80) G.fixes.shift(); G.err = '';
    renderStatus(); if (S.tab === 'home') updateMe();
  }, (e) => { G.err = e.code === 1 ? 'Location blocked: allow it in browser settings' : e.message; renderStatus(); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
/* hold still for N seconds; weight each fix by 1/acc^2 so the good ones dominate */
function lockPosition(btn, sec = 8) {
  return new Promise((res, rej) => {
    if (!G.fix) { toast('No GPS fix yet. Step into the open and wait a few seconds.'); return rej(new Error('no fix')); }
    const t0 = Date.now(), label = btn ? btn.textContent : '';
    const tick = setInterval(() => {
      const left = Math.max(0, Math.ceil(sec - (Date.now() - t0) / 1000));
      if (btn) btn.textContent = `HOLD STILL… ${left}s (±${Math.round(G.fix.acc)} m)`;
      if (Date.now() - t0 < sec * 1000) return;
      clearInterval(tick); if (btn) btn.textContent = label;
      const use = G.fixes.filter((f) => f.ts >= t0 - 400 && f.acc < 80); const pts = use.length ? use : [G.fix];
      let w = 0, la = 0, ln = 0, best = 1e9; pts.forEach((f) => { const k = 1 / (f.acc * f.acc); w += k; la += f.lat * k; ln += f.lng * k; best = Math.min(best, f.acc); });
      res({ lat: la / w, lng: ln / w, acc: Math.max(Math.round(Math.min(best, 1 / Math.sqrt(w)) * 10) / 10, 1), n: pts.length, alt: G.fix.alt });
    }, 250);
  });
}

/* ---------- compass ---------- */
const C = { mag: null, buf: [], on: false };
function eulerHeading(alpha, beta, gamma) { // direction the BACK of the phone points (works held upright, as when aiming at a deer)
  const x = beta * D2R, y = gamma * D2R, z = alpha * D2R, cY = Math.cos(y), cZ = Math.cos(z), sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
  const vx = -cZ * sY - sZ * sX * cY, vy = -sZ * sY + cZ * sX * cY;
  return norm(Math.atan2(vx, vy) / D2R);
}
const circMean = (a) => norm(Math.atan2(a.reduce((s, d) => s + Math.sin(d * D2R), 0), a.reduce((s, d) => s + Math.cos(d * D2R), 0)) / D2R);
async function startCompass() {
  if (C.on) return;
  try { if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) { if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return toast('Compass permission was denied'); } } catch (e) { return toast('Compass: ' + e.message); }
  const h = (ev) => {
    let hd = null;
    if (ev.webkitCompassHeading != null) hd = ev.webkitCompassHeading;
    else if (ev.alpha != null && (ev.absolute || ev.type === 'deviceorientationabsolute')) hd = eulerHeading(ev.alpha, ev.beta, ev.gamma);
    if (hd == null || isNaN(hd)) return;
    C.buf.push(hd); if (C.buf.length > 10) C.buf.shift(); C.mag = circMean(C.buf); C.on = true; renderStatus(); if (S.dial) drawDial();
  };
  window.addEventListener('deviceorientationabsolute', h, true); window.addEventListener('deviceorientation', h, true);
  setTimeout(() => { if (C.mag == null) toast('No compass signal from this device. You can type a heading instead.'); }, 2500);
}
const decl = () => (DB.settings.decl == null ? 0 : Number(DB.settings.decl));
const trueHeading = () => (C.mag == null ? null : norm(C.mag + decl()));

/* ---------- weather snapshot (Open-Meteo, optional) ---------- */
async function weatherAt(lat, lng) {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,wind_speed_10m,wind_direction_10m,pressure_msl,cloud_cover&temperature_unit=fahrenheit&wind_speed_unit=mph`, { signal: AbortSignal.timeout(6000) });
    const c = (await r.json()).current;
    return { tempF: c.temperature_2m, windMph: c.wind_speed_10m, windDir: c.wind_direction_10m, pressureInHg: Math.round(c.pressure_msl * 0.02953 * 100) / 100, cloud: c.cloud_cover };
  } catch (e) { return null; }
}

/* ---------- header status ---------- */
function renderStatus() {
  const f = G.fix, d = $('#gps .dot');
  $('#gpsTxt').textContent = G.err ? G.err : f ? `±${Math.round(f.acc)} m · ${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}` : 'GPS: waiting…';
  d.className = 'dot ' + (G.err ? 'bad' : !f ? '' : f.acc <= 8 ? 'good' : f.acc <= 25 ? 'ok' : 'bad');
  const th = trueHeading();
  $('#cmpTxt').textContent = th == null ? 'Compass: tap to enable' : `${Math.round(th)}° ${compass(th)}${DB.settings.decl == null ? ' (set declination)' : ''}`;
  $('#cmpArrow').style.transform = th == null ? '' : `rotate(${th - 90}deg)`;
}
$('#gps').onclick = () => { if (!G.fix && !G.err) return; toast(G.fix ? `GPS accuracy ±${Math.round(G.fix.acc)} m. Under 8 m is good; hold still for 8 s when you lock.` : G.err); };
$('#cmp').onclick = () => { startCompass(); if (DB.settings.decl == null) askDecl(); };
function askDecl() {
  const v = prompt('Magnetic declination for your area, in degrees (east is +, west is -). Most of the eastern US is about -5 to -14, the Midwest near 0, the West positive. Look yours up at ngdc.noaa.gov/geomag.', DB.settings.decl == null ? '0' : DB.settings.decl);
  if (v != null && v !== '' && !isNaN(Number(v))) { DB.settings.decl = Number(v); save(); renderStatus(); toast('Declination set to ' + v + '°', true); }
}

/* ---------- shared form widgets ---------- */
const S = { tab: 'home', lock: {}, dial: false };
const SPECIES = [['deer', '🦌 Deer'], ['bear', '🐻 Bear'], ['coyote', '🐺 Coyote'], ['turkey', '🦃 Turkey'], ['hog', '🐗 Hog'], ['bobcat', '🐈 Bobcat'], ['fox', '🦊 Fox'], ['human', '🚜 Person/ATV'], ['other', '🐾 Other']];
const posBlock = (id, title = 'MY POSITION') => `<div class="card"><div class="lock"><div><label style="margin:0">${title}</label><div class="v" id="${id}Txt">not locked</div></div><button class="btn sm green" id="${id}Btn">LOCK GPS</button></div></div>`;
const dirBlock = (id, title) => `<div class="card"><div class="lock"><div><label style="margin:0">${title}</label><div class="v" id="${id}Txt">not set</div></div><button class="btn sm green" id="${id}Btn">LOCK COMPASS</button></div>
  <div class="row" style="margin-top:10px"><input id="${id}In" inputmode="numeric" placeholder="or type degrees 0-359"><select id="${id}Sel"><option value="">or pick…</option>${COMP.filter((_, i) => i % 2 === 0).map((c, i) => `<option value="${i * 45}">${c}</option>`).join('')}</select></div></div>`;
function wirePos(id) {
  $('#' + id + 'Btn').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { const p = await lockPosition(b); S.lock[id] = p; $('#' + id + 'Txt').innerHTML = `<b>${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</b><br>±${p.acc} m from ${p.n} readings`; } catch (er) { /* toast already shown */ }
    b.disabled = false;
  };
}
function wireDir(id) {
  const set = (h, how) => { S.lock[id] = Math.round(norm(h)); $('#' + id + 'Txt').innerHTML = `<b>${S.lock[id]}° ${compass(S.lock[id])}</b> (${how})`; };
  $('#' + id + 'Btn').onclick = async () => { await startCompass(); for (let i = 0; i < 15 && trueHeading() == null; i++) await new Promise((r) => setTimeout(r, 100)); const t = trueHeading(); if (t == null) return toast('Compass not ready yet. Wave the phone in a figure 8, then try again.'); set(t, 'compass'); };
  $('#' + id + 'In').onchange = (e) => { const v = Number(e.target.value); if (!isNaN(v) && e.target.value !== '') set(v, 'typed'); };
  $('#' + id + 'Sel').onchange = (e) => { if (e.target.value !== '') set(Number(e.target.value), 'picked'); };
}
const pills = (id, opts, multi) => `<div class="chips" id="${id}">${opts.map(([v, l], i) => `<div class="pill ${i === 0 && !multi ? 'on' : ''}" data-v="${v}">${l}</div>`).join('')}</div>`;
function wirePills(id) { $('#' + id).querySelectorAll('.pill').forEach((p) => (p.onclick = () => { $('#' + id).querySelectorAll('.pill').forEach((x) => x.classList.remove('on')); p.classList.add('on'); })); }
const pv = (id) => { const p = $('#' + id + ' .pill.on'); return p ? p.dataset.v : ''; };
const num = (id) => { const v = $('#' + id).value; return v === '' ? null : Number(v); };

/* ---------- screens ---------- */
let map = null, layer = null, me = null;
function show(tab) {
  S.tab = tab; S.lock = {}; S.dial = false; map = null;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
  ({ home: vHome, cam: vCam, stand: vStand, seen: vSeen, hunt: vHunt, log: vLog })[tab]();
  $('#view').scrollTop = 0;
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => show(b.dataset.t)));

function wedge(lat, lng, hd, fov, len) {
  const pts = [[lat, lng]]; for (let a = -fov / 2; a <= fov / 2; a += fov / 8) pts.push(offset(lat, lng, Math.sin((hd + a) * D2R) * len, Math.cos((hd + a) * D2R) * len));
  return pts;
}
function vHome() {
  $('#view').innerHTML = `<div id="map"></div><div class="card"><b>${DB.items.length}</b> things logged on this phone${DB.active ? ' · <span style="color:var(--green)">hunt in progress</span>' : ''}<div class="sub" style="margin:6px 0 0">Everything stays on your phone, works with no signal, and exports to CabinScout from the LOG tab.</div></div>
    <div class="row"><button class="btn" data-go="cam">📷 SET A CAMERA</button><button class="btn" data-go="stand">🌲 MARK A STAND</button></div><div style="height:10px"></div><div class="row"><button class="btn" data-go="seen">👁 LOG A SIGHTING</button><button class="btn red" data-go="hunt">🎯 HUNT</button></div>`;
  $('#view').querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => show(b.dataset.go)));
  if (typeof L === 'undefined') { $('#map').outerHTML = '<div class="card warn">Map library needs a signal to load the first time. Logging still works.</div>'; return; }
  map = L.map('map', { zoomControl: false, attributionControl: false }).setView(G.fix ? [G.fix.lat, G.fix.lng] : [39.5, -98.35], 4);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 18 }).addTo(map);
  layer = L.layerGroup().addTo(map); me = null; drawItems();
}
function drawItems() {
  DB.items.forEach((it) => {
    if (it.lat == null) return;
    if (it.kind === 'camera') { if (it.facing != null) L.polygon(wedge(it.lat, it.lng, it.facing, 45, 30), { color: '#38BDF8', weight: 1, fillOpacity: 0.3 }).addTo(layer); L.circleMarker([it.lat, it.lng], { radius: 6, color: '#38BDF8', fillOpacity: 1 }).bindTooltip(it.name).addTo(layer); }
    else if (it.kind === 'stand') L.circleMarker([it.lat, it.lng], { radius: 7, color: '#FF5500', fillOpacity: 1 }).bindTooltip(it.name).addTo(layer);
    else if (it.aLat != null) { L.polyline([[it.lat, it.lng], [it.aLat, it.aLng]], { color: it.kind === 'shot' ? '#EF4444' : '#FCD34D', weight: 2, dashArray: '4 4' }).addTo(layer); L.circleMarker([it.aLat, it.aLng], { radius: 5, color: it.kind === 'shot' ? '#EF4444' : '#FCD34D', fillOpacity: 1 }).bindTooltip(describe(it).title).addTo(layer); }
  });
  const pts = DB.items.filter((i) => i.lat != null).map((i) => [i.lat, i.lng]); if (!G.fix && pts.length) map.fitBounds(pts, { maxZoom: 18, padding: [20, 20] });
}
function updateMe() {
  if (!map || !G.fix) return;
  if (!me) { me = L.circleMarker([G.fix.lat, G.fix.lng], { radius: 8, color: '#fff', fillColor: '#10B981', fillOpacity: 1 }).addTo(map); map.setView([G.fix.lat, G.fix.lng], 18); }
  me.setLatLng([G.fix.lat, G.fix.lng]);
}

function vCam() {
  $('#view').innerHTML = `<h2>SET A TRAIL CAM</h2><p class="sub">Stand where the camera is mounted, lock your GPS, then hold the phone so its back points the same way the camera looks and lock the compass.</p>
    <label>CAMERA NAME</label><input id="n" placeholder="e.g. Cam 5 · Creek Crossing" autocomplete="off">
    ${posBlock('p', 'CAMERA POSITION')}${dirBlock('d', 'CAMERA IS FACING')}
    <canvas id="dial" class="dial" width="360" height="360"></canvas>
    <div class="row"><div><label>MOUNT HEIGHT (ft)</label><input id="h" inputmode="decimal" placeholder="3"></div><div><label>FIELD OF VIEW (°)</label><input id="fov" inputmode="numeric" value="45"></div></div>
    <label>NOTES</label><textarea id="no" rows="2" placeholder="Over the trail, SD card slot 1, lock code…"></textarea>
    <div style="height:14px"></div><button class="btn red" id="save">SAVE CAMERA</button>`;
  wirePos('p'); wireDir('d'); S.dial = true; drawDial();
  $('#save').onclick = () => {
    if (!S.lock.p) return toast('Lock the camera position first'); if (S.lock.d == null) return toast('Set which way the camera faces');
    add({ kind: 'camera', name: $('#n').value.trim() || 'Camera ' + (DB.items.filter((i) => i.kind === 'camera').length + 1), lat: S.lock.p.lat, lng: S.lock.p.lng, acc: S.lock.p.acc, facing: S.lock.d, fov: num('fov') || 45, heightFt: num('h'), notes: $('#no').value.trim() });
    toast('Camera saved', true); show('home');
  };
}
function drawDial() {
  const cv = $('#dial'); if (!cv) return; const c = cv.getContext('2d'), W = 360, R = 150; c.clearRect(0, 0, W, W); c.translate(W / 2, W / 2);
  c.strokeStyle = '#243246'; c.lineWidth = 3; c.beginPath(); c.arc(0, 0, R, 0, 7); c.stroke();
  c.fillStyle = '#8593A3'; c.font = '700 20px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([l, a]) => c.fillText(l, Math.sin(a * D2R) * (R + 0), -Math.cos(a * D2R) * R + (l === 'N' ? 0 : 0)));
  const live = trueHeading(), lock = S.lock.d;
  const cone = (h, col, a) => { c.fillStyle = col; c.globalAlpha = a; c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, R - 24, (h - 22.5 - 90) * D2R, (h + 22.5 - 90) * D2R); c.closePath(); c.fill(); c.globalAlpha = 1; };
  if (live != null) cone(live, '#FF5500', 0.25);
  if (lock != null) cone(lock, '#10B981', 0.6);
  c.setTransform(1, 0, 0, 1, 0, 0);
}

function vStand() {
  $('#view').innerHTML = `<h2>MARK A TREE STAND</h2><p class="sub">Sit or stand at the stand, lock your GPS. Add which way you shoot if it matters.</p>
    <label>STAND NAME</label><input id="n" placeholder="e.g. Stand 4 · Oak Flat Ladder" autocomplete="off">
    ${posBlock('p', 'STAND POSITION')}
    <label>TYPE</label>${pills('ty', [['Ladder', 'Ladder'], ['Hang-on', 'Hang-on'], ['Saddle', 'Saddle'], ['Ground blind', 'Ground blind'], ['Box blind', 'Box blind']])}
    <div class="row"><div><label>HEIGHT (ft)</label><input id="h" inputmode="decimal" placeholder="20"></div></div>
    ${dirBlock('d', 'MAIN SHOOTING LANE (optional)')}
    <label>BEST WINDS (optional)</label><input id="w" placeholder="e.g. W / NW">
    <label>NOTES</label><textarea id="no" rows="2" placeholder="Access route, trimmed lanes…"></textarea>
    <div style="height:14px"></div><button class="btn red" id="save">SAVE STAND</button>`;
  wirePos('p'); wireDir('d'); wirePills('ty');
  $('#save').onclick = () => {
    if (!S.lock.p) return toast('Lock the stand position first');
    add({ kind: 'stand', name: $('#n').value.trim() || 'Stand ' + (DB.items.filter((i) => i.kind === 'stand').length + 1), lat: S.lock.p.lat, lng: S.lock.p.lng, acc: S.lock.p.acc, standType: pv('ty'), heightFt: num('h'), facing: S.lock.d == null ? null : S.lock.d, bestWinds: $('#w').value.trim(), notes: $('#no').value.trim() });
    toast('Stand saved', true); show('home');
  };
}

/* where the animal was = my position pushed out along the bearing by the distance */
function animalPos(me, bearing, distYd) { if (!me || bearing == null || distYd == null) return null; const m = distYd * YD, p = offset(me.lat, me.lng, Math.sin(bearing * D2R) * m, Math.cos(bearing * D2R) * m); return { aLat: p[0], aLng: p[1] }; }
const YARD_CHIPS = [10, 20, 30, 40, 50, 75, 100, 150];
const distBlock = () => `<label>DISTANCE TO THE ANIMAL (yards)</label><input id="dist" inputmode="numeric" placeholder="e.g. 32"><div class="chips" style="margin-top:8px">${YARD_CHIPS.map((y) => `<div class="pill" data-y="${y}">${y}</div>`).join('')}</div>`;
function wireDist() { $('#view').querySelectorAll('[data-y]').forEach((p) => (p.onclick = () => { $('#dist').value = p.dataset.y; })); }
const behaviors = [['Feeding', 'Feeding'], ['Walking', 'Walking'], ['Cruising', 'Cruising'], ['Bedded', 'Bedded'], ['Rubbing', 'Rubbing'], ['Scraping', 'Scraping'], ['Alert/spooked', 'Alert / spooked']];
const sexOpts = [['unknown', 'Unknown'], ['buck', 'Buck'], ['doe', 'Doe'], ['fawn', 'Fawn'], ['group', 'Group']];

function sightingForm(kind, huntId) {
  const noShot = kind === 'seen';
  return `<label>WHAT</label>${pills('sp', SPECIES)}
    <div id="sexBox"><label>BUCK / DOE</label>${pills('sx', sexOpts)}</div>
    <div class="row"><div><label>HOW MANY</label><input id="cnt" inputmode="numeric" value="1"></div><div><label>RACK / AGE (optional)</label><input id="rack" placeholder="8 pt, mature"></div></div>
    <label>BEHAVIOR</label>${pills('bh', behaviors)}
    ${posBlock('p', 'WHERE I WAS STANDING')}${distBlock()}${dirBlock('d', 'DIRECTION TO THE ANIMAL')}
    <div class="card"><label style="margin-top:0">WHICH WAY IT WAS TRAVELING (optional)</label>${pills('tr', [['', 'Unknown'], ...COMP.filter((_, i) => i % 2 === 0).map((c, i) => [i * 45, c])])}</div>
    ${noShot ? `<label>WHY NO SHOT?</label>${pills('why', [['', 'Not hunting / just logging'], ['too far', 'Too far'], ['no clear shot', 'No clear shot'], ['not a shooter', 'Not a shooter'], ['doe/no tag', 'Doe / no tag'], ['wind', 'Wind/scent'], ['spooked', 'Spooked'], ['light', 'Too dark / legal light']])}` : ''}
    <label>NOTES</label><textarea id="no" rows="2"></textarea>`;
}
function wireSighting() {
  ['sp', 'sx', 'bh', 'tr', 'why'].forEach((i) => $('#' + i) && wirePills(i)); wirePos('p'); wireDir('d'); wireDist();
  $('#sp').querySelectorAll('.pill').forEach((p) => (p.addEventListener('click', () => $('#sexBox').style.display = p.dataset.v === 'deer' ? '' : 'none')));
  if (G.fix) { $('#pBtn').click(); }
}
async function collectSighting(kind, huntId) {
  const me2 = S.lock.p || (G.fix && { lat: G.fix.lat, lng: G.fix.lng, acc: G.fix.acc });
  if (!me2) { toast('Waiting for GPS'); return null; }
  const dist = num('dist'), brg = S.lock.d == null ? null : S.lock.d, ap = animalPos(me2, brg, dist);
  const base = { lat: me2.lat, lng: me2.lng, acc: me2.acc, species: pv('sp'), sex: pv('sx') || null, count: num('cnt') || 1, rack: $('#rack') ? $('#rack').value.trim() : '', behavior: pv('bh'), distYd: dist, bearing: brg, travel: pv('tr') === '' ? null : Number(pv('tr')), note: $('#no').value.trim(), huntId: huntId || null, ...(ap || {}) };
  base.wx = (DB.active && DB.active.wx) || (await weatherAt(me2.lat, me2.lng));
  return base;
}

function vSeen() {
  $('#view').innerHTML = `<h2>LOG A SIGHTING</h2><p class="sub">A deer, a bear, coyotes, anything. Point the phone at it, lock the direction, enter how far, and the animal's spot is plotted for you.</p>${sightingForm('seen')}<div style="height:14px"></div><button class="btn red" id="save">SAVE SIGHTING</button>`;
  wireSighting();
  $('#save').onclick = async () => { const b = await collectSighting('seen', DB.active && DB.active.id); if (!b) return; if (pv('why')) b.noShotReason = pv('why'); add({ kind: 'sighting', ...b }); toast('Sighting saved', true); show(DB.active ? 'hunt' : 'home'); };
}

/* ---------- hunt sessions ---------- */
const since = (ts) => { const m = Math.floor((Date.now() - ts) / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
function vHunt() {
  const a = DB.active;
  if (!a) {
    const stands = DB.items.filter((i) => i.kind === 'stand');
    const near = G.fix ? stands.map((s) => ({ s, d: Math.hypot((s.lat - G.fix.lat) * 111320, (s.lng - G.fix.lng) * 111320 * Math.cos(G.fix.lat * D2R)) })).sort((x, y) => x.d - y.d)[0] : null;
    $('#view').innerHTML = `<h2>START A HUNT</h2><p class="sub">Starting a hunt records where you sat, the time and the live weather, so every sighting and shot you log gets matched to the conditions.</p>
      <label>SITTING AT</label><select id="st">${stands.map((s) => `<option value="${s.id}" ${near && near.s.id === s.id && near.d < 60 ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}<option value="__here">A new spot (use my position)</option></select>
      <label>HUNTING</label>${pills('tg', SPECIES.slice(0, 5))}
      <label>WEAPON</label>${pills('wp', [['Bow', 'Bow'], ['Crossbow', 'Crossbow'], ['Rifle', 'Rifle'], ['Shotgun', 'Shotgun'], ['Muzzleloader', 'Muzzleloader']])}
      <div style="height:14px"></div><button class="btn red" id="go">START HUNT</button>`;
    wirePills('tg'); wirePills('wp'); if (!stands.length) $('#st').value = '__here';
    $('#go').onclick = async () => {
      if (!G.fix) return toast('Waiting for a GPS fix'); const sel = $('#st').value, st = DB.items.find((i) => i.id === sel);
      const wx = await weatherAt(G.fix.lat, G.fix.lng);
      DB.active = { id: uid('h'), kind: 'hunt', startTs: Date.now(), standId: st ? st.id : null, standName: st ? st.name : 'Field spot', lat: st ? st.lat : G.fix.lat, lng: st ? st.lng : G.fix.lng, acc: G.fix.acc, wx, target: pv('tg'), weapon: pv('wp') };
      save(); toast(wx ? `Hunt started. Wind ${compass(wx.windDir)} ${Math.round(wx.windMph)} mph, ${Math.round(wx.tempF)}°F` : 'Hunt started (no signal for weather)', true); vHunt();
    };
    return;
  }
  const mine = DB.items.filter((i) => i.huntId === a.id), shots = mine.filter((i) => i.kind === 'shot').length;
  $('#view').innerHTML = `<h2>HUNT IN PROGRESS</h2><p class="sub">${esc(a.standName)} · ${since(a.startTs)} in${a.wx ? ` · wind ${compass(a.wx.windDir)} ${Math.round(a.wx.windMph)} mph · ${Math.round(a.wx.tempF)}°F` : ''}</p>
    <div class="card">${mine.length} logged this hunt · ${shots} shot${shots === 1 ? '' : 's'}</div>
    <button class="btn red" id="shot">🎯 LOG A SHOT</button><div style="height:10px"></div>
    <button class="btn" id="saw">👁 SAW A DEER, NO SHOT</button><div style="height:10px"></div>
    <button class="btn" id="oth">🐻 SAW SOMETHING ELSE (bear, coyote…)</button><div style="height:18px"></div>
    <button class="btn green" id="end">END HUNT</button>`;
  $('#shot').onclick = () => shotForm(); $('#saw').onclick = () => { show('seen'); $('#sp .pill[data-v=deer]').click(); }; $('#oth').onclick = () => show('seen');
  $('#end').onclick = () => { if (!confirm('End this hunt?')) return; add({ ...a, kind: 'hunt', endTs: Date.now(), id: a.id, ts: a.startTs }); DB.active = null; save(); toast('Hunt saved', true); show('log'); };
}
function shotForm() {
  S.lock = {};
  $('#view').innerHTML = `<h2>LOG A SHOT</h2><p class="sub">Do this once you're safe and the moment has passed.</p>
    <label>WHAT</label>${pills('sp', SPECIES.slice(0, 5))}<div id="sexBox"><label>BUCK / DOE</label>${pills('sx', sexOpts)}</div>
    <label>RESULT</label>${pills('res', [['hit-recovered', 'Hit · recovered'], ['hit-lost', 'Hit · not found'], ['miss', 'Clean miss'], ['pass-through', 'Pass-through, tracking'], ['unknown', 'Not sure']])}
    ${posBlock('p', 'WHERE I WAS STANDING')}${distBlock()}${dirBlock('d', 'DIRECTION TO THE ANIMAL AT THE SHOT')}
    <label>SHOT PLACEMENT / HIT</label>${pills('pl', [['', 'N/A'], ['heart/lung', 'Heart / lung'], ['liver', 'Liver'], ['gut', 'Gut'], ['shoulder', 'Shoulder'], ['high', 'High'], ['low', 'Low'], ['back', 'Back / hams']])}
    <div class="row"><div><label>TIME TO RECOVER (min, optional)</label><input id="rec" inputmode="numeric"></div><div><label>BLOOD / SIGN</label><input id="bl" placeholder="bright, frothy, dark…"></div></div>
    <label>NOTES</label><textarea id="no" rows="2" placeholder="Reaction, angle, arrow/bullet used…"></textarea>
    <div style="height:14px"></div><button class="btn red" id="save">SAVE SHOT</button><div style="height:10px"></div><button class="btn" id="cancel">CANCEL</button>`;
  ['sp', 'sx', 'res', 'pl'].forEach(wirePills); wirePos('p'); wireDir('d'); wireDist();
  $('#sp').querySelectorAll('.pill').forEach((p) => p.addEventListener('click', () => ($('#sexBox').style.display = p.dataset.v === 'deer' ? '' : 'none')));
  if (G.fix) $('#pBtn').click();
  $('#cancel').onclick = () => show('hunt');
  $('#save').onclick = async () => {
    const me2 = S.lock.p || (G.fix && { lat: G.fix.lat, lng: G.fix.lng, acc: G.fix.acc }); if (!me2) return toast('Waiting for GPS');
    const dist = num('dist'), brg = S.lock.d == null ? null : S.lock.d, ap = animalPos(me2, brg, dist);
    add({ kind: 'shot', lat: me2.lat, lng: me2.lng, acc: me2.acc, species: pv('sp'), sex: pv('sx') || null, result: pv('res'), distYd: dist, bearing: brg, placement: pv('pl'), recoverMin: num('rec'), blood: $('#bl').value.trim(), weapon: DB.active && DB.active.weapon, note: $('#no').value.trim(), huntId: DB.active && DB.active.id, wx: DB.active && DB.active.wx, ...(ap || {}) });
    toast('Shot logged', true); show('hunt');
  };
}

/* ---------- log + export ---------- */
const ICON = { camera: '📷', stand: '🌲', sighting: '👁', shot: '🎯', hunt: '🏹' };
function describe(it) {
  const sp = it.species ? (SPECIES.find((s) => s[0] === it.species) || [0, it.species])[1] : '';
  if (it.kind === 'camera') return { title: it.name, sub: `facing ${it.facing}° ${compass(it.facing)} · ±${it.acc} m` };
  if (it.kind === 'stand') return { title: it.name, sub: `${it.standType || ''}${it.heightFt ? ' · ' + it.heightFt + ' ft' : ''} · ±${it.acc} m` };
  if (it.kind === 'sighting') return { title: `${sp}${it.count > 1 ? ' ×' + it.count : ''}${it.sex && it.sex !== 'unknown' ? ' ' + it.sex : ''}`, sub: `${it.distYd ? it.distYd + ' yd' : ''}${it.bearing != null ? ' ' + compass(it.bearing) : ''} · ${it.behavior || ''}${it.noShotReason ? ' · no shot: ' + it.noShotReason : ''}` };
  if (it.kind === 'shot') return { title: `Shot at ${sp}${it.sex && it.sex !== 'unknown' ? ' ' + it.sex : ''}: ${(it.result || '').replace('-', ' ')}`, sub: `${it.distYd ? it.distYd + ' yd' : ''}${it.bearing != null ? ' ' + compass(it.bearing) : ''}${it.placement ? ' · ' + it.placement : ''}` };
  return { title: `Hunt at ${it.standName}`, sub: `${since(it.startTs)}${it.endTs ? '' : ' so far'} · ${it.weapon || ''}${it.wx ? ` · wind ${compass(it.wx.windDir)} ${Math.round(it.wx.windMph)}` : ''}` };
}
function vLog() {
  const list = DB.items.slice().sort((a, b) => b.ts - a.ts);
  $('#view').innerHTML = `<h2>EVERYTHING LOGGED</h2><p class="sub">${list.length} items on this phone.</p>
    <div class="row"><button class="btn green" id="exp">⬇ EXPORT FOR CABINSCOUT</button><button class="btn" id="decl">DECLINATION ${DB.settings.decl == null ? '(not set)' : DB.settings.decl + '°'}</button></div>
    <div class="sub" style="margin-top:10px">In CabinScout click "IMPORT FIELD DATA" and pick the downloaded file. Cameras, stands, sightings and hunts land on the right property automatically.</div>
    <div class="card" style="padding:4px 12px">${list.map((it) => { const d = describe(it); return `<div class="item"><div class="ic">${ICON[it.kind]}</div><div class="m"><b>${esc(d.title)}</b><small>${esc(d.sub)}</small><small>${new Date(it.ts).toLocaleString()}</small></div><button data-del="${it.id}" aria-label="Delete">✕</button></div>`; }).join('') || '<div class="sub" style="padding:12px 0">Nothing yet.</div>'}</div>`;
  $('#decl').onclick = () => { askDecl(); vLog(); };
  $('#exp').onclick = async () => {
    const blob = new Blob([JSON.stringify({ app: 'cabinscout-field', version: 1, exportedAt: new Date().toISOString(), declination: DB.settings.decl, items: DB.items }, null, 1)], { type: 'application/json' });
    const f = new File([blob], `cabinscout-field-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
    try { if (navigator.canShare && navigator.canShare({ files: [f] })) return await navigator.share({ files: [f], title: 'CabinScout field data' }); } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('#view').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { if (!confirm('Delete this entry?')) return; DB.items = DB.items.filter((i) => i.id !== b.dataset.del); save(); vLog(); }));
}

/* ---------- boot ---------- */
renderStatus(); startGPS(); show('home');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (typeof DeviceOrientationEvent !== 'undefined' && !DeviceOrientationEvent.requestPermission) startCompass(); // Android needs no tap
})();
