/* CabinScout front end. Leaflet map + Physics engine (physics.js) + REST/SSE/MCP backend. */
(() => {
'use strict';
const P = window.Physics;
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CC = {}; // short-lived cache of read-only answers; any write clears it
const api = async (path, o = {}) => {
  if (o.method && o.method !== 'GET') for (const k in CC) delete CC[k];
  const r = await fetch('/api' + path, { method: o.method || 'GET', headers: o.body ? { 'content-type': 'application/json' } : {}, body: o.body ? JSON.stringify(o.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
};
const cached = async (k, fn, ttl) => { const e = CC[k]; if (e && Date.now() - e.t < ttl) return e.v; const v = await fn(); CC[k] = { t: Date.now(), v }; return v; };
const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem('ts_' + k)); localStorage.setItem('ts_' + k, JSON.stringify(v)); } catch (e) { return null; } };

/* ---------- feature + behavior catalogue ---------- */
const FT = {
  boundary: { label: 'Property Boundary', kind: 'polygon', color: '#FF2D2D', fill: 0, icon: '▭' },
  bedding: { label: 'Bedding Area', kind: 'polygon', color: '#F59E0B', fill: 0.3, icon: 'Z' },
  food: { label: 'Food Source', kind: 'polygon', color: '#10B981', fill: 0.3, icon: '❀' },
  stream: { label: 'Stream / Creek', kind: 'line', color: '#38BDF8', icon: '~' },
  water: { label: 'Water / Swamp', kind: 'polygon', color: '#38BDF8', fill: 0.22, icon: '≈' },
  house: { label: 'House (tap each one)', kind: 'point', color: '#CBD5E1', icon: '⌂' },
  road: { label: 'Road (start to end)', kind: 'line', color: '#CBD5E1', dash: '2 6', icon: '═' },
  buffer: { label: 'Road / Houses Buffer', kind: 'polygon', color: '#94A3B8', fill: 0.15, dash: '2 6', icon: '⌂' },
  pinch: { label: 'Pinch Point', kind: 'point', color: '#FF5500', icon: '✕' },
  scrape: { label: 'Scrape', kind: 'point', color: '#FF5500', icon: 'S' },
  rubline: { label: 'Rub Line', kind: 'line', color: '#FF5500', icon: '╱' },
  access: { label: 'Entry / Exit Trail', kind: 'line', color: '#10B981', dash: '8 6', icon: '⇢' },
  start: { label: 'My Start (where I begin)', kind: 'point', color: '#22C55E', icon: '⚑' },
  stand: { label: 'Tree Stand / Blind', kind: 'point', color: '#FF5500', icon: '▲' },
  camera: { label: 'Trail Camera', kind: 'point', color: '#38BDF8', icon: '◉' },
};
const BEHAVIORS = ['Bedding', 'Cruising', 'Feeding', 'Rubbing', 'Scraping'];
const LAYERS = [['thermal', 'Thermal Vectors', '#FF5500'], ['scent', 'Scent Cones', '#10B981'], ['sightings', 'Deer Sightings', '#EF4444'], ['trails', 'Movement Strings', '#F59E0B'],
  ['predict', 'Predicted Deer Paths + Setups', '#FBBF24'], ['wildlife', 'Wildlife & Predators', '#F87171'], ['scoutlog', 'Scout Log (Telegram uploads)', '#F59E0B'], ['features', 'Property Features', '#38BDF8'], ['elev', 'Elevation Colors (low to high)', '#22C55E'], ['hillshade', 'Hills (shaded relief)', '#94A3B8'], ['context', 'Surrounding Land', '#84CC16'], ['neighbors', 'Neighbor Parcels', '#CBD5E1'], ['terrain', 'Terrain Roles', '#A78BFA'], ['pins', 'Red Target Pins', '#EF4444'], ['walks', 'My Scouting Walks', '#2DD4BF'], ['buildings', 'Houses nearby (OpenStreetMap)', '#9CA3AF'], ['ai', 'AI Drawings (herds, routes)', '#F472B6']];

/* ---------- state ---------- */
const S = {
  cfg: null, props: [], activeId: null, prop: null, grid: null, an: null, wx: null, field: null, cones: [], dayStart: 0, scrub: 0, live: true,
  filter: null, selPin: null, tool: null, draw: [], layers: Object.assign({ thermal: false, scent: false, sightings: true, scoutlog: true, trails: false, predict: true, wildlife: true, hillshade: false, elev: false, context: false, neighbors: false, features: true, terrain: false, pins: true, ai: true, buildings: true, walks: true }, store('layers2') || {}),
  chat: [], order: store('order') || [], base: store('base') || 'sat',
};
const prop = () => S.prop;
const feats = (t) => (S.prop ? S.prop.features.filter((f) => !t || f.type === t) : []);

/* ---------- time helpers (property-local time via Open-Meteo utc offset) ---------- */
const offMs = () => (S.wx ? S.wx.utcOffsetSec : -14400) * 1000;
const ld = (ms) => new Date(ms + offMs());
const dayStartOf = (ms) => Math.floor((ms + offMs()) / 86400000) * 86400000 - offMs();
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hm = (ms) => { const d = ld(ms); let h = d.getUTCHours(); const m = d.getUTCMinutes(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + ' ' + ap; };
const dstr = (ms) => { const d = ld(ms); return WD[d.getUTCDay()] + ' ' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
const curMs = () => S.dayStart + S.scrub * 3600000;
const nowHours = () => (Date.now() - S.dayStart) / 3600000;

function wxAt(ms) {
  const H = S.wx.hours;
  let i = H.findIndex((h) => h.ms > ms) - 1;
  if (i < 0) i = ms < H[0].ms ? 0 : H.length - 2;
  const a = H[i], b = H[Math.min(H.length - 1, i + 1)];
  const t = b.ms === a.ms ? 0 : P.clamp((ms - a.ms) / (b.ms - a.ms), 0, 1);
  const L = (k) => a[k] + (b[k] - a[k]) * t;
  const ux = Math.sin(a.windDir * P.D2R) * (1 - t) + Math.sin(b.windDir * P.D2R) * t, uy = Math.cos(a.windDir * P.D2R) * (1 - t) + Math.cos(b.windDir * P.D2R) * t;
  return { tempF: L('tempF'), pressureInHg: L('pressureInHg'), windMph: L('windMph'), gust: L('gustMph'), windDir: Math.round(P.norm360(Math.atan2(ux, uy) / P.D2R)), cloud: L('cloud'), precip: L('precip') };
}

/* ---------- toast / modal ---------- */
function toast(msg, ok) {
  const t = document.createElement('div'); t.className = 'toast' + (ok ? ' ok' : ''); t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4500);
}
function modal(html, onMount) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = '<div class="modal">' + html + '</div>';
  const close = () => bg.remove();
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  $('#modalRoot').appendChild(bg);
  if (onMount) onMount(bg.firstChild, close);
  return close;
}
function askName(title, def) {
  return new Promise((res) => {
    modal(`<h3>${esc(title)}</h3><label>NAME</label><input id="nm" value="${esc(def || '')}" autocomplete="off"><div class="foot"><button class="btn" id="c">CANCEL</button><button class="btn red" id="o">SAVE</button></div>`,
      (m, close) => {
        const inp = $('#nm', m); inp.focus(); inp.select();
        const done = (v) => { close(); res(v); };
        $('#c', m).onclick = () => done(null); $('#o', m).onclick = () => done(inp.value.trim() || def || 'Unnamed');
        inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || def || 'Unnamed'); if (e.key === 'Escape') done(null); };
      });
  });
}

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: false, maxZoom: 20, doubleClickZoom: true, attributionControl: true }).setView([39.5, -98.35], 4);
L.control.zoom({ position: 'bottomright' }).addTo(map);
const tiles = {
  usgs: L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 16, attribution: 'Imagery: USGS' }),
  etopo: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 17, attribution: 'Topo © Esri' }),
  utopo: L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 16, attribution: 'Topo: USGS' }),
  relief: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 16, attribution: 'Relief © Esri' }),
  sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 18, attribution: 'Imagery © Esri' }),
  topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 17, subdomains: 'abc', attribution: '© OpenTopoMap, OSM' }),
};
function setBase(b) { if (!tiles[b]) b = 'sat'; S.base = b; store('base', b); Object.values(tiles).forEach((t) => map.hasLayer(t) && map.removeLayer(t)); tiles[b].addTo(map).bringToBack(); renderLayerBox(); }
const G = { features: L.layerGroup(), terrain: L.layerGroup(), thermal: L.layerGroup(), scent: L.layerGroup(), trails: L.layerGroup(), predict: L.layerGroup(), elev: L.layerGroup(), wildlife: L.layerGroup(), scoutlog: L.layerGroup(), context: L.layerGroup(), neighbors: L.layerGroup(), hillshade: L.layerGroup([L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 16, opacity: 0.7, className: 'hillshade-tiles', attribution: 'Hillshade © Esri' })]), sightings: L.layerGroup(), pins: L.layerGroup(), walks: L.layerGroup(), walkDraft: L.layerGroup(), buildings: L.layerGroup(), ai: L.layerGroup(), rot: L.layerGroup(), route: L.layerGroup(), draw: L.layerGroup() };
const canvasR = L.canvas({ padding: 0.3 });
Object.values(G).forEach((g) => g.addTo(map));
function applyLayerVis() { Object.keys(S.layers).forEach((k) => { if (!G[k]) return; if (S.layers[k]) G[k].addTo(map); else map.removeLayer(G[k]); }); G.route.addTo(map); G.draw.addTo(map); G.walkDraft.addTo(map); }

/* ---------- header / HUD ---------- */
function renderProps() { /* properties are picked from the home page */ }
function renderHud() {
  if (!S.wx || !S.prop) return;
  const ms = curMs(), w = wxAt(ms), w3 = wxAt(ms - 3 * 3600000), tr = w.pressureInHg - w3.pressureInHg;
  const moon = P.moonPhase(ms);
  const day = S.wx.daily.find((d) => Math.abs(d.ms - S.dayStart - Math.floor(S.scrub / 24) * 86400000) < 20 * 3600000);
  let light = '--';
  if (day && day.sunrise) {
    const a = day.sunrise - 1800000, b = day.sunset + 1800000;
    light = hm(a) + '–' + hm(b);
  }
  const now = Date.now();
  const sd = S.wx.daily.find((d) => Math.abs(d.ms - dayStartOf(now)) < 20 * 3600000);
  let lightState = '';
  if (sd && S.live) lightState = now >= sd.sunrise - 1800000 && now <= sd.sunset + 1800000 ? 'LEGAL' : 'DARK';
  const arrow = tr > 0.01 ? '▲' : tr < -0.01 ? '▼' : '▬';
  const hc = (l, v) => `<div class="hc"><div class="l">${l}</div><div class="v">${v}</div></div>`;
  $('#hud').innerHTML =
    hc(S.live ? 'TEMP · LIVE' : 'TEMP · ' + dstr(ms).toUpperCase(), Math.round(w.tempF) + '°F') +
    hc('BAROMETER', `${w.pressureInHg.toFixed(2)} inHg <span style="color:${tr >= 0 ? 'var(--green)' : 'var(--amber)'}">${arrow}</span>`) +
    hc('WIND (FROM)', `<i style="transform:rotate(${w.windDir + 180}deg)">↑</i> ${P.compass(w.windDir)} ${w.windDir}° · ${Math.round(w.windMph)} mph`) +
    hc('MOON', `${moon.icon} ${moon.illum}%`) +
    hc('SHOOTING LIGHT', `${light} ${lightState ? `<span style="color:${lightState === 'LEGAL' ? 'var(--green)' : 'var(--red)'}">${lightState}</span>` : ''}`) +
    hc('DEM', esc(S.grid ? S.grid.source : 'LOADING'));
}
function renderMcp() {
  const m = S.cfg && S.cfg.mcp; if (!m) return;
  const b = $('#mcpBadge'); b.classList.toggle('off', !m.enabled);
  $('#mcpTxt').textContent = !m.enabled ? 'MCP UPLINK OFF' : m.clients.length ? `MCP UPLINK · ${m.clients.length} CLIENT${m.clients.length > 1 ? 'S' : ''}` : 'MCP UPLINK READY';
}

/* ---------- field / thermals / scent ---------- */
const waterFn = () => { const polys = feats('water').filter((f) => f.kind === 'polygon'); return (lat, lng) => polys.some((f) => P.pointInPoly([lat, lng], f.coords)); };
function computeField() {
  if (!S.an || !S.wx) { S.field = null; return; }
  const ms = curMs();
  S.field = P.computeField(S.an, wxAt(ms), { utcMs: ms }, waterFn());
}
const MODE_COL = { rising: '#FF5500', falling: '#38BDF8', switch: '#A78BFA', calm: '#64748B' };
const HYPSO = [[0, [34, 139, 34]], [0.35, [154, 205, 50]], [0.6, [238, 210, 90]], [0.8, [176, 122, 70]], [1, [245, 245, 245]]];
function hypso(t) { for (let i = 1; i < HYPSO.length; i++) if (t <= HYPSO[i][0]) { const [t0, c0] = HYPSO[i - 1], [t1, c1] = HYPSO[i], k = (t - t0) / (t1 - t0); return c0.map((v, j) => Math.round(v + (c1[j] - v) * k)); } return HYPSO[HYPSO.length - 1][1]; }
function renderElev() {
  G.elev.clearLayers();
  const g = S.grid; if (!g || !S.layers.elev) return;
  const flat = g.elevM.flat(), lo = Math.min(...flat), hi = Math.max(...flat), span = Math.max(hi - lo, 4), n = g.n, h = (n - 1) / 2, s = g.spacing / 2;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const cx = (i - h) * g.spacing, cy = (j - h) * g.spacing, c = hypso((g.elevM[j][i] - lo) / span);
    L.rectangle([P.offset(g.center.lat, g.center.lng, cx - s, cy - s), P.offset(g.center.lat, g.center.lng, cx + s, cy + s)], { stroke: false, fillColor: `rgb(${c})`, fillOpacity: 0.42, interactive: false }).addTo(G.elev);
  }
  const t = $('#elevKey'); if (t) t.textContent = `${Math.round(lo * P.FT)} ft (green) to ${Math.round(hi * P.FT)} ft (white)`;
}
function renderThermal() {
  G.thermal.clearLayers(); G.scent.clearLayers(); G.terrain.clearLayers();
  const f = S.field; if (!f) return;
  const c = f.center;
  if (S.layers.thermal) {
    const lines = { rising: [], falling: [], switch: [], calm: [] }, chev = [];
    f.cells.forEach((cell) => {
      const sp = Math.hypot(cell.u, cell.v);
      const [la, ln] = P.offset(c.lat, c.lng, cell.x, cell.y);
      if (cell.sw) { // swirling eddy
        const pts = [];
        for (let k = 0; k <= 24; k++) { const a = k * 0.55, r = 1.5 + k * 0.36; pts.push(P.offset(la, ln, r * Math.cos(a), r * Math.sin(a))); }
        lines.switch.push(pts);
      }
      if (sp < 0.12) return;
      const len = Math.min(f.spacing * 0.85, 9 + sp * 9), ux = cell.u / sp, uy = cell.v / sp;
      const tail = P.offset(la, ln, -ux * len / 2, -uy * len / 2), head = P.offset(la, ln, ux * len / 2, uy * len / 2);
      const w1 = P.offset(head[0], head[1], (-ux * 0.9 + uy * 0.5) * len * 0.4, (-uy * 0.9 - ux * 0.5) * len * 0.4), w2 = P.offset(head[0], head[1], (-ux * 0.9 - uy * 0.5) * len * 0.4, (-uy * 0.9 + ux * 0.5) * len * 0.4);
      if (!cell.sw) lines[cell.mode in lines ? cell.mode : 'calm'].push([tail, head], [w1, head, w2]);
      if (cell.upd) chev.push([P.offset(la, ln, -3, -2), P.offset(la, ln, 0, 3), P.offset(la, ln, 3, -2)]);
    });
    Object.keys(lines).forEach((k) => lines[k].length && L.polyline(lines[k], { color: MODE_COL[k], weight: k === 'switch' ? 1.6 : 2, opacity: 0.6, renderer: canvasR, interactive: false }).addTo(G.thermal));
    if (chev.length) L.polyline(chev, { color: '#34D399', weight: 2, opacity: 0.9, renderer: canvasR, interactive: false }).addTo(G.thermal);
  }
  if (S.layers.terrain) {
    const COL = { ridge: '#F87171', bench: '#FBBF24', drain: '#38BDF8', basin: '#3B82F6', slope: '#A78BFA', flat: '#475569' };
    S.an.cells.forEach((cell) => { if (cell.role === 'flat') return; const ll = P.offset(c.lat, c.lng, cell.x, cell.y);
      L.circleMarker(ll, { radius: 5, color: COL[cell.role], fillColor: COL[cell.role], fillOpacity: 0.6, weight: 1, renderer: canvasR }).bindTooltip(`${cell.role.toUpperCase()} · ${Math.round(cell.z * P.FT)} ft · ${cell.slope.toFixed(0)}° slope`).addTo(G.terrain); });
  }
  S.cones = feats('stand').map((st) => ({ st, cone: P.scentCone(st.coords[0], f, S.prop.features) }));
  S.cones.forEach(({ st, cone }) => {
    const col = cone.status === 'green' ? '#10B981' : cone.status === 'yellow' ? '#F59E0B' : '#EF4444';
    L.polygon(cone.polygon, { stroke: false, fillColor: col, fillOpacity: 0.07, interactive: false }).addTo(G.scent);
    const s0 = st.coords[0], far = Math.max(...cone.polygon.map((q) => P.distM(s0, q))), az = cone.azimuth * P.D2R, len = far * 0.6, tip = P.offset(s0[0], s0[1], Math.sin(az) * len, Math.cos(az) * len);
    const hd = (d) => P.offset(tip[0], tip[1], Math.sin(az + d) * -7, Math.cos(az + d) * -7);
    L.polyline([P.offset(s0[0], s0[1], Math.sin(az) * 10, Math.cos(az) * 10), tip], { color: col, weight: 2, opacity: 0.6, interactive: false }).addTo(G.scent);
    L.polyline([hd(0.5), tip, hd(-0.5)], { color: col, weight: 2, opacity: 0.6, interactive: false }).addTo(G.scent);
  });
  const bits = [`THERMAL ${f.mode.toUpperCase()}`, `SUN ${f.sunE.toFixed(0)}°`];
  if (f.transition) bits.push('⚠ THERMAL SWITCH: scent unreliable');
  const w = wxAt(curMs()); bits.push(`${P.compass(w.windDir)} ${Math.round(w.windMph)} mph`);
  $('#status').textContent = bits.join('  |  ');
  $('#tMode').textContent = f.transition ? 'SWITCH · swirling' : f.mode === 'rising' ? 'RISING upslope' : 'FALLING downslope';
  $('#tMode').style.color = MODE_COL[f.mode];
}

/* ---------- stage size (the scent used to be an animated particle plume; it is a calm static cone + arrow now) ---------- */
const pc = $('#plume');
new ResizeObserver(() => { map.invalidateSize(); }).observe($('#stage'));
pc.style.display = 'none';

/* ---------- features ---------- */
const latlngs = (f) => f.coords;
function featIcon(f) {
  const d = FT[f.type] || { color: '#fff', icon: '?' };
  return L.divIcon({ className: '', html: `<div class="mi" style="--c:${d.color}">${d.icon}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
}
function deselect() { S.selFeat = null; S.rotOn = false; G.rot.clearLayers(); $('#selbar').classList.add('hidden'); }
function selectFeat(f) { S.selFeat = f.id; S.rotOn = false; renderSel(); }
function renderSel() {
  const f = feats().find((x) => x.id === S.selFeat), bar = $('#selbar');
  if (!f) return deselect();
  showRot(f);
  const d = FT[f.type] || { icon: '?', label: f.type }, canRot = f.type === 'camera' || f.type === 'stand';
  bar.classList.remove('hidden');
  bar.innerHTML = `<div class="sb-h"><span>${d.icon} <b>${esc(f.name)}</b></span><button class="x" id="sbX" title="Close">&#10005;</button></div>
    <div class="sm">${d.label}${f.facing != null ? ' · facing ' + P.compass(f.facing) + ' ' + Math.round(f.facing) + '°' : ''}</div>
    <div class="sb-btns">${canRot ? `<button class="btn ${S.rotOn ? 'green' : ''}" id="sbRot">&#8635; ${S.rotOn ? 'DONE TURNING' : 'ROTATE'}</button>` : ''}${f.type === 'camera' ? '<button class="btn" id="sbLog">&#128247; LOG A PHOTO</button>' : ''}<button class="btn" id="sbRen">&#9998; RENAME</button><button class="btn red" id="sbDel">&#128465; DELETE</button></div>
    <div class="sm">Drag it on the map to move it.${f.type === 'camera' && f.facing == null ? ' Press ROTATE and drag the gold handle so I know which way it points.' : ''}</div>`;
  $('#sbX').onclick = deselect;
  if (canRot) $('#sbRot').onclick = () => { S.rotOn = !S.rotOn; renderSel(); };
  if (f.type === 'camera') $('#sbLog').onclick = () => sightingForm(undefined, f.id);
  $('#sbRen').onclick = async () => { const nm = await askName('Rename', f.name); if (nm && nm !== f.name) { await api(`/properties/${S.activeId}/features/${f.id}`, { method: 'PUT', body: { name: nm } }); await refresh(); } };
  $('#sbDel').onclick = async () => { if (!confirm(`Delete "${f.name}"?`)) return; await api(`/properties/${S.activeId}/features/${f.id}`, { method: 'DELETE' }); deselect(); map.closePopup(); await refresh(); };
}
async function moved(path, body, name) {
  try { await api(`/properties/${S.activeId}/${path}`, { method: 'PUT', body }); toast(`${name} moved`, true); await refresh(); loadPredict(); } catch (e) { toast(e.message); await refresh(); }
}
/* the view cone and traffic arrow only show while the camera is selected; the facing is still stored for the AI and predictions */
function drawView(f) {
    if ((f.type === 'camera' || f.type === 'stand') && f.facing != null) { const cam = f.type === 'camera', cc = cam ? '#38BDF8' : '#E0A83C', c0 = f.coords[0], fv = f.fov || (cam ? 52 : 45), rg = cam ? (f.rangeM || 32) : 32, pts = [c0]; for (let k = -6; k <= 6; k++) { const hd = (f.facing + k * (fv / 12)) * P.D2R; pts.push(P.offset(c0[0], c0[1], Math.sin(hd) * rg, Math.cos(hd) * rg)); } L.polygon(pts, { color: cc, weight: 1, fillColor: cc, fillOpacity: 0.2, interactive: false }).bindTooltip(`${esc(f.name)}: sees ${Math.round(fv)}\u00B0 wide, about ${Math.round(rg * 3.28)} ft out, facing ${P.compass(f.facing)}`, { sticky: true }).addTo(G.rot); }
    if (f.type === 'camera' && f.kind === 'point') { const tr = camTraffic(f); if (tr) { const c0 = f.coords[0], br = tr.deg * P.D2R, e = P.offset(c0[0], c0[1], Math.sin(br) * 28, Math.cos(br) * 28); L.polyline([c0, e], { color: '#F59E0B', weight: 3, opacity: 0.9, interactive: false }).addTo(G.rot); L.marker(e, { icon: L.divIcon({ className: '', html: `<div class="sarrow" style="color:#F59E0B;font-size:16px;transform:rotate(${tr.deg}deg)">&#9650;</div>`, iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: true }).bindTooltip(`Animals pass ${esc(f.name)} heading ${P.compass(tr.deg)} (${tr.n} of ${tr.total} photos)`).addTo(G.rot); } }
}
function showRot(f) {
  G.rot.clearLayers();
  if (!f || (f.type !== 'camera' && f.type !== 'stand') || f.kind !== 'point') return;
  drawView(f);
  if (!S.rotOn) return;
  const c = f.coords[0], R = f.type === 'camera' ? Math.max(18, f.rangeM || 30) : 30, brg = (f.facing == null ? 0 : f.facing) * P.D2R, at = (b) => P.offset(c[0], c[1], Math.sin(b) * R, Math.cos(b) * R);
  const line = L.polyline([c, at(brg)], { color: '#E0A83C', weight: 3, dashArray: '4 4', interactive: false }).addTo(G.rot);
  const hd = L.marker(at(brg), { icon: L.divIcon({ className: '', html: '<div class="rot" title="Drag to turn">&#8635;</div>', iconSize: [24, 24], iconAnchor: [12, 12] }), draggable: true, zIndexOffset: 2000 }).addTo(G.rot);
  const bearing = (ll) => { const dy = (ll.lat - c[0]) * 111320, dx = (ll.lng - c[1]) * 111320 * Math.cos(c[0] * P.D2R); return (Math.atan2(dx, dy) / P.D2R + 360) % 360; };
  hd.on('drag', (ev) => { const b = bearing(ev.target.getLatLng()); line.setLatLngs([c, at(b * P.D2R)]); });
  hd.on('dragend', (ev) => { const b = Math.round(bearing(ev.target.getLatLng())); moved(`features/${f.id}`, { facing: b }, `${f.name} now faces ${P.compass(b)} (${b}°)`); });
}
/* which way animals walk past a camera, from the sightings and photos logged there */
function camTraffic(f) {
  const hs = (S.prop.sightings || []).filter((s) => (s.featureId === f.id || (!s.featureId && s.camName === f.name)) && s.heading != null).map((s) => s.heading)
    .concat(((S.wild && S.wild.events) || []).filter((e) => e.deviceId && e.deviceId === f.deviceId && e.travel != null).map((e) => e.travel));
  if (hs.length < 2) return null;
  const bins = Array(8).fill(0); hs.forEach((h) => bins[Math.round((((h % 360) + 360) % 360) / 45) % 8]++);
  const i = bins.indexOf(Math.max(...bins)); return { deg: i * 45, n: bins[i], total: hs.length };
}
function renderFeatures() {
  G.features.clearLayers();
  feats().forEach((f) => {
    const d = FT[f.type]; if (!d) return;
    const pop = () => {
      let extra = '';
      if (f.type === 'stand') { const sc = S.cones.find((x) => x.st.id === f.id); if (sc) extra = `<br>Scent now: <span class="sbadge s-${sc.cone.status}">${sc.cone.status.toUpperCase()}</span>`; }
      if (f.deviceId) { const dv = (S.devices || []).find((x) => x.id === f.deviceId); if (dv) extra += `<br>${esc([dv.brand, dv.model].filter(Boolean).join(' ') || 'Trail camera')}${dv.battery != null ? ' · battery ' + dv.battery + '%' : ''}${dv.lastChecked ? ' · checked ' + new Date(dv.lastChecked).toLocaleDateString() : ''}`; }
      return `<h4>${d.icon} ${esc(f.name)}</h4><span class="mono sm">${d.label}${f.kind === 'point' ? ' · drag to move' : ''}${f.type === 'camera' || f.type === 'stand' ? '<br>Use ROTATE in the menu (bottom left) to turn it' + (f.facing != null ? ' (facing ' + P.compass(f.facing) + ')' : '') : ''}</span>${f.notes ? '<br>' + esc(f.notes) : ''}${extra}<br><button class="pbtn" data-del="${f.id}">DELETE</button>`;
    };
    let lyr;
    if (f.kind === 'point') lyr = L.marker(f.coords[0], { icon: featIcon(f), title: f.name, draggable: true }).on('dragend', (ev) => moved(`features/${f.id}`, { coords: [[ev.target.getLatLng().lat, ev.target.getLatLng().lng]] }, f.name));
    else if (f.kind === 'polygon') {
      if (f.type !== 'boundary') L.polygon(latlngs(f), { stroke: false, fillColor: f.color || d.color, fillOpacity: f.wet ? 0.38 : d.fill, interactive: false }).addTo(G.features);
      if (f.type === 'boundary') L.polygon(latlngs(f), { color: '#000', weight: 7, opacity: 0.6, fill: false, interactive: false }).addTo(G.features); // dark casing so the red line reads on any imagery
      lyr = L.polygon(latlngs(f), { color: f.color || d.color, weight: f.type === 'boundary' ? 3.5 : 2, fill: false, dashArray: d.dash }); // outline only is clickable
    }
    else lyr = L.polyline(latlngs(f), { color: d.color, weight: 3, dashArray: d.dash, opacity: 0.9 });
    lyr.bindPopup(pop).addTo(G.features);
    if (f.kind === 'point') lyr.on('click', () => selectFeat(f));
    if (f.kind !== 'point' && f.type !== 'boundary' && f.type !== 'buffer') lyr.bindTooltip(f.name, { sticky: true });
  });
}
map.on('popupopen', (e) => {
  const b = e.popup.getElement().querySelector('[data-del]');
  if (b) b.onclick = async () => { const ft = feats().find((x) => x.id === b.dataset.del); if (ft && (ft.type === 'boundary' || ft.type === 'water') && !confirm(`Delete "${ft.name}"? This removes the property outline.`)) return; await api(`/properties/${S.activeId}/features/${b.dataset.del}`, { method: 'DELETE' }); map.closePopup(); await refresh(); };
  const s = e.popup.getElement().querySelector('[data-delsight]');
  if (s) s.onclick = async () => { await api(`/properties/${S.activeId}/sightings/${s.dataset.delsight}`, { method: 'DELETE' }); map.closePopup(); await refresh(); };
});

['board', 'chat'].forEach((id) => {
  const el = document.getElementById(id), key = 'panel_' + id;
  el.classList.toggle('collapsed', !!store(key));
  el.querySelector('.ph h2').onclick = () => { el.classList.toggle('collapsed'); store(key, el.classList.contains('collapsed')); };
});
document.querySelectorAll('.fsec').forEach((sec) => {
  const k = 'sec_' + sec.dataset.sec, def = !['hunt', 'walks'].includes(sec.dataset.sec), v = store(k);
  sec.classList.toggle('closed', v == null ? def : !!v);
  sec.querySelector('h3').onclick = () => { sec.classList.toggle('closed'); store(k, sec.classList.contains('closed')); };
});

/* ---------- my scouting walks: tap points of interest, I map the walk in and back out, lock it in ---------- */
const walkArrows = (pts, g, col) => { let acc = 0; for (let i = 1; i < pts.length; i++) { acc += P.distM(pts[i - 1], pts[i]); if (acc > 55) { acc = 0; L.marker(pts[i], { icon: L.divIcon({ className: '', html: `<div class="sarrow" style="color:${col};transform:rotate(${P.bearing(pts[i - 1], pts[i])}deg)">&#9650;</div>`, iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false, keyboard: false }).addTo(g); } } };
function drawWalk(g, w, draft) {
  const col = '#2DD4BF';
  L.polyline(w.pts, { color: '#000', weight: 8, opacity: 0.5, interactive: false }).addTo(g);
  L.polyline(w.pts, { color: col, weight: 4, opacity: 0.95, dashArray: draft ? '3 8' : '9 7', interactive: false }).addTo(g);
  walkArrows(w.pts, g, col);
  L.marker(w.start, { icon: L.divIcon({ className: '', html: '<div class="wflag">&#9873; START / OUT</div>', iconSize: [96, 22], iconAnchor: [10, 11] }), zIndexOffset: 900 }).addTo(g);
  if (!draft) (w.findings || []).forEach((f) => {
    const m = L.marker(f.coords, { icon: L.divIcon({ className: '', html: `<div class="wfind">${FIND[f.type][0]}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 960 }).addTo(g);
    m.bindPopup(`<h4>${FIND[f.type][0]} ${FIND[f.type][1]}</h4>${f.note ? esc(f.note) + '<br>' : ''}<span class="sm">${esc(w.name)} \u00B7 ${new Date(f.ts).toLocaleDateString()}</span><br><button class="pbtn" data-delfind="${f.id}">REMOVE</button>`);
    m.on('popupopen', (ev) => { const b = ev.popup.getElement().querySelector('[data-delfind]'); if (b) b.onclick = () => { S.jw = w.id; delFinding(f.id); }; });
  });
  (w.points || []).forEach((p, i) => {
    const m = L.marker(p.coords || p, { icon: L.divIcon({ className: '', html: `<div class="wstop">${i + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }), zIndexOffset: 950 }).addTo(g);
    if (!draft) m.bindPopup(`<h4>${esc(w.name)} · point ${i + 1}</h4>${p.note ? esc(p.note) + '<br>' : ''}<button class="pbtn" data-delwalk="${w.id}">REMOVE THIS WALK</button>`);
  });
}
/* ---------- walk journal: open a saved walk and write down / point out what you found ---------- */
const FIND = { bed: ['\u{1F6CF}\uFE0F', 'Bed', 'bedding'], rub: ['\u{1FAB5}', 'Rub', null], scrape: ['\u2B55', 'Scrape', 'scrape'], tracks: ['\u{1F43E}', 'Tracks', null], scat: ['\u{1F4A9}', 'Droppings', null], pinch: ['\u2716\uFE0F', 'Pinch / funnel', 'pinch'], food: ['\u{1F33D}', 'Food', 'food'], deer: ['\u{1F98C}', 'Saw deer', null], stand: ['\u{1FA9C}', 'Stand tree', 'stand'], other: ['\u{1F4CD}', 'Other', null] };
const getWalk = () => ((S.prop && S.prop.walks) || []).find((x) => x.id === S.jw);
function journalOpen(wid) {
  const w = ((S.prop && S.prop.walks) || []).find((x) => x.id === wid); if (!w) return;
  S.jw = wid; S.jadd = null; if (S.walk) cancelWalk(); setView('show-map'); map.fitBounds(L.latLngBounds(w.pts).pad(0.3), { maxZoom: 18 }); renderJournal();
}
function journalClose() { S.jw = null; S.jadd = null; if (typeof map !== 'undefined') map.getContainer().style.cursor = ''; const el = $('#jcard'); if (el) el.classList.add('hidden'); }
function renderJournal() {
  const w = getWalk(); if (!w) return journalClose();
  const el = $('#jcard'), fs = w.findings || [];
  el.classList.remove('hidden');
  el.innerHTML = `<div class="jh"><b>${esc(w.name)}</b><button class="btn" id="jX">DONE</button></div>
    <label>WHAT I SAW</label><textarea id="jNotes" rows="3" placeholder="Write down what you saw, what the woods looked like, anything for next time\u2026">${esc(w.notes || '')}</textarea>
    <div class="jt">${S.jadd ? `<b>Tap the map where the ${esc(FIND[S.jadd][1].toLowerCase())} is</b> (or use GPS below)` : 'MARK SOMETHING YOU FOUND:'}</div>
    <div class="jtypes">${Object.entries(FIND).map(([k, v]) => `<button class="btn${S.jadd === k ? ' red' : ''}" data-ft="${k}">${v[0]} ${v[1]}</button>`).join('')}</div>
    <button class="btn" id="jGps">&#128205; PUT IT WHERE I\u2019M STANDING</button>
    <div class="jl">${fs.map((f) => `<div class="jrow" data-fid="${f.id}"><span>${FIND[f.type][0]}</span><div class="jm">${esc(f.note || FIND[f.type][1])}<div class="sm">${FIND[f.type][1]} \u00B7 ${new Date(f.ts).toLocaleDateString()}</div></div><button class="btn" data-fx="${f.id}" title="Remove">\u2715</button></div>`).join('') || '<div class="sm">Nothing marked yet.</div>'}</div>`;
  $('#jX').onclick = journalClose;
  $('#jNotes').onblur = async (e) => { if (e.target.value === (w.notes || '')) return; try { await api(`/properties/${S.activeId}/walks/${w.id}`, { method: 'PUT', body: { notes: e.target.value } }); w.notes = e.target.value; toast('Saved', true); } catch (err) { toast(err.message); } };
  el.querySelectorAll('[data-ft]').forEach((b) => (b.onclick = () => { S.jadd = S.jadd === b.dataset.ft ? null : b.dataset.ft; map.getContainer().style.cursor = S.jadd ? 'crosshair' : ''; renderJournal(); }));
  $('#jGps').onclick = () => {
    if (!S.jadd) return toast('Pick what you found first');
    if (!navigator.geolocation) return toast('This device cannot give a location');
    navigator.geolocation.getCurrentPosition((p) => addFinding({ lat: p.coords.latitude, lng: p.coords.longitude }), () => toast('Could not get your location. Tap the map instead.'), { enableHighAccuracy: true, timeout: 15000 });
  };
  el.querySelectorAll('[data-fx]').forEach((b) => (b.onclick = () => delFinding(b.dataset.fx)));
  el.querySelectorAll('.jrow').forEach((r) => (r.querySelector('.jm').onclick = () => { const f = (w.findings || []).find((x) => x.id === r.dataset.fid); if (f) map.setView(f.coords, 19); }));
}
function askNote(title) {
  return new Promise((res) => {
    modal(`<h3>${esc(title)}</h3><label>NOTE (optional)</label><textarea id="nt" rows="3" placeholder="Size, how fresh, which way it was going\u2026"></textarea><div class="foot"><button class="btn" id="c">CANCEL</button><button class="btn red" id="o">SAVE</button></div>`,
      (m, close) => { const t = $('#nt', m); t.focus(); $('#c', m).onclick = () => { close(); res(null); }; $('#o', m).onclick = () => { close(); res(t.value.trim()); }; });
  });
}
const circle = (c, r) => Array.from({ length: 12 }, (_, i) => { const t = i / 12 * 2 * Math.PI; return P.offset(c[0], c[1], Math.sin(t) * r, Math.cos(t) * r); });
async function addFinding(ll) {
  const w = getWalk(), type = S.jadd; if (!w || !type) return;
  const lat = ll.lat, lng = ll.lng, note = await askNote(`${FIND[type][1]}`); if (note === null) return;
  const f = { id: 'fd' + Math.random().toString(36).slice(2, 9), type, coords: [lat, lng], note, ts: Date.now() };
  const ft = FIND[type][2];
  try {
    if (ft) {
      const poly = ft === 'bedding' || ft === 'food';
      const nf = await api(`/properties/${S.activeId}/features`, { method: 'POST', body: { type: ft, kind: poly ? 'polygon' : 'point', name: `${FIND[type][1]} (walk)`, coords: poly ? circle([lat, lng], ft === 'food' ? 15 : 12) : [[lat, lng]], notes: note } });
      f.featureId = nf.id;
    }
    await api(`/properties/${S.activeId}/walks/${w.id}`, { method: 'PUT', body: { findings: (w.findings || []).concat(f) } });
    S.jadd = null; map.getContainer().style.cursor = ''; await refresh(); toast(ft ? `${FIND[type][1]} saved and added to your map` : `${FIND[type][1]} saved to the walk`, true);
  } catch (e) { toast(e.message); }
}
async function delFinding(fid) {
  const w = getWalk(); if (!w) return; const f = (w.findings || []).find((x) => x.id === fid); if (!f) return;
  try {
    if (f.featureId) await api(`/properties/${S.activeId}/features/${f.featureId}`, { method: 'DELETE' }).catch(() => {});
    await api(`/properties/${S.activeId}/walks/${w.id}`, { method: 'PUT', body: { findings: w.findings.filter((x) => x.id !== fid) } }); map.closePopup(); await refresh();
  } catch (e) { toast(e.message); }
}
function renderWalks() {
  G.walks.clearLayers();
  const ws = (S.prop && S.prop.walks) || [];
  ws.forEach((w) => drawWalk(G.walks, w, false));
  $('#walkList').innerHTML = ws.length ? ws.map((w) => `<div class="walkrow"><div class="wn"><b>${esc(w.name)}</b><div class="sm">${w.points.length} points · ${Math.round(w.distM * 3.28)} ft · ~${w.minutes} min${(w.findings || []).length ? ' · ' + w.findings.length + ' found' : ''}${w.notes ? ' · notes' : ''}</div></div><button class="btn green" data-jwalk="${w.id}">JOURNAL</button><button class="btn" data-viewwalk="${w.id}">SHOW</button><button class="btn red" data-delwalk="${w.id}">&#128465;</button></div>`).join('') : '<div class="sm" style="padding:2px 12px">No saved walks yet. Press MY WALK, tap your points of interest, then LOCK IT IN.</div>';
  $('#walkList').querySelectorAll('[data-viewwalk]').forEach((b) => (b.onclick = () => { const w = ws.find((x) => x.id === b.dataset.viewwalk); if (w) { setView('show-map'); map.fitBounds(L.latLngBounds(w.pts).pad(0.3), { maxZoom: 18 }); } }));
  $('#walkList').querySelectorAll('[data-jwalk]').forEach((b) => (b.onclick = () => journalOpen(b.dataset.jwalk)));
  $('#walkList').querySelectorAll('[data-delwalk]').forEach((b) => (b.onclick = () => delWalk(b.dataset.delwalk)));
}
async function delWalk(id) { if (!confirm('Delete this saved walk?')) return; await api(`/properties/${S.activeId}/walks/${id}`, { method: 'DELETE' }); map.closePopup(); await refresh(); }
function cancelWalk() { S.walk = null; G.walkDraft.clearLayers(); $('#walkbar').classList.add('hidden'); map.getContainer().style.cursor = ''; }
function startWalk() {
  if (!S.prop || S.pm) return; if (S.tool) cancelDraw(); deselect();
  S.walk = { points: [], route: null }; setView('show-map'); map.getContainer().style.cursor = 'crosshair'; walkBar(); toast('Tap the map where you want to stop. I will map the walk.', true);
}
async function walkRefresh() {
  G.walkDraft.clearLayers();
  if (!S.walk.points.length) { S.walk.route = null; return walkBar(); }
  try {
    S.walk.route = await api(`/properties/${S.activeId}/walk/route`, { method: 'POST', body: { points: S.walk.points.map((p) => p.coords) } });
    drawWalk(G.walkDraft, { ...S.walk.route, points: S.walk.points, name: 'Draft' }, true);
  } catch (e) { toast(e.message); }
  walkBar();
}
function walkBar() {
  const bar = $('#walkbar'), w = S.walk; if (!w) return bar.classList.add('hidden');
  bar.classList.remove('hidden');
  const r = w.route;
  bar.innerHTML = `<span>&#129406; <b>My walk</b>: ${w.points.length} point${w.points.length === 1 ? '' : 's'}${r ? ` · ${Math.round(r.distM * 3.28)} ft · ~${r.minutes} min` : ' · tap the map to add a stop'}${r && r.warnings.length ? `<br><span style="color:#FCD34D">${esc(r.warnings.join(' '))}</span>` : ''}</span><button class="btn" id="wU" ${w.points.length ? '' : 'disabled'}>UNDO</button><button class="btn green" id="wL" ${w.points.length ? '' : 'disabled'}>LOCK IT IN</button><button class="btn" id="wX">CANCEL</button>`;
  $('#wU').onclick = () => { w.points.pop(); walkRefresh(); };
  $('#wX').onclick = cancelWalk;
  $('#wL').onclick = async () => {
    const nm = await askName('Name this walk', 'Scouting walk ' + (((S.prop.walks || []).length) + 1)); if (!nm) return;
    try { await api(`/properties/${S.activeId}/walks`, { method: 'POST', body: { name: nm, start: r.start, pts: r.pts, points: w.points, distM: r.distM, minutes: r.minutes } }); cancelWalk(); await refresh(); toast('Walk locked in', true); } catch (e) { toast(e.message); }
  };
}
async function walkClick(e) { S.walk.points.push({ coords: [e.latlng.lat, e.latlng.lng], note: '' }); await walkRefresh(); }


/* ---------- scout walk: I suggest the points of interest, you tick the ones you want, I map the walk in and back out ---------- */
const PK = { stand: ['#EF4444', 'Place a stand'], camera: ['#38BDF8', 'Camera'], bed: ['#F59E0B', 'Look from a distance'], route: ['#4ADE80', 'Spot of interest'] };
function closePick() { S.pick = null; G.walkDraft.clearLayers(); $('#pickcard').classList.add('hidden'); }
async function startPick() {
  if (!S.prop || S.pm) return; cancelWalk(); if (S.tool) cancelDraw(); deselect(); G.ai.clearLayers();
  toast('Finding places worth checking…', true);
  try {
    const r = await api(`/properties/${S.activeId}/scout?mode=candidates`, { method: 'POST', body: {} });
    const sel = new Set(r.candidates.filter((c) => c.kind !== 'bed').slice(0, 4).map((c) => c.id));
    S.pick = { ...r, sel, built: null }; setView('show-map'); drawPick(); pickCard();
    map.fitBounds(L.latLngBounds(r.candidates.map((c) => c.coords).concat([r.start])).pad(0.3), { maxZoom: 18 });
  } catch (e) { toast(e.message); }
}
function drawPick() {
  const p = S.pick; if (!p) return; G.walkDraft.clearLayers();
  if (p.built) drawWalk(G.walkDraft, { ...p.built, points: p.built.stops.map((s) => ({ coords: s.coords })), name: 'Walk' }, true);
  else L.marker(p.start, { icon: L.divIcon({ className: '', html: '<div class="wflag">&#9873; START / OUT</div>', iconSize: [96, 22], iconAnchor: [10, 11] }), interactive: false, zIndexOffset: 900 }).addTo(G.walkDraft);
  if (p.built) return;
  p.candidates.forEach((c) => {
    const k = (PK[c.kind] || PK.route)[0], on = p.sel.has(c.id);
    L.marker(c.coords, { icon: L.divIcon({ className: '', html: `<div class="pcand ${on ? 'on' : ''}" style="--k:${k}">${c.n}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 950 })
      .bindTooltip(`${c.n}. ${esc(c.name)}`, { direction: 'top', offset: [0, -12] }).on('click', () => { on ? p.sel.delete(c.id) : p.sel.add(c.id); drawPick(); pickCard(); }).addTo(G.walkDraft);
  });
}
function pickCard() {
  const p = S.pick, el = $('#pickcard'); if (!p) return el.classList.add('hidden');
  el.classList.remove('hidden');
  const tipHtml = (p.tips || []).slice(0, 3).map((t) => `<li>${esc(t)}</li>`).join('');
  if (p.built) {
    const b = p.built;
    el.innerHTML = `<h3>&#129406; Your walk</h3><div class="sm">${Math.round(b.distM * 3.28)} ft · about ${b.minutes} min · in and back out${p.startAssumed ? ' · start guessed (add My Start)' : ''}</div>
      ${b.warnings.length ? `<div class="sm" style="color:#FCD34D">${esc(b.warnings.join(' '))}</div>` : ''}
      <h5>IN THIS ORDER</h5>${b.stops.map((s, i) => `<div class="prow" style="cursor:default"><span class="pbadge" style="--k:${(PK[s.kind] || PK.route)[0]}">${i + 1}</span><div><b>${esc(s.name)}</b><span class="sm">${esc(s.why)}</span><details open><summary>Look for</summary><ul style="margin:2px 0 0 16px;padding:0">${s.look.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>${s.wind ? `<span class="sm" style="color:#FCD34D">${esc(s.wind)}</span>` : ''}</div></div>`).join('')}
      <h5>HOW TO WALK IT</h5><ul>${tipHtml}</ul>
      <div class="acts"><button class="btn green" id="pkLock">LOCK IT IN</button><button class="btn" id="pkBack">CHANGE STOPS</button><button class="btn" id="pkX">CLOSE</button></div>`;
    $('#pkBack').onclick = () => { p.built = null; drawPick(); pickCard(); };
    $('#pkX').onclick = closePick;
    $('#pkLock').onclick = async () => {
      const nm = await askName('Name this walk', 'Scouting walk ' + (((S.prop.walks || []).length) + 1)); if (!nm) return;
      try { await api(`/properties/${S.activeId}/walks`, { method: 'POST', body: { name: nm, start: b.start, pts: b.pts, points: b.stops.map((s) => ({ coords: s.coords, note: s.name + ': ' + s.why })), distM: b.distM, minutes: b.minutes } }); closePick(); await refresh(); toast('Walk locked in', true); } catch (e) { toast(e.message); }
    };
    return;
  }
  el.innerHTML = `<h3>&#129406; Where do you want to check?</h3><div class="sm">Tick the places you want to visit (or tap the numbers on the map). I will map the walk in and back out.${p.startAssumed ? ' <b>No Start marker yet</b>, so I guessed where you begin; click the map and add My Start for the real one.' : ''}</div>
    ${p.candidates.map((c) => `<label class="prow"><input type="checkbox" data-pc="${c.id}" ${p.sel.has(c.id) ? 'checked' : ''}><span class="pbadge" style="--k:${(PK[c.kind] || PK.route)[0]}">${c.n}</span><div><b>${esc(c.name)}</b><span class="sm" style="color:${(PK[c.kind] || PK.route)[0]}">${(PK[c.kind] || PK.route)[1]}</span><span class="sm">${esc(c.why)}</span><details><summary>What to look for</summary><ul style="margin:2px 0 0 16px;padding:0">${c.look.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details></div></label>`).join('')}
    <div class="acts"><button class="btn green" id="pkBuild" ${p.sel.size ? '' : 'disabled'}>MAP MY WALK (${p.sel.size})</button><button class="btn" id="pkX">CANCEL</button></div>`;
  el.querySelectorAll('[data-pc]').forEach((i) => (i.onchange = () => { i.checked ? p.sel.add(i.dataset.pc) : p.sel.delete(i.dataset.pc); drawPick(); pickCard(); }));
  $('#pkX').onclick = closePick;
  $('#pkBuild').onclick = async () => {
    const chosen = p.candidates.filter((c) => p.sel.has(c.id));
    try {
      const r = await api(`/properties/${S.activeId}/walk/route`, { method: 'POST', body: { points: chosen.map((c) => c.coords), reorder: true } });
      p.built = { ...r, stops: r.order.map((i) => chosen[i]) }; drawPick(); pickCard(); map.fitBounds(L.latLngBounds(r.pts).pad(0.25), { maxZoom: 18 });
    } catch (e) { toast(e.message); }
  };
}

/* ---------- AI drawings: animated deer herds, labelled spots, walk-in routes ---------- */

const aiLen = (pts) => pts.slice(1).reduce((t, p, i) => t + P.distM(pts[i], p), 0);
function aiAt(pts, cum, total, f) {
  const d = f * total; let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1, k = Math.min(1, Math.max(0, (d - cum[i - 1]) / seg)), a0 = pts[i - 1], b0 = pts[i];
  return { ll: [a0[0] + (b0[0] - a0[0]) * k, a0[1] + (b0[1] - a0[1]) * k], dx: b0[1] - a0[1] };
}
function renderAI() {
  G.ai.clearLayers();
  const ovs = (S.prop && S.prop.overlays) || [], bar = $('#aibar');
  if (!ovs.length) { bar.classList.add('hidden'); return; }
  let hn = 0;
  ovs.forEach((o) => {
    const col = o.color || '#F472B6';
    if (o.kind === 'herd' && o.pts.length > 1) {
      L.polyline(o.pts, { color: col, weight: 6, opacity: 0.18, interactive: false }).addTo(G.ai);
      L.polyline(o.pts, { color: '#fff', weight: 1.5, opacity: 0.55, dashArray: '2 7', interactive: false }).addTo(G.ai);
      const hit = L.polyline(o.pts, { weight: 24, opacity: 0, className: 'hitline' }).addTo(G.ai);
      hit.bindPopup(`<h4>&#129420; ${esc(o.name)}</h4>${esc(o.note || '')}<br><button class="pbtn" data-delov="${o.id}">REMOVE</button>`);
      const end = o.pts[o.pts.length - 1];
      for (let n = 0; n < o.count; n++) {
        const ang = n * 2.4, rad = n ? 4 + (n % 3) * 3 : 0, pos = P.offset(end[0], end[1], Math.sin(ang) * rad, Math.cos(ang) * rad);
        L.marker(pos, { icon: L.divIcon({ className: '', html: '<div class="deer">&#129420;</div>', iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false, keyboard: false, zIndexOffset: 500 + n }).addTo(G.ai);
      }
      L.marker(o.pts[Math.floor(o.pts.length / 2)], { icon: L.divIcon({ className: '', html: '', iconSize: [1, 1] }), interactive: false }).bindTooltip(`${o.count} deer · ${esc(o.name)}`, { permanent: true, direction: 'top', className: 'ai-label', offset: [0, -10 - (hn++) * 20] }).addTo(G.ai);
    } else if (o.kind === 'scout' && o.pts.length > 1) {
      L.polyline(o.pts, { color: '#000', weight: 8, opacity: 0.5, interactive: false }).addTo(G.ai);
      L.polyline(o.pts, { color: '#4ADE80', weight: 4, opacity: 0.95, dashArray: '9 7', interactive: false }).addTo(G.ai);
      let acc = 0;
      for (let i = 1; i < o.pts.length; i++) { acc += P.distM(o.pts[i - 1], o.pts[i]); if (acc > 55) { acc = 0; const br = P.bearing(o.pts[i - 1], o.pts[i]); L.marker(o.pts[i], { icon: L.divIcon({ className: '', html: `<div class="sarrow" style="transform:rotate(${br}deg)">&#9650;</div>`, iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false, keyboard: false }).addTo(G.ai); } }
      L.marker(o.start, { icon: L.divIcon({ className: '', html: '<div class="sflag">&#9873; START</div>', iconSize: [64, 22], iconAnchor: [10, 11] }), zIndexOffset: 900 }).bindPopup(`<h4>Start here</h4>${o.startAssumed ? 'I guessed this spot (nearest edge of the land to a road or house). Click the map and add <b>My Start</b> where you really begin, then ask me again.' : 'Your start marker.'}<br><b>${Math.round(o.distM * 3.28)} ft, about ${o.minutes} min.</b>`).addTo(G.ai);
      const KIND = { stand: ['&#127919; PLACE A STAND HERE', '#EF4444'], camera: ['Check camera', '#38BDF8'], bed: ['Stop and look (do not walk in)', '#F59E0B'], route: ['Spot of interest', '#4ADE80'] };
      (o.stops || []).forEach((st, si) => {
        const [lab, colr] = KIND[st.kind] || KIND.route, big = st.kind === 'stand';
        L.marker(st.coords, { icon: L.divIcon({ className: '', html: big ? `<div class="starget"><b>${st.n}</b></div>` : `<div class="sstop" style="background:${colr}">${st.n}</div>`, iconSize: big ? [44, 44] : [26, 26], iconAnchor: big ? [22, 22] : [13, 13] }), zIndexOffset: big ? 990 : 950 })
          .bindPopup(`<h4>${big ? '&#127919; ' : ''}Stop ${st.n}: ${esc(st.name)}</h4><span class="mono sm" style="color:${colr}">${lab}</span><br>${esc(st.why)}<br><b>Look for:</b><ul style="margin:3px 0 3px 16px;padding:0">${st.look.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${st.wind ? `<span style="color:#FCD34D">${esc(st.wind)}</span><br>` : ''}${big ? `<button class="pbtn" data-addstand="${o.id}:${si}">ADD A STAND HERE</button> ` : ''}<button class="pbtn" data-delov="${o.id}">REMOVE WALK</button>`, { maxWidth: 280 })
          .bindTooltip(`${st.n}. ${esc(st.name)}`, { direction: 'top', offset: [0, big ? -22 : -12] }).addTo(G.ai);
      });
    } else if (o.kind === 'route' && o.pts.length > 1) {
      L.polyline(o.pts, { color: '#000', weight: 8, opacity: 0.5, interactive: false }).addTo(G.ai);
      const ln = L.polyline(o.pts, { color: col, weight: 4, dashArray: '10 8', className: 'trail' }).addTo(G.ai);
      ln.bindPopup(`<h4>${esc(o.name)}</h4>${esc(o.note || '')}<br><button class="pbtn" data-delov="${o.id}">REMOVE</button>`);
      L.circleMarker(o.pts[o.pts.length - 1], { radius: 6, color: col, fillColor: col, fillOpacity: 1 }).bindTooltip(esc(o.name), { permanent: true, direction: 'top', className: 'ai-label' }).addTo(G.ai);
    } else if (o.kind === 'zone') {
      L.circle(o.pts[0], { radius: o.radius || 40, color: col, weight: 2, fillColor: col, fillOpacity: 0.18, dashArray: '6 6' }).bindPopup(`<h4>${esc(o.name)}</h4>${esc(o.note || '')}<br><button class="pbtn" data-delov="${o.id}">REMOVE</button>`).bindTooltip(esc(o.name), { permanent: true, direction: 'center', className: 'ai-label' }).addTo(G.ai);
    } else {
      L.marker(o.pts[0], { icon: L.divIcon({ className: '', html: `<div class="aipulse" style="--c:${col}"></div>`, iconSize: [34, 34], iconAnchor: [17, 17] }), zIndexOffset: 900 }).bindPopup(`<h4>${esc(o.name)}</h4>${esc(o.note || '')}<br><button class="pbtn" data-delov="${o.id}">REMOVE</button>`).bindTooltip(esc(o.name), { permanent: true, direction: 'top', className: 'ai-label', offset: [0, -14] }).addTo(G.ai);
    }
  });
  const herds = ovs.filter((o) => o.kind === 'herd').length, scout = ovs.find((o) => o.kind === 'scout');
  bar.classList.remove('hidden');
  bar.innerHTML = `<span>${scout ? '&#129406; Scouting walk · ' + Math.round(scout.distM * 3.28) + ' ft · ~' + scout.minutes + ' min' : '&#129420; AI drawings: ' + (herds ? herds + ' deer route' + (herds > 1 ? 's' : '') : ovs.length + ' item' + (ovs.length > 1 ? 's' : ''))}</span><button class="btn" id="aiFit">SHOW ME</button><button class="btn" id="aiClr">CLEAR</button>`;
  if (scout) {
    const lk = document.createElement('button'); lk.className = 'btn green'; lk.textContent = 'LOCK IN THIS WALK'; lk.onclick = async () => {
      try { await api(`/properties/${S.activeId}/walks`, { method: 'POST', body: { name: 'Scouting walk ' + (((S.prop.walks || []).length) + 1), start: scout.start, pts: scout.pts, points: scout.stops.map((s) => ({ coords: s.coords, note: s.name + ': ' + s.why })), distM: scout.distM, minutes: scout.minutes } }); await api(`/properties/${S.activeId}/overlays/${scout.id}`, { method: 'DELETE' }); await refresh(); toast('Walk locked in. Find it under My Scouting Walks.', true); } catch (e) { toast(e.message); }
    };
    bar.insertBefore(lk, bar.firstElementChild.nextSibling);
  }
  $('#aiClr').onclick = async () => { await api(`/properties/${S.activeId}/overlays`, { method: 'DELETE' }); await refresh(); };
  $('#aiFit').onclick = fitAI;
}
function fitAI() {
  const pts = ((S.prop && S.prop.overlays) || []).flatMap((o) => o.pts);
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 18, duration: 0.6 });
}
map.on('popupopen', (e) => {
  const dw = e.popup.getElement().querySelector('[data-delwalk]');
  if (dw) dw.onclick = () => delWalk(dw.dataset.delwalk);
  const as = e.popup.getElement().querySelector('[data-addstand]');
  if (as) as.onclick = async () => {
    const [oid, i] = as.dataset.addstand.split(':'), st = ((S.prop.overlays || []).find((o) => o.id === oid) || {}).stops[Number(i)]; if (!st) return;
    try { await api(`/properties/${S.activeId}/features`, { method: 'POST', body: { type: 'stand', kind: 'point', name: 'Stand ' + (feats('stand').length + 1), coords: [st.coords], notes: st.why } }); map.closePopup(); await refresh(); toast('Stand added', true); } catch (err) { toast(err.message); }
  };
  const b = e.popup.getElement().querySelector('[data-delov]');
  if (b) b.onclick = async () => { await api(`/properties/${S.activeId}/overlays/${b.dataset.delov}`, { method: 'DELETE' }); map.closePopup(); await refresh(); };
});

/* ---------- sightings, strings ---------- */
const buckOf = (id) => (S.prop.bucks.find((b) => b.id === id) || { color: '#94A3B8', name: 'Unknown' });
const visSight = () => S.prop.sightings.filter((s) => !S.filter || S.filter === s.animalId);
function renderSightings() {
  G.sightings.clearLayers(); G.trails.clearLayers();
  const list = visSight();
  const byAnimal = {};
  list.forEach((s) => (byAnimal[s.animalId] = byAnimal[s.animalId] || []).push(s));
  Object.entries(byAnimal).forEach(([id, arr]) => {
    arr.sort((a, b) => a.ts - b.ts);
    const col = buckOf(id).color;
    if (arr.length > 1) {
      const pts = arr.map((s) => [s.lat, s.lng]);
      L.polyline(pts, { color: col, weight: 7, opacity: 0.12, interactive: false }).addTo(G.trails);
      L.polyline(pts, { color: col, weight: 2, opacity: 0.85, dashArray: '2 5', className: 'trail', interactive: false }).addTo(G.trails);
    }
  });
  list.forEach((s) => {
    const col = buckOf(s.animalId).color;
    if (s.heading != null && s.behavior !== 'Bedding') {
      const to = P.offset(s.lat, s.lng, 22 * Math.sin(s.heading * P.D2R), 22 * Math.cos(s.heading * P.D2R));
      L.polyline([[s.lat, s.lng], to], { color: col, weight: 2, opacity: 0.6, interactive: false }).addTo(G.trails);
    }
    L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', html: `<div class="sn" style="--c:${col}">${s.num}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }), zIndexOffset: 200, draggable: true })
      .on('dragend', (ev) => moved(`sightings/${s.id}`, { lat: ev.target.getLatLng().lat, lng: ev.target.getLatLng().lng }, 'Sighting #' + s.num))
      .bindPopup(sightPopup(s)).addTo(G.sightings).sightId = s.id;
  });
}
function sightPopup(s) {
  const w = s.wx || {};
  return `<h4>#${s.num} ${esc(s.animal)}</h4><span class="mono sm">${dstr(s.ts)} ${hm(s.ts)} · ${esc(s.camName || '')}</span><br><b>${esc(s.behavior)}</b>${s.heading != null ? ' → ' + P.compass(s.heading) + ' ' + s.heading + '°' : ''}
    ${s.photo ? `<img src="${esc(s.photo)}">` : ''}${s.note ? '<br>' + esc(s.note) : ''}<br><span class="mono sm">${w.tempF != null ? Math.round(w.tempF) + '°F · ' + w.pressureInHg + ' inHg · ' + P.compass(w.windDir) + ' ' + Math.round(w.windMph) + ' mph' : ''}</span><br><button class="pbtn" data-delsight="${s.id}">DELETE</button>`;
}

/* ---------- red target pins ---------- */
function renderPins() {
  G.pins.clearLayers();
  S.prop.pins.forEach((p) => {
    const sel = S.selPin === p.id;
    L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: `<div class="redpin ${sel ? 'sel' : ''}"><b></b></div>`, iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 1000, title: p.title, draggable: true })
      .on('dragend', (ev) => moved(`pins/${p.id}`, { lat: ev.target.getLatLng().lat, lng: ev.target.getLatLng().lng }, 'Pin'))
      .on('click', () => openPin(p.id)).addTo(G.pins);
  });
}
function openPin(id, fly) {
  const p = S.prop.pins.find((x) => x.id === id); if (!p) return;
  S.selPin = id; renderPins(); G.route.clearLayers();
  if (fly) map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 18), { duration: 0.8 });
  const st = p.standId && S.prop.features.find((f) => f.id === p.standId);
  const acc = st && S.prop.features.find((f) => f.id === st.accessId);
  if (acc) { L.polyline(acc.coords, { color: '#34D399', weight: 6, opacity: 0.25, interactive: false }).addTo(G.route); L.polyline(acc.coords, { color: '#34D399', weight: 3, dashArray: '2 8', interactive: false, className: 'trail' }).addTo(G.route); }
  const c = p.conditions || {};
  const sc = S.cones.find((x) => x.st.id === p.standId);
  const scent = (sc && sc.cone) || p.scent;
  const box = (l, v, w) => v ? `<div class="${w || ''}"><small>${l}</small><span>${esc(v)}</span></div>` : '';
  $('#pincard').innerHTML = `<h3><span class="rd"></span>${esc(p.title)}</h3>
    <div class="src">${p.source === 'mcp' ? 'PLACED BY MCP AI CLIENT' : p.source === 'advisor' ? 'PLACED BY ADVISOR' : 'PLACED BY YOU'} · ${dstr(p.ts)} ${hm(p.ts)}</div>
    <h5>IDEAL TIME CONDITIONS</h5>
    <div class="cgrid">${box('WINDOW', c.window, 'wide')}${box('BAROMETER', c.barometer)}${box('WIND', c.wind)}${box('TEMP', c.temp)}${scent ? `<div><small>SCENT NOW</small><span class="sbadge s-${scent.status}">${scent.status.toUpperCase()}</span></div>` : ''}</div>
    ${(p.why || []).length ? `<h5>WHY ATTACK HERE</h5><ul>${p.why.map((w) => `<li>${esc(w).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`).join('')}</ul>` : ''}
    ${(p.entryRoute || []).length ? `<h5>STEALTH ENTRY ROUTE</h5><ol>${p.entryRoute.map((w) => `<li>${esc(w)}</li>`).join('')}</ol>` : ''}
    <div class="acts"><button class="btn" id="pcFly">LOCATE</button><button class="btn red" id="pcDel">REMOVE PIN</button><button class="btn" id="pcClose">CLOSE</button></div>`;
  $('#pincard').classList.remove('hidden');
  $('#pcFly').onclick = () => map.flyTo([p.lat, p.lng], 18, { duration: 0.6 });
  $('#pcClose').onclick = closePin;
  $('#pcDel').onclick = async () => { await api(`/properties/${S.activeId}/pins/${p.id}`, { method: 'DELETE' }); closePin(); await refresh(); };
  if (!document.body.classList.contains('show-map')) setView('show-map');
}
function closePin() { S.selPin = null; $('#pincard').classList.add('hidden'); G.route.clearLayers(); if (S.prop) renderPins(); }

/* ---------- bulletin board ---------- */
function renderBoard() {
  const pr = S.prop;
  $('#pinList').innerHTML = pr.pins.length ? `<div class="pinrow"><div class="pinhead">RED TARGET PINS · ${pr.pins.length}</div>${pr.pins.slice().reverse().map((p) => `<div class="pinitem" data-pin="${p.id}"><span class="rd"></span><div>${esc(p.title)}<small>${esc((p.conditions && p.conditions.window) || '')}</small></div></div>`).join('')}</div>` : '';
  $('#pinList').querySelectorAll('[data-pin]').forEach((el) => (el.onclick = () => { openPin(el.dataset.pin, true); }));
  $('#chips').innerHTML = `<div class="chip ${!S.filter ? 'on' : ''}" style="--c:#E5EAF0" data-f="">ALL · ${pr.sightings.length}</div>` +
    pr.bucks.map((b) => `<div class="chip ${S.filter === b.id ? 'on' : ''}" style="--c:${b.color}" data-f="${b.id}" title="${esc(b.desc || '')}"><i></i>${esc(b.name)} · ${pr.sightings.filter((s) => s.animalId === b.id).length}</div>`).join('');
  $('#chips').querySelectorAll('.chip').forEach((el) => (el.onclick = () => { S.filter = el.dataset.f || null; renderBoard(); renderSightings(); }));
  const list = visSight().slice().sort((a, b) => b.ts - a.ts);
  const rank = (id) => { const i = S.order.indexOf(id); return i < 0 ? 1e9 : i; };
  if (S.order.length) list.sort((a, b) => rank(a.id) - rank(b.id) || b.ts - a.ts);
  $('#cards').innerHTML = list.map((s) => {
    const col = buckOf(s.animalId).color, w = s.wx || {};
    return `<div class="card" draggable="true" data-id="${s.id}" style="--c:${col}"><button class="x" data-x="${s.id}" title="Delete">✕</button>
      <div class="row"><div class="thumb" style="${s.photo ? `background-image:url('${esc(s.photo)}')` : ''}">${s.photo ? '' : '&#128247;'}</div><div style="min-width:0">
      <h4><span class="num">${s.num}</span>${esc(s.animal)}</h4>
      <div class="meta"><span class="pill">${esc(s.behavior)}</span>${s.heading != null ? '→ ' + P.compass(s.heading) : ''}<br>${dstr(s.ts)} ${hm(s.ts)} · ${esc(s.camName || '')}<br>${w.pressureInHg != null ? w.pressureInHg + ' inHg · ' + P.compass(w.windDir) + ' ' + Math.round(w.windMph) + ' mph · ' + Math.round(w.tempF) + '°F' : ''}</div></div></div>
      ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}</div>`;
  }).join('') || '<div class="sm" style="padding:10px">No sightings yet. Hit + SIGHTING.</div>';
  const cards = $('#cards');
  cards.querySelectorAll('.card').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.dataset.x) { api(`/properties/${S.activeId}/sightings/${e.target.dataset.x}`, { method: 'DELETE' }).then(refresh); return; }
      const s = pr.sightings.find((x) => x.id === el.dataset.id); map.flyTo([s.lat, s.lng], 19, { duration: 0.6 });
      G.sightings.eachLayer((l) => l.sightId === s.id && setTimeout(() => l.openPopup(), 650));
      if (!document.body.classList.contains('show-map')) setView('show-map');
    };
    el.ondragstart = (e) => { el.classList.add('drag'); e.dataTransfer.setData('text/plain', el.dataset.id); };
    el.ondragend = () => el.classList.remove('drag');
    el.ondragover = (e) => e.preventDefault();
    el.ondrop = (e) => {
      e.preventDefault(); const from = e.dataTransfer.getData('text/plain'), to = el.dataset.id; if (from === to) return;
      const ids = [...cards.querySelectorAll('.card')].map((c) => c.dataset.id);
      ids.splice(ids.indexOf(from), 1); ids.splice(ids.indexOf(to), 0, from);
      S.order = ids; store('order', ids); renderBoard();
    };
  });
  $('#notes').innerHTML = pr.notes.slice().reverse().map((n) => `<div class="note-c"><button class="x" data-n="${n.id}">✕</button>${esc(n.text)}<small>${dstr(n.ts)} ${hm(n.ts)}</small></div>`).join('');
  $('#notes').querySelectorAll('[data-n]').forEach((b) => (b.onclick = async () => { await api(`/properties/${S.activeId}/notes/${b.dataset.n}`, { method: 'DELETE' }); refresh(); }));
}
$('#noteForm').onsubmit = async (e) => {
  e.preventDefault(); const t = $('#noteIn').value.trim(); if (!t) return;
  $('#noteIn').value = ''; await api(`/properties/${S.activeId}/notes`, { method: 'POST', body: { text: t } }); refresh();
};

/* ---------- sighting form ---------- */
function resizeImage(file, max = 1280) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = rej;
    fr.onload = () => { const im = new Image(); im.onerror = rej; im.onload = () => {
      const k = Math.min(1, max / Math.max(im.width, im.height)), cv = document.createElement('canvas'); cv.width = im.width * k; cv.height = im.height * k;
      cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height); res(cv.toDataURL('image/jpeg', 0.82)); }; im.src = fr.result; };
    fr.readAsDataURL(file);
  });
}
function sightingForm(spot, preCam) {
  const pr = S.prop, cams = feats('camera'), here = Array.isArray(spot);
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  modal(`<h3>LOG ANIMAL SIGHTING</h3>
    <div class="two"><div><label>ANIMAL</label><select id="fA">${pr.bucks.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}<option value="__new">+ New animal…</option></select></div>
    <div><label>BEHAVIOR</label><select id="fB">${BEHAVIORS.map((b) => `<option>${b}</option>`).join('')}</select></div></div>
    <div id="newA" class="hidden"><label>NEW ANIMAL NAME / ID</label><input id="fN" placeholder="e.g. Target Buck - Cedar 6-Point"></div>
    <div class="two"><div><label>DATE / TIME (your clock)</label><input type="datetime-local" id="fT" value="${local}"></div>
    <div><label>DIRECTION OF TRAVEL</label><select id="fH"><option value="">Unknown</option>${['N','NE','E','SE','S','SW','W','NW'].map((d, i) => `<option value="${i * 45}">${d} (${i * 45}°)</option>`).join('')}<optgroup label="As the camera sees it (camera must be pointed)"><option value="cam:ltr">Left to right</option><option value="cam:rtl">Right to left</option><option value="cam:toward">Toward the camera</option><option value="cam:away">Away from the camera</option></optgroup></select></div></div>
    <label>LOCATION</label><select id="fC">${here ? '<option value="__here" selected>The spot I clicked</option>' : ''}${cams.map((c) => `<option value="${c.id}" ${c.id === preCam ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="__map">Pick a spot on the map…</option></select>
    <label>TRAIL CAM PHOTO (optional)</label><input type="file" id="fP" accept="image/*">
    <label>FIELD NOTE</label><textarea id="fNote" rows="2"></textarea>
    <div class="foot"><button class="btn" id="c">CANCEL</button><button class="btn red" id="o">PIN IT TO THE BOARD</button></div>`,
  (m, close) => {
    $('#fA', m).onchange = (e) => $('#newA', m).classList.toggle('hidden', e.target.value !== '__new');
    $('#c', m).onclick = close;
    $('#o', m).onclick = async () => {
      try {
        let animalId = $('#fA', m).value, animal;
        if (animalId === '__new') {
          const nm = $('#fN', m).value.trim(); if (!nm) return toast('Name the new animal first');
          const palette = ['#EF4444', '#FF5500', '#38BDF8', '#A3E635', '#E879F9', '#FACC15'];
          const b = await api(`/properties/${S.activeId}/bucks`, { method: 'POST', body: { name: nm, color: palette[pr.bucks.length % palette.length], desc: '' } });
          animalId = b.id; animal = b.name;
        } else animal = pr.bucks.find((b) => b.id === animalId).name;
        let photo = null; const file = $('#fP', m).files[0];
        if (file) photo = (await api('/upload', { method: 'POST', body: { dataUrl: await resizeImage(file) } })).url;
        let hd = null; const hv = $('#fH', m).value;
        if (hv.startsWith('cam:')) { const cm = cams.find((c) => c.id === $('#fC', m).value); if (!cm || cm.facing == null) return toast('Pick the camera, and point it first (select it on the map, press ROTATE)'); hd = (cm.facing + { ltr: 90, rtl: -90, toward: 180, away: 0 }[hv.slice(4)] + 360) % 360; } else if (hv !== '') hd = Number(hv);
        const base = { animalId, animal, behavior: $('#fB', m).value, ts: new Date($('#fT', m).value).getTime() || Date.now(), heading: hd, note: $('#fNote', m).value.trim(), photo };
        const camSel = $('#fC', m).value;
        const send = async (lat, lng, cam) => { await api(`/properties/${S.activeId}/sightings`, { method: 'POST', body: { ...base, lat, lng, camName: cam ? cam.name : 'Field sighting', featureId: cam ? cam.id : null } }); toast('Sighting pinned', true); await refresh(); };
        close();
        if (camSel === '__here') await send(spot[0], spot[1], null);
        else if (camSel === '__map') { toast('Click the map where you saw the animal'); setView('show-map'); map.once('click', (e) => send(e.latlng.lat, e.latlng.lng, null)); }
        else { const cam = cams.find((c) => c.id === camSel); const j = P.offset(cam.coords[0][0], cam.coords[0][1], Math.random() * 10 - 5, Math.random() * 10 - 5); await send(j[0], j[1], cam); }
      } catch (e) { toast(e.message); }
    };
  });
}
$('#addSight').onclick = () => sightingForm();
$('#scoutBtn').onclick = startPick;

/* ---------- drawing tools ---------- */
function renderTools() {
  $('#tools').innerHTML = '<div class="th">SHAPES &#9662;</div>' + Object.entries(FT).map(([k, d]) => `<button class="tbtn ${S.tool === k ? 'on' : ''}" data-t="${k}" style="--c:${d.color}"><i>${d.icon}</i>${d.label}</button>`).join('');
  $('#tools').querySelectorAll('.tbtn').forEach((b) => (b.onclick = () => (S.tool === b.dataset.t ? cancelDraw() : startDraw(b.dataset.t))));
  wireFold('#tools', '.th');
}
function startDraw(t) {
  S.tool = t; S.draw = []; G.draw.clearLayers(); map.getContainer().classList.add('drawing'); renderTools(); map.getContainer().style.cursor = 'crosshair'; map.doubleClickZoom.disable();
  drawBar();
}
function cancelDraw() { map.getContainer().classList.remove('drawing'); S.tool = null; S.draw = []; G.draw.clearLayers(); renderTools(); map.getContainer().style.cursor = ''; map.doubleClickZoom.enable(); $('#drawbar').classList.add('hidden'); }
function drawBar() {
  const d = FT[S.tool], bar = $('#drawbar');
  if (!d) return bar.classList.add('hidden');
  bar.classList.remove('hidden');
  const need = d.kind === 'polygon' ? 3 : 2;
  bar.innerHTML = d.kind === 'point' ? `<span>Click the map to place <b>${d.label}</b>${S.tool === 'house' ? ' (stays on until you press DONE)' : ''}</span><button class="btn" id="dbX">${S.tool === 'house' ? 'DONE' : 'CANCEL'}</button>`
    : `<span>${d.label}: ${S.draw.length} pts. Click to add, double-click or press FINISH.</span><button class="btn green" id="dbF" ${S.draw.length < need ? 'disabled' : ''}>FINISH</button><button class="btn" id="dbU">UNDO</button><button class="btn" id="dbX">CANCEL</button>`;
  $('#dbX').onclick = cancelDraw;
  if ($('#dbF')) { $('#dbF').onclick = finishDraw; $('#dbU').onclick = () => { S.draw.pop(); redrawPreview(); drawBar(); }; }
}
function redrawPreview() {
  G.draw.clearLayers(); const d = FT[S.tool]; if (!d || !S.draw.length) return;
  S.draw.forEach((p) => L.circleMarker(p, { radius: 4, color: '#FF5500', fillColor: '#FF5500', fillOpacity: 1 }).addTo(G.draw));
  if (S.draw.length > 1) (d.kind === 'polygon' && S.draw.length > 2 ? L.polygon : L.polyline)(S.draw, { color: d.color, weight: 2, dashArray: '5 5' }).addTo(G.draw);
}
async function finishDraw() {
  const d = FT[S.tool], t = S.tool, pts = S.draw.slice();
  if (d.kind === 'polygon' && pts.length < 3 || d.kind === 'line' && pts.length < 2) return;
  if (t === 'house') {
    S.draw = []; G.draw.clearLayers();
    try { await api(`/properties/${S.activeId}/features`, { method: 'POST', body: { type: 'house', kind: 'point', name: 'House ' + (feats('house').length + 1), coords: pts } }); await refresh(); } catch (e) { toast(e.message); }
    return;
  }
  const count = feats(t).length + 1;
  const name = await askName(`Name this ${d.label}`, `${d.label} ${count}`);
  cancelDraw(); if (!name) return;
  const body = { type: t, kind: d.kind, name, coords: pts };
  if (t === 'stand') { const a = nearestAccess(pts[0]); if (a) body.accessId = a.id; }
  try { await api(`/properties/${S.activeId}/features`, { method: 'POST', body }); toast(d.label + ' added', true); await refresh(); } catch (e) { toast(e.message); }
}
function nearestAccess(p) { const a = feats('access'); return a.sort((x, y) => P.distToLine(p, x.coords) - P.distToLine(p, y.coords))[0]; }
map.on('click', (e) => {
  if (S.selFeat) deselect();
  if (e.originalEvent && e.originalEvent.target && e.originalEvent.target.closest && e.originalEvent.target.closest('.leaflet-interactive, .leaflet-marker-icon, .leaflet-popup')) return; // a shape or pin already handled this click
  if (S.jadd) return addFinding(e.latlng);
  if (S.walk) return walkClick(e);
  if (S.placeWild) return placeWildAt(e);
  if (S.placeDev) return placeDeviceAt(e);
  if (S.pm) return pmClick(e);
  if (!S.tool) return spotInfo(e);
  const p = [e.latlng.lat, e.latlng.lng], d = FT[S.tool];
  if (d.kind === 'point') { S.draw = [p]; finishDraw(); return; }
  S.draw.push(p); redrawPreview(); drawBar();
});
const ROLE_TXT = { ridge: 'Ridge top', bench: 'Bench / flat shelf on a slope', drain: 'Drain (low line water and cold air follow)', basin: 'Basin / bottom', slope: 'Slope', flat: 'Flat ground' };
function spotInfo(e) {
  if (!S.prop || S.pm || S.placeDev || S.placeWild) return;
  const pt = [e.latlng.lat, e.latlng.lng];
  let body = `<span class="mono sm">${pt[0].toFixed(5)}, ${pt[1].toFixed(5)}</span>`;
  if (S.field && S.an) {
    const c = S.field.center, [x, y] = P.toXY(pt, [c.lat, c.lng]);
    try {
      const fl = P.flowAt(S.field, x, y), tc = P.cellAt(S.an, x, y), cell = Object.assign({}, fl.cell || {}, tc || {}, { mode: (fl.cell || {}).mode });
      if (cell) body += `<br>Ground: <b>${esc(ROLE_TXT[cell.role] || cell.role)}</b><br>Elevation ${Math.round(cell.z * P.FT)} ft${cell.slope != null ? ' · slope ' + Math.round(cell.slope) + '°' : ''}`;
      if (fl && fl.speed != null) body += `<br>Air here: moving toward <b>${P.compass(fl.dir)}</b> at ${(fl.speed / 0.447).toFixed(1)} mph${cell && cell.mode ? ' (' + cell.mode + ')' : ''}`;
    } catch (err) { /* outside the sampled grid */ }
  }
  const inside = S.prop.features.filter((f) => f.kind === 'polygon' && P.pointInPoly(pt, f.coords)).map((f) => `${esc(f.name)} <span class="sm">(${esc((FT[f.type] || {}).label || f.type)})</span>`);
  if (inside.length) body += `<br>Inside: ${inside.join(', ')}`;
  const items = [['stand', 'Stand'], ['camera', 'Camera'], ['pinch', 'Pinch'], ['scrape', 'Scrape'], ['house', 'House'], ['start', 'My Start']];
  const html = `<h4>This spot</h4>${body}<div style="margin-top:8px" class="sm">Put something here:</div><div class="qadd">${items.map(([k, l]) => `<button class="pbtn" data-qadd="${k}">${FT[k].icon} ${l}</button>`).join('')}<button class="pbtn" data-qadd="sighting">&#128065; Sighting</button></div>`;
  L.popup({ maxWidth: 260 }).setLatLng(e.latlng).setContent(html).openOn(map);
  const el = map.getContainer();
  setTimeout(() => el.querySelectorAll('[data-qadd]').forEach((b) => (b.onclick = async () => {
    const t = b.dataset.qadd; map.closePopup();
    if (t === 'sighting') return sightingForm(pt);
    const d = FT[t];
    const name = t === 'start' ? 'My Start' : t === 'house' || t === 'pinch' || t === 'scrape' ? `${d.label.replace(/ \(.*/, '')} ${feats(t).length + 1}` : await askName(`Name this ${d.label}`, `${d.label} ${feats(t).length + 1}`);
    if (!name) return;
    if (t === 'start') for (const old of feats('start')) await api(`/properties/${S.activeId}/features/${old.id}`, { method: 'DELETE' });
    const body2 = { type: t, kind: 'point', name, coords: [pt] };
    if (t === 'stand') { const ac = nearestAccess(pt); if (ac) body2.accessId = ac.id; }
    try { await api(`/properties/${S.activeId}/features`, { method: 'POST', body: body2 }); toast(d.label + ' added', true); await refresh(); } catch (err) { toast(err.message); }
  })), 0);
}
map.on('dblclick', () => { if (S.tool && FT[S.tool].kind !== 'point') { S.draw.pop(); finishDraw(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelDraw(); });

const fold = (id) => { const v = store('fold_' + id); return v == null ? (id === '#tools' || id === '#layers') : !!v; };
function wireFold(id, head) {
  const box = $(id), h = box.querySelector(head); if (!h) return;
  box.classList.toggle('folded', fold(id)); h.style.cursor = 'pointer'; h.title = 'Click to fold / unfold';
  h.onclick = () => { store('fold_' + id, !fold(id)); box.classList.toggle('folded', fold(id)); };
}
function renderTerrStat() {
  const el = $('#terrStat'); if (!el || !S.prop) return;
  const t = S.prop.terrain || {}, mark = (ok) => (ok ? '<span style="color:#34D399">✓</span>' : t.loading ? '<span style="color:#FCD34D">loading…</span>' : '<span style="color:#FCA5A5">waiting</span>');
  el.innerHTML = `Elevation: ${esc(S.prop.elevationSource || (S.grid ? S.grid.source : '…'))}<br>Water: ${mark(t.water)} · Surroundings: ${mark(t.surroundings)}`;
}
function renderLayerBox() {
  $('#layers').innerHTML = `<div class="th" style="font-size:10px;letter-spacing:.14em;color:#8593A3;margin-bottom:6px">LAYERS &#9662;</div><div class="seg"><button class="btn" data-preset="simple">SIMPLE</button><button class="btn" data-preset="all">EVERYTHING</button></div><div class="seg">${[['sat', 'SATELLITE'], ['usgs', 'USGS SAT'], ['etopo', 'TOPO'], ['utopo', 'USGS TOPO'], ['topo', 'CONTOURS'], ['relief', 'RELIEF']].map(([k, l]) => `<button class="btn ${S.base === k ? 'on' : ''}" data-b="${k}">${l}</button>`).join('')}</div>` +
    LAYERS.map(([k, l, c]) => `<label style="--c:${c}"><input type="checkbox" data-l="${k}" ${S.layers[k] ? 'checked' : ''}><i></i>${l}</label>`).join('') +
    `<div class="sm" id="terrStat" style="margin-top:6px"></div><div class="sm" id="elevKey"></div><button class="btn" id="impWater" style="margin-top:6px" title="Pull ponds, wetlands and streams from OpenStreetMap">IMPORT WATER + SURROUNDINGS</button> <button class="btn" id="refDem" style="margin-top:6px" title="Pull live elevation (Google / Open-Meteo / USGS)">REFRESH LIVE DEM</button>`;
  wireFold('#layers', '.th');
  $('#layers').querySelectorAll('[data-b]').forEach((b) => (b.onclick = () => setBase(b.dataset.b)));
  $('#layers').querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => {
    const simple = b.dataset.preset === 'simple', on = new Set(['sightings', 'predict', 'wildlife', 'features', 'pins', 'ai', 'buildings', 'walks']);
    Object.keys(S.layers).forEach((k) => (S.layers[k] = simple ? on.has(k) : k !== 'elev' && k !== 'terrain'));
    store('layers2', S.layers); applyLayerVis(); renderThermal(); renderElev(); renderLayerBox();
  }));
  $('#layers').querySelectorAll('[data-l]').forEach((c) => (c.onchange = () => { S.layers[c.dataset.l] = c.checked; store('layers2', S.layers); applyLayerVis(); if (c.dataset.l === 'thermal' || c.dataset.l === 'terrain') renderThermal(); if (c.dataset.l === 'elev') renderElev(); }));
  renderTerrStat();
  $('#impWater').onclick = async () => { toast('Looking up water…', true); try { const r = await api(`/properties/${S.activeId}/terrain`, { method: 'POST', body: {} }); await refresh(); await loadAll(S.activeId); toast(`Imported ${r.ponds} ponds/wetlands, ${r.streams} streams${r.context ? ', ' + r.context.cover + ' timber blocks, ' + r.context.fields + ' fields around the property' : ''}`, true); } catch (e) { toast(e.message); } };
  $('#refDem').onclick = async () => { toast('Sampling live elevation grid…', true); try { S.grid = await api(`/properties/${S.activeId}/elevation?refresh=1&mode=live`); S.an = P.analyzeGrid(S.grid); update(); toast('Terrain source: ' + S.grid.source, true); } catch (e) { toast(e.message); } };
}

/* ---------- time scrubber ---------- */
let rafPending = false;
function update() { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; computeField(); renderThermal(); renderFeatures(); renderHud(); updateTime(); if (S.selPin) openPin(S.selPin); }); }
function updateTime() {
  const ms = curMs();
  $('#tTime').textContent = `${dstr(ms)} ${hm(ms)}${Math.abs(S.scrub - nowHours()) < 0.3 ? ' · NOW' : ''}`;
  $('#scrub').value = S.scrub;
}
function buildTicks() {
  const el = $('#ticks'); el.innerHTML = '';
  for (let h = 0; h <= 96; h += 12) {
    const s = document.createElement('span'); s.style.left = (h / 96) * 100 + '%';
    s.textContent = h % 24 === 0 ? dstr(S.dayStart + h * 3600000) : (h % 24) + 'h'; if (h % 24 === 0) s.style.color = '#E5EAF0'; el.appendChild(s);
  }
}
$('#tTime').onclick = () => $('#timebar').classList.toggle('open');
$('#scrub').oninput = (e) => { S.scrub = Number(e.target.value); S.live = false; update(); };
$('#nowBtn').onclick = () => { S.scrub = nowHours(); S.live = true; update(); };
let playT = null;
$('#playBtn').onclick = () => {
  if (playT) { clearInterval(playT); playT = null; $('#playBtn').innerHTML = '&#9654;'; return; }
  $('#playBtn').innerHTML = '&#10073;&#10073;'; S.live = false;
  playT = setInterval(() => { S.scrub = S.scrub + 0.25 > 96 ? 0 : S.scrub + 0.25; update(); }, 140);
};
setInterval(() => { if (S.live && S.dayStart) { S.scrub = nowHours(); update(); } }, 60000);

/* ---------- chat ---------- */
function md(t) {
  const lines = esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').split('\n');
  let out = '', list = null;
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  lines.forEach((l) => {
    let m;
    if ((m = /^\s*[-•]\s+(.*)/.exec(l))) { if (list !== 'ul') { close(); out += '<ul>'; list = 'ul'; } out += `<li>${m[1]}</li>`; }
    else if ((m = /^\s*\d+\.\s+(.*)/.exec(l))) { if (list !== 'ol') { close(); out += '<ol>'; list = 'ol'; } out += `<li>${m[1]}</li>`; }
    else { close(); if (l.trim()) out += `<p>${l}</p>`; }
  });
  close(); return out;
}
function addMsg(role, text, actions) {
  const d = document.createElement('div'); d.className = 'm ' + (role === 'user' ? 'u' : 'a');
  d.innerHTML = md(text);
  if (actions && actions.length) {
    const a = document.createElement('div'); a.className = 'acts';
    actions.forEach((ac) => {
      const b = document.createElement('button'); b.className = 'btn red'; b.textContent = '◉ ' + ac.label;
      b.onclick = async () => { b.disabled = true; try { const pin = await api(`/properties/${S.activeId}/pins`, { method: 'POST', body: { ...ac.pin, source: 'advisor' } }); await refresh(); openPin(pin.id, true); setView('show-map'); toast('Red Target Pin dropped', true); } catch (e) { toast(e.message); b.disabled = false; } };
      a.appendChild(b);
    });
    d.appendChild(a);
  }
  $('#msgs').appendChild(d); $('#msgs').scrollTop = 1e9; return d;
}
async function sendChat(text) {
  text = text.trim(); if (!text) return;
  addMsg('user', text); S.chat.push({ role: 'user', text });
  const th = document.createElement('div'); th.className = 'm think'; th.textContent = 'SCOUT is reading cameras, weather & thermals…'; $('#msgs').appendChild(th); $('#msgs').scrollTop = 1e9;
  try {
    const r = await api('/chat', { method: 'POST', body: { message: text, propertyId: S.activeId, history: S.chat.slice(0, -1) } });
    th.remove(); addMsg('assistant', r.reply, [...(r.actions || []), ...(r.alt || []).map((a) => ({ ...a, label: 'Alt: ' + a.label }))]);
    S.chat.push({ role: 'assistant', text: r.reply });
    if (r.pinsPlaced || r.mapChanged) await refresh();
    if (r.mapChanged) { setView('show-map'); if ((S.prop.overlays || []).length) fitAI(); loadPredict(); }
  } catch (e) { th.remove(); addMsg('assistant', '⚠ ' + e.message); }
}
$('#chatForm').onsubmit = (e) => { e.preventDefault(); const v = $('#chatIn').value; $('#chatIn').value = ''; sendChat(v); };
$('#quick').innerHTML = ['Show me how the deer will move tonight', 'Where should I sit this Saturday morning?', 'How should I scout the property?', 'Put a stand at the best spot']
  .map((q) => `<button>${esc(q)}</button>`).join('');
$('#quick').querySelectorAll('button').forEach((b) => (b.onclick = () => sendChat(b.textContent)));
(function voice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition, mic = $('#micBtn');
  if (!SR) { mic.style.display = 'none'; return; }
  const rec = new SR(); rec.lang = 'en-US'; rec.interimResults = false;
  rec.onresult = (e) => { $('#chatIn').value = e.results[0][0].transcript; $('#chatForm').requestSubmit(); };
  rec.onend = () => mic.classList.remove('rec'); rec.onerror = () => mic.classList.remove('rec');
  mic.onclick = () => { try { rec.start(); mic.classList.add('rec'); } catch (e) { /* already running */ } };
})();

/* ---------- MCP modal ---------- */
async function mcpModal() {
  S.cfg = await api('/config'); renderMcp();
  const m = S.cfg.mcp, url = m.url, tok = m.token;
  const cc = `claude mcp add --transport http cabinscout ${url} --header "Authorization: Bearer ${tok}"`;
  const json = JSON.stringify({ mcpServers: { cabinscout: { type: 'http', url, headers: { Authorization: 'Bearer ' + tok } } } }, null, 2);
  const desk = JSON.stringify({ mcpServers: { cabinscout: { command: 'npx', args: ['-y', 'mcp-remote', url, '--allow-http', '--header', 'Authorization: Bearer ' + tok] } } }, null, 2);
  modal(`<h3>MCP AI UPLINK</h3>
    <div class="tgl"><input type="checkbox" id="mEn" ${m.enabled ? 'checked' : ''}><label style="margin:0">UPLINK ENABLED</label><span class="tag" style="margin-left:auto">${m.clients.length ? 'CONNECTED: ' + esc(m.clients.join(', ')) : 'NO CLIENT YET'} · ${m.calls} CALLS</span></div>
    <label>ENDPOINT (Streamable HTTP + legacy SSE)</label><pre>${esc(url)}</pre>
    <label>CLAUDE CODE (one line)</label><pre id="p1">${esc(cc)}</pre><button class="btn" data-c="p1">COPY</button>
    <label>GENERIC MCP CLIENT CONFIG</label><pre id="p2">${esc(json)}</pre><button class="btn" data-c="p2">COPY</button>
    <label>CLAUDE DESKTOP (via mcp-remote bridge)</label><pre id="p3">${esc(desk)}</pre><button class="btn" data-c="p3">COPY</button>
    <label>EXPOSED TOOLS</label><div class="toolchips">${m.tools.map((t) => `<span>${t}</span>`).join('')}</div>
    <div class="sm" style="margin-top:12px">The endpoint only accepts localhost and requires the bearer token above. Keep it private.</div>
    <div class="foot"><button class="btn" id="c">CLOSE</button></div>`,
  (el, close) => {
    $('#c', el).onclick = close;
    $('#mEn', el).onchange = async (e) => { await api('/mcp-toggle', { method: 'POST', body: { enabled: e.target.checked } }); S.cfg = await api('/config'); renderMcp(); };
    el.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { navigator.clipboard.writeText($('#' + b.dataset.c, el).textContent).then(() => { b.textContent = 'COPIED'; setTimeout(() => (b.textContent = 'COPY'), 1500); }); }));
  });
}
$('#mcpBadge').onclick = mcpModal;

/* ---------- property map: click parcels (one or many), save them as one property or add them to one you have ---------- */
G.pm = L.layerGroup().addTo(map);
const PERM = { owner: 'I own it', lease: 'Lease', permission: 'Permission', public: 'Public land' };
S.pmSel = []; S.pmTrace = null; S.pmMsg = '';
const pmAcres = (q) => q.acres || Math.round(P.polyAreaAcres(q.boundary) * 10) / 10;
/* every parcel line in view, so a property can be picked by just clicking it */
S.pmParcels = new Map(); let pmLast = null, pmTimer = 0;
async function pmLoadParcels() {
  if (!S.pm || map.getZoom() < 15) return;
  const c = map.getCenter(), b = map.getBounds(), rad = Math.min(1500, Math.max(300, P.distM([b.getNorth(), b.getWest()], [b.getSouth(), b.getEast()]) / 2));
  if (pmLast && P.distM([c.lat, c.lng], pmLast.c) < pmLast.r * 0.35 && rad <= pmLast.r * 1.2) return;
  pmLast = { c: [c.lat, c.lng], r: rad };
  try {
    const r = await api(`/neighbors?lat=${c.lat}&lng=${c.lng}&radius=${Math.round(rad)}&bbox=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`);
    r.parcels.forEach((q) => { const k = q.parcelId || q.coords[0].join(','); if (!S.pmParcels.has(k)) S.pmParcels.set(k, { ...q, key: k, boundary: q.source === 'massgis' ? q.coords : q.coords.slice(0, -1) }); });
    if (!r.parcels.length) $('#status').textContent = 'NO PARCEL LINES FOR THIS AREA · click the map to look one up, or trace by hand';
    else $('#status').textContent = '';
    pmDraw();
  } catch (e) { /* lines are optional */ }
}
map.on('moveend', () => { if (!S.pm) return; clearTimeout(pmTimer); pmTimer = setTimeout(pmLoadParcels, 500); });
function pmPick(q) {
  const i = S.pmSel.findIndex((x) => (q.parcelId && x.parcelId === q.parcelId) || P.pointInPoly(P.centroid(q.boundary), x.boundary));
  if (i >= 0) S.pmSel.splice(i, 1); else S.pmSel.push({ boundary: q.boundary, parcelId: q.parcelId, owner: q.owner, address: q.address, acres: q.acres, source: q.source || 'regrid' });
  S.pmMsg = ''; pmDraw(); pmCard();
}
function pmDraw() {
  G.pm.clearLayers();
  S.pmParcels.forEach((q) => {
    L.polygon(q.boundary, { color: '#7C2D12', weight: 1.4, opacity: 0.9, fillColor: '#F59E0B', fillOpacity: 0.04 })
      .bindTooltip(`${esc(q.owner || 'Parcel')}${q.acres ? ' · ' + Math.round(q.acres * 10) / 10 + ' ac' : ''}${q.address ? '<br>' + esc(q.address) : ''}`, { sticky: true })
      .on('click', (ev) => { L.DomEvent.stopPropagation(ev); pmPick(q); })
      .on('mouseover', (ev) => ev.target.setStyle({ fillOpacity: 0.18, weight: 2 })).on('mouseout', (ev) => ev.target.setStyle({ fillOpacity: 0.04, weight: 1.4 })).addTo(G.pm);
  });
  S.props.forEach((p) => {
    const act = p.id === S.activeId;
    p.features.filter((f) => f.type === 'boundary').forEach((b) => {
      L.polygon(b.coords, { color: '#FF2D2D', weight: act ? 4 : 3, fillColor: '#FF2D2D', fillOpacity: act ? 0.16 : 0.1 })
        .bindTooltip(`${esc(p.name)}${p.parcel && p.parcel.acres ? ' · ' + p.parcel.acres + ' ac' : ''} (saved)`, { sticky: true })
        .on('click', (ev) => { L.DomEvent.stopPropagation(ev); const id = p.id; api('/active', { method: 'POST', body: { id } }).then(() => { pmExit(); loadAll(id); }); }).addTo(G.pm);
    });
  });
  S.pmSel.forEach((q) => { L.polygon(q.boundary, { color: '#000', weight: 7, opacity: 0.6, fill: false, interactive: false }).addTo(G.pm); L.polygon(q.boundary, { color: '#FACC15', weight: 4, fillColor: '#FACC15', fillOpacity: 0.3, interactive: false }).addTo(G.pm); });
  (S.pmTrace || []).forEach((pt) => L.circleMarker(pt, { radius: 4, color: '#FF5500', fillOpacity: 1, interactive: false }).addTo(G.pm));
  if (S.pmTrace && S.pmTrace.length > 1) L.polyline(S.pmTrace, { color: '#FF5500', weight: 2, dashArray: '5 5', interactive: false }).addTo(G.pm);
}
function pmCard() {
  const c = $('#pmcard');
  if (!S.pm) return c.classList.add('hidden');
  c.classList.remove('hidden');
  if (S.pmTrace) {
    c.innerHTML = `<h4>TRACE BOUNDARY</h4><div class="sm">Click each corner of the land (${S.pmTrace.length} pts).</div>
      <div class="foot"><button class="btn green" id="pmDone" ${S.pmTrace.length < 3 ? 'disabled' : ''}>DONE</button><button class="btn" id="pmUndo">UNDO</button><button class="btn" id="pmCancelT">CANCEL</button></div>`;
    $('#pmDone').onclick = () => { S.pmSel.push({ boundary: S.pmTrace.slice(), source: 'manual', owner: '', acres: null, address: '', parcelId: '' }); S.pmTrace = null; pmCard(); pmDraw(); };
    $('#pmUndo').onclick = () => { S.pmTrace.pop(); pmDraw(); pmCard(); };
    $('#pmCancelT').onclick = () => { S.pmTrace = null; pmDraw(); pmCard(); };
    return;
  }
  const sel = S.pmSel;
  if (!sel.length) {
    c.innerHTML = `<h4>PROPERTY MAP</h4><div class="sm">Click any outlined parcel to select it. Click more parcels next to it to piece them together into one property. Click a selected parcel again to drop it. Green outlines are properties you already saved.</div>${S.pmMsg ? `<div class="sm" style="color:#FCD34D;margin-top:6px">${esc(S.pmMsg)}</div>` : ''}
      <div class="foot"><button class="btn" id="pmTrace">TRACE BY HAND</button><button class="btn" id="pmClose">CLOSE</button></div>`;
    $('#pmTrace').onclick = () => { S.pmTrace = []; pmCard(); pmDraw(); };
    $('#pmClose').onclick = () => { pmExit(); showHome(); }; return;
  }
  const total = Math.round(sel.reduce((a, q) => a + pmAcres(q), 0) * 10) / 10, approx = sel.some((q) => q.source === 'osm');
  const owners = [...new Set(sel.map((q) => q.owner).filter(Boolean))];
  c.innerHTML = `<h4>${sel.length} PARCEL${sel.length > 1 ? 'S' : ''} SELECTED · ${total} ac</h4>
    <div class="sm" style="max-height:92px;overflow:auto">${sel.map((q, i) => `<div>${i + 1}. ${pmAcres(q)} ac${q.owner ? ' · ' + esc(q.owner) : ''}${q.address ? ' · ' + esc(q.address) : ''} <span class="mono">[${esc(q.source)}]</span> <a href="#" data-rm="${i}" style="color:#FCA5A5">remove</a></div>`).join('')}</div>
    ${approx ? '<div class="sm" style="color:#FCD34D">Includes approximate outlines, not legal lines.</div>' : ''}
    <label>SAVE AS</label><select id="pmTarget"><option value="new">A new property</option>${S.props.map((p) => `<option value="${p.id}">Add to: ${esc(p.name)}</option>`).join('')}</select>
    <div id="pmNewBox"><label>NAME</label><input id="pmName" value="${esc(sel[0].address ? sel[0].address.split(',')[0] : owners[0] ? owners[0].split(/[;,]/)[0] + ' land' : 'New property')}" autocomplete="off"></div>
    <label>YOUR ACCESS</label><select id="pmPerm">${Object.entries(PERM).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    <div class="sm" style="margin-top:6px">Keep clicking next to it to add more parcels.</div>
    <div class="foot"><button class="btn red" id="pmSave">SAVE PROPERTY</button><button class="btn" id="pmClr">CLEAR</button></div>`;
  c.querySelectorAll('[data-rm]').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); S.pmSel.splice(Number(a.dataset.rm), 1); pmDraw(); pmCard(); }));
  $('#pmTarget').onchange = (e) => $('#pmNewBox').classList.toggle('hidden', e.target.value !== 'new');
  $('#pmClr').onclick = () => { S.pmSel = []; pmDraw(); pmCard(); };
  $('#pmSave').onclick = async () => {
    const parcels = sel.map((q) => ({ boundary: q.boundary.map((p) => ({ lat: p[0], lng: p[1] })), parcelId: q.parcelId, owner: q.owner, acres: pmAcres(q), source: q.source, address: q.address }));
    const target = $('#pmTarget').value, perm = $('#pmPerm').value;
    try {
      $('#pmSave').disabled = true;
      let id;
      if (target === 'new') { const ctr = parcels[0].boundary[0]; id = (await api('/properties', { method: 'POST', body: { name: $('#pmName').value || 'New property', address: sel[0].address, lat: ctr.lat, lng: ctr.lng, parcels, permission: perm } })).id; }
      else { await api(`/properties/${target}/parcels`, { method: 'POST', body: { parcels, permission: perm } }); id = target; }
      S.pmSel = []; pmExit(); await loadAll(id); toast(target === 'new' ? `Property saved with ${parcels.length} parcel${parcels.length > 1 ? 's' : ''}. Terrain, water and surroundings are loading.` : 'Parcels added. Terrain re-centered on the combined land.', true);
    } catch (e) { toast(e.message); $('#pmSave').disabled = false; }
  };
}
async function pmClick(e) {
  const pt = [e.latlng.lat, e.latlng.lng];
  if (S.pmTrace) { S.pmTrace.push(pt); pmDraw(); return pmCard(); }
  const hit = S.pmSel.findIndex((q) => P.pointInPoly(pt, q.boundary));
  if (hit >= 0) { S.pmSel.splice(hit, 1); pmDraw(); return pmCard(); }
  $('#status').textContent = 'LOOKING UP PARCEL…';
  try {
    const r = await api(`/parcel?lat=${pt[0]}&lng=${pt[1]}`);
    if (r.parcel) {
      S.pmMsg = r.hint || '';
      if (r.parcel.parcelId && S.pmSel.some((q) => q.parcelId === r.parcel.parcelId)) S.pmMsg = 'That parcel is already selected.';
      else S.pmSel.push({ boundary: r.parcel.boundary.map((c) => [c.lat, c.lng]), parcelId: r.parcel.parcelId, owner: r.parcel.owner, address: r.parcel.address, acres: r.parcel.acres, source: r.parcel.source });
      map.fitBounds(L.latLngBounds(S.pmSel.flatMap((q) => q.boundary)).pad(0.3), { maxZoom: 18 });
    } else S.pmMsg = r.hint || 'No parcel found there.';
  } catch (err) { S.pmMsg = err.message; }
  $('#status').textContent = '';
  pmDraw(); pmCard();
}
function pmBlank(on) {
  document.body.classList.toggle('pm-mode', on);
  if (on) { cancelWalk(); closePick(); deselect(); Object.keys(S.layers).forEach((k) => G[k] && map.removeLayer(G[k])); [G.rot, G.route, G.draw].forEach((g) => map.removeLayer(g)); S.baseBeforePm = S.base; setBase('etopo'); if (map.getZoom() > 15) map.setZoom(15); }
  else { applyLayerVis(); if (S.baseBeforePm) { setBase(S.baseBeforePm); S.baseBeforePm = null; } }
  setTimeout(() => map.invalidateSize(), 60);
}
function pmEnter() { pmBlank(true); S.pm = true; S.pmSel = []; S.pmTrace = null; S.pmMsg = ''; pmLast = null; setTimeout(pmLoadParcels, 400); if (S.tool) cancelDraw(); map.getContainer().style.cursor = 'crosshair'; pmDraw(); pmCard(); }
function pmExit() { pmBlank(false); S.pm = false; S.pmSel = []; S.pmTrace = null; map.getContainer().style.cursor = ''; G.pm.clearLayers(); pmCard(); }

/* ---------- home dashboard: every property, its weather and alerts ---------- */
const DIRARR = (d) => `<span style="display:inline-block;transform:rotate(${(d + 180) % 360}deg)">&#8593;</span>`;
function miniMap(p) {
  const rings = (p.boundaries || []).filter((r) => r.length > 2); if (!rings.length) return '<div class="hm-empty">&#128506;</div>';
  const b = rings.flat();
  const lat = b.map((c) => c[0]), lng = b.map((c) => c[1]);
  const x0 = Math.min(...lng), x1 = Math.max(...lng), y0 = Math.min(...lat), y1 = Math.max(...lat), k = Math.cos((y0 + y1) / 2 * Math.PI / 180);
  const w = (x1 - x0) * k || 1e-6, h = y1 - y0 || 1e-6, sc = 100 / Math.max(w, h);
  const poly = (r) => r.map((c) => `${((c[1] - x0) * k * sc + (100 - w * sc) / 2).toFixed(1)},${((y1 - c[0]) * sc + (100 - h * sc) / 2).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 100 100" class="hm-svg">${rings.map((r) => `<polygon points="${poly(r)}" fill="rgba(239,68,68,.22)" stroke="#EF4444" stroke-width="2" stroke-linejoin="round"/>`).join('')}</svg>`;
}
function homeCard(p) {
  const w = p.weather, c = p.counts || {};
  const tr = w ? (w.trend > 0.02 ? '&#9650;' : w.trend < -0.02 ? '&#9660;' : '&#9644;') : '';
  const notes = (p.notifications || []).slice(0, 4).map((n) => `<li class="n-${n.level}">${esc(n.text)}</li>`).join('') || '<li class="n-info">All quiet</li>';
  return `<div class="hcard" data-open="${p.id}"><button class="hdel hren" data-ren="${p.id}" title="Rename this property">&#9998;</button><button class="hdel" data-del="${p.id}" title="Delete this property">&#10005;</button>
    <div class="hm">${miniMap(p)}</div>
    <div class="hbody">
      <h3>${esc(p.name)}</h3>
      <div class="sm">${p.acres ? p.acres + ' ac · ' : ''}${esc(PERM[p.permission] || '')}${p.owner ? ' · ' + esc(p.owner.split(';')[0].slice(0, 34)) + (p.owner.includes(';') ? ' +' + (p.owner.split(';').length - 1) + ' more' : '') : ''}<br>${esc((p.address || '').split(',').slice(0, 2).join(','))}</div>
      ${w ? `<div class="hwx mono"><span>${Math.round(w.tempF)}°F</span><span>${DIRARR(w.windDir)} ${w.compass} ${Math.round(w.windMph)} mph</span><span>${w.pressureInHg.toFixed(2)} ${tr}</span></div>` : (p.weather === undefined ? '<div class="sm">Loading weather…</div>' : '<div class="sm">Weather unavailable</div>')}
      ${p.forecast ? `<div class="hfc mono sm">${p.forecast.map((f, i) => f ? `${['Today', 'Tmrw', '+2d'][i]} ${f.hi}/${f.lo}° ${f.wind}` : '').join(' · ')}</div>` : ''}
      <ul class="hnotes">${notes}</ul>
      ${p.targets && (p.targets.length > 1 || p.targets[0] !== 'deer') ? `<div class="sm">Hunting: ${p.targets.map((t) => (SP[t] || SP.other)[1] + ' ' + (SP[t] || SP.other)[0]).join(', ')}</div>` : ''}
      <div class="hstats mono sm">${c.cameras || 0} cams · ${c.stands || 0} stands · ${c.sightings || 0} sightings${c.recent ? ` · <b style="color:#34D399">${c.recent} new</b>` : ''}</div>
    </div></div>`;
}
S.homeTab = 'props';
const ago2 = (ts) => { if (!ts) return 'never'; const m = Math.floor((Date.now() - ts) / 60000); return m < 2 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.floor(m / 60) + ' h ago' : Math.floor(m / 1440) + ' d ago'; };
async function showHome(tab) {
  if (tab) S.homeTab = tab;
  const el = $('#home'), T = S.homeTab;
  el.classList.remove('hidden'); document.body.classList.add('on-home');
  if (!el.firstElementChild) el.innerHTML = '<div class="home-in"><h2>MY HUNTING PROPERTIES</h2><div class="sm">Loading…</div></div>';
  try {
    const [h, u] = await Promise.all([T === 'props' ? cached('homeLite', () => api('/home?lite=1'), 60000) : null, cached('upd', () => api('/updates'), 30000)]);
        const seen = Number(store('updSeen') || 0), fresh = u.updates.filter((x) => x.ts > seen && x.ts > Date.now() - 7 * 86400000).length;
    const tabs = `<div class="htabs">${[['props', 'PROPERTIES'], ['updates', 'UPDATES'], ['devices', 'DEVICES']].map(([k, l]) => `<button class="htab${T === k ? ' on' : ''}" data-tab="${k}">${l}${k === 'updates' && fresh && T !== 'updates' ? ` <span class="rdot" title="${fresh} new"></span>` : ''}</button>`).join('')}</div>`;
    const top = `<div class="home-top"><h2>${T === 'props' ? 'MY HUNTING PROPERTIES' : T === 'updates' ? 'WHAT\u2019S HAPPENING' : 'MY DEVICES'}</h2><span>${T === 'props' ? '<button class="btn" id="hField" title="Import a file exported from the phone Field app">&#11015; FIELD DATA</button> <button class="btn red" id="hAdd">+ ADD PROPERTY</button>' : T === 'devices' ? '<button class="btn" id="cAdd">+ CONNECT A CAMERA SERVICE</button> <button class="btn red" id="dAdd">+ ADD DEVICE</button>' : '<button class="btn" id="uRef">&#8635; REFRESH</button>'}</span></div>`;
    let body = '';
    if (T === 'props') {
      const alerts = h.properties.flatMap((p) => (p.notifications || []).filter((n) => n.level === 'hot' || n.level === 'good').map((n) => ({ p, n })));
      body = `<div id="halertBox">${alerts.length ? `<div class="halerts">${alerts.slice(0, 6).map(({ p, n }) => `<div class="halert n-${n.level}" data-open="${p.id}"><b>${esc(p.name)}</b> ${esc(n.text)}</div>`).join('')}</div>` : ''}</div>
      <div class="hgrid">${h.properties.map(homeCard).join('')}<div class="hcard add" id="hAdd2"><div>+</div><span>Add a property from the parcel map</span></div></div>
      ${h.hasRegrid ? '' : '<div class="sm" style="margin-top:14px">Tip: set REGRID_TOKEN to snap to real county parcel lines when adding a property.</div>'}`;
    } else if (T === 'updates') body = `<div id="updHead"></div><div id="updList"></div>`;
    else body = '<div id="devPage"><div class="sm">Loading devices…</div></div>';
    el.innerHTML = `<div class="home-in">${top}${tabs}${body}</div>`;
    el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => showHome(b.dataset.tab)));
    if (T === 'props') {
      el.querySelectorAll('[data-ren]').forEach((b) => (b.onclick = async (ev) => {
        ev.stopPropagation();
        const p = h.properties.find((x) => x.id === b.dataset.ren), nm = await askName('Rename property', p.name.trim());
        if (!nm || nm === p.name.trim()) return;
        try { await api('/properties/' + p.id, { method: 'PUT', body: { name: nm } }); await loadAll(S.activeId); showHome(); toast('Renamed', true); } catch (e) { toast(e.message); }
      }));
      el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async (ev) => {
        ev.stopPropagation();
        const p = h.properties.find((x) => x.id === b.dataset.del);
        if (!confirm(`Delete "${p.name}" and everything on it (stands, sightings, notes)? Its cameras go back to storage. This can't be undone.`)) return;
        try { await api('/properties/' + p.id, { method: 'DELETE' }); await loadAll(); showHome(); toast('Property deleted', true); } catch (e) { toast(e.message); }
      }));
      el.querySelectorAll('[data-open]').forEach((c) => (c.onclick = async () => { await api('/active', { method: 'POST', body: { id: c.dataset.open } }); loadAll(c.dataset.open); }));
      const add = () => { hideHome(); pmEnter(); };
      cached('home', () => api('/home'), 60000).then((full) => { if (S.homeTab !== 'props') return; full.properties.forEach((p) => { const c = el.querySelector(`.hcard[data-open="${p.id}"] .hbody`); if (c) { const t = document.createElement('div'); t.innerHTML = homeCard(p); c.innerHTML = t.querySelector('.hbody').innerHTML; } }); const al = full.properties.flatMap((p) => (p.notifications || []).filter((n) => n.level === 'hot' || n.level === 'good').map((n) => ({ p, n }))), box = $('#halertBox'); if (box && al.length) box.innerHTML = `<div class="halerts">${al.slice(0, 6).map(({ p, n }) => `<div class="halert n-${n.level}" data-open="${p.id}"><b>${esc(p.name)}</b> ${esc(n.text)}</div>`).join('')}</div>`; if (box) box.querySelectorAll('[data-open]').forEach((c) => (c.onclick = async () => { await api('/active', { method: 'POST', body: { id: c.dataset.open } }); loadAll(c.dataset.open); })); }).catch(() => {});
      $('#hField').onclick = () => $('#fieldFile').click(); $('#hAdd').onclick = add; $('#hAdd2').onclick = add;
    } else if (T === 'updates') {
      $('#uRef').onclick = () => { for (const k in CC) delete CC[k]; showHome(); };
      renderUpdates(u.updates, seen); store('updSeen', Date.now());
    } else await devPage();
  } catch (e) { el.innerHTML = `<div class="home-in"><h2>MY HUNTING PROPERTIES</h2><div class="sm">${esc(e.message)}</div></div>`; }
}
/* ---------- updates feed: everything that happened, across every property ---------- */
S.updF = { prop: '', kind: '' };
const UK = [['', 'ALL'], ['camera', 'CAMERA'], ['wildlife', 'WILDLIFE'], ['sighting', 'SIGHTINGS'], ['hunt', 'HUNTS'], ['walk', 'WALKS'], ['note', 'NOTES'], ['device', 'DEVICES'], ['ai', 'AI']];
function renderUpdates(list, seen) {
  const props = [...new Map(list.map((x) => [x.propertyId || '', x.property])).entries()];
  $('#updHead').innerHTML = `<div class="ufilt"><select id="uProp"><option value="">All properties</option>${props.map(([id, n]) => `<option value="${id}" ${S.updF.prop === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>${UK.map(([k, l]) => `<button class="btn${S.updF.kind === k ? ' red' : ''}" data-k="${k}">${l}</button>`).join('')}</div>`;
  const draw = () => {
    const rows = list.filter((x) => (!S.updF.prop || x.propertyId === S.updF.prop) && (!S.updF.kind || x.kind === S.updF.kind));
    let day = '';
    $('#updList').innerHTML = rows.map((x) => {
      const d = new Date(x.ts), dk = d.toDateString(), tdy = new Date().toDateString(), yst = new Date(Date.now() - 86400000).toDateString();
      const head = dk !== day ? `<div class="uday">${dk === tdy ? 'TODAY' : dk === yst ? 'YESTERDAY' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase()}</div>` : '';
      day = dk;
      return `${head}<div class="urow${x.ts > seen ? ' new' : ''}"${x.propertyId ? ` data-open="${x.propertyId}"` : ''}><div class="ui">${x.icon}</div><div class="um"><span class="ut">${esc(x.text)}</span><br><span class="sm">${esc(x.property)} \u00B7 ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} \u00B7 ${ago2(x.ts)}</span></div>${x.photo ? `<a href="${esc(x.photo)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><img class="uph" src="${esc(x.photo)}" loading="lazy" alt=""></a>` : ''}</div>`;
    }).join('') || '<div class="sm" style="margin-top:14px">Nothing yet. Sightings, camera photos, wildlife you log, notes, walks and hunts all show up here.</div>';
    $('#updList').querySelectorAll('[data-open]').forEach((c) => (c.onclick = async () => { await api('/active', { method: 'POST', body: { id: c.dataset.open } }); loadAll(c.dataset.open); }));
  };
  $('#uProp').onchange = (e) => { S.updF.prop = e.target.value; draw(); };
  $('#updHead').querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => { S.updF.kind = b.dataset.k; $('#updHead').querySelectorAll('[data-k]').forEach((x) => x.classList.toggle('red', x === b)); draw(); }));
  draw();
}
function hideHome() { $('#home').classList.add('hidden'); document.body.classList.remove('on-home'); setTimeout(() => map.invalidateSize(), 50); }
$('#homeBtn').onclick = async () => {
  if (S.pm) pmExit();
  if (S.activeId && S.prop && (S.prop.overlays || []).length) { try { await api(`/properties/${S.activeId}/overlays`, { method: 'DELETE' }); } catch (e) { /* ignore */ } }
  showHome();
};

/* ---------- predicted deer movement + suggested setups ---------- */
async function loadContext() {
  G.context.clearLayers(); G.neighbors.clearLayers(); G.buildings.clearLayers();
  const c = S.prop.context, id = S.activeId;
  if (c) {
    const poly = (list, col, nm) => list.forEach((o) => L.polygon(o.coords, { color: col, weight: 1, fillColor: col, fillOpacity: 0.12, interactive: false }).addTo(G.context));
    (c.buildings || []).forEach((b) => L.polygon(b.coords, { color: '#E5E7EB', weight: 1, fillColor: '#9CA3AF', fillOpacity: 0.7, interactive: false }).addTo(G.buildings));
    poly(c.cover, '#4D7C0F', 'Timber / cover'); poly(c.food, '#CA8A04', 'Field / open'); poly(c.developed, '#94A3B8', 'Houses / developed');
    c.roads.forEach((r) => L.polyline(r.coords, { color: '#E2E8F0', weight: 2, opacity: 0.55, dashArray: '1 5', interactive: false }).addTo(G.context));
  }
  try {
    const r = await api(`/neighbors?lat=${S.prop.center.lat}&lng=${S.prop.center.lng}&radius=700&bbox=${S.prop.center.lng - 0.008},${S.prop.center.lat - 0.006},${S.prop.center.lng + 0.008},${S.prop.center.lat + 0.006}`);
    if (id !== S.activeId) return;
    r.parcels.forEach((p) => L.polygon(p.coords, { color: '#F8FAFC', weight: 1.5, fill: false, dashArray: '3 4' }).bindTooltip(`${esc(p.owner || 'Neighbor')}${p.acres ? ' · ' + Math.round(p.acres * 10) / 10 + ' ac' : ''}`, { sticky: true }).addTo(G.neighbors));
  } catch (e) { /* neighbors optional */ }
}
async function loadPredict() {
  loadContext();
  G.predict.clearLayers();
  try {
    const id = S.activeId, r = await api(`/properties/${id}/predict`);
    if (id !== S.activeId) return;
    S.predict = r;
    r.paths.filter((p) => !p.off).slice(0, 6).concat(r.paths.filter((p) => p.off).slice(0, 3)).forEach((p) => {
      const col = p.terrain === 'bench' ? '#A78BFA' : p.terrain === 'water' ? '#38BDF8' : '#FBBF24';
      const ln = L.polyline(p.pts, { color: col, weight: 2 + p.strength * 3, opacity: p.off ? 0.55 : 0.9, dashArray: p.off ? '3 9' : '10 8', className: 'trail', interactive: false }).addTo(G.predict);
      const why = [p.off ? '<b>Neighbor land: you do not have access here.</b> Shown only so you can see where deer likely are around you.' : '', p.terrain ? esc(p.why) : `Deer are likely to travel between <b>${esc(p.from)}</b> and <b>${esc(p.to)}</b> here.`,
        p.water ? `About ${p.water}% of this line runs through water, so it is less likely.` : '',
        p.pinch ? 'The line bends through a pinch point, where the ground funnels them.' : '',
        p.sightings ? `${p.sightings} logged sighting${p.sightings > 1 ? 's' : ''} within 40 m of this route back it up.` : 'No camera sightings on it yet, so this is a terrain guess. Cameras along it will confirm or kill it.',
        p.predator ? `<span style="color:#FCA5A5">Predator activity (${esc(p.predator.toLowerCase())}) overlaps it, which weakens the route.</span>` : '',
        r.inferred ? 'Built from terrain only (benches, drains, ridges); draw your bedding and food to sharpen it.' : ''].filter(Boolean).join('<br>');
      const hit = L.polyline(p.pts, { color: '#FBBF24', weight: 22, opacity: 0, className: 'hitline' }).addTo(G.predict);
      hit.bindPopup(`<h4>&#10148; Predicted deer route</h4><span class="mono sm">${esc(p.name)} · confidence ${Math.round(p.strength * 100)}%</span><br>${why}`);
      hit.bindTooltip(`Predicted route · ${esc(p.name)}${p.sightings ? ' · ' + p.sightings + ' sightings' : ''}${r.inferred ? ' (terrain-inferred)' : ''}`, { sticky: true });
    });
    r.sites.forEach((s) => {
      const m = L.marker(s.coords, { icon: L.divIcon({ className: '', html: '<div class="mi sug" style="--c:#FBBF24">&#9733;</div>', iconSize: [28, 28], iconAnchor: [14, 14] }), title: s.name }).addTo(G.predict);
      m.bindPopup(`<h4>&#9733; ${esc(s.name)}</h4><span class="mono sm">Best winds from ${esc(s.goodWinds)}</span><br>${esc(s.why)}<br><button class="pbtn" data-addsug="${r.sites.indexOf(s)}">ADD AS STAND</button>`);
    });
  } catch (e) { /* prediction is optional */ }
}
map.on('popupopen', (e) => {
  const b = e.popup.getElement().querySelector('[data-addsug]'); if (!b) return;
  b.onclick = async () => {
    const s = S.predict.sites[b.dataset.addsug];
    await api(`/properties/${S.activeId}/features`, { method: 'POST', body: { type: 'stand', kind: 'point', name: s.name.replace('Suggested setup', 'Stand'), coords: [s.coords], notes: s.why + ' Best winds from ' + s.goodWinds + '.' } });
    map.closePopup(); await refresh(); loadPredict(); toast('Stand added from suggestion', true);
  };
});

/* ---------- devices: every trail cam I own, where it is, what shape it's in ---------- */
S.devices = [];
async function loadDevices() { try { S.devices = (await api('/devices')).devices; } catch (e) { /* offline */ } }
const ago = (ts) => { if (!ts) return ''; const d = Math.floor((Date.now() - ts) / 86400000); return d < 1 ? 'today' : d + 'd ago'; };
function devCard(d, conns) {
  const pr = S.props.find((p) => p.id === d.propertyId), cn = conns.find((c) => c.id === d.sourceId), ft = pr && pr.features.find((x) => x.id === d.featureId);
  const view = d.fov || d.rangeFt ? `sees ${d.fov || '?'}\u00B0 wide, ${d.rangeFt || '?'} ft` : 'lens size not set';
  const face = ft ? (ft.facing != null ? `faces ${P.compass(ft.facing)} (${Math.round(ft.facing)}\u00B0)` : '<span class="devlow">not pointed yet</span>') : '';
  const bat = d.battery != null ? ` \u00B7 <span class="${d.battery < 25 ? 'devlow' : ''}">battery ${d.battery}%</span>` : '';
  const last = d.lastEvent ? ` \u00B7 last photo ${ago2(d.lastEvent)}` : '';
  return `<div class="devrow" data-id="${d.id}"><div class="di">&#128247;</div>
    <div class="dm"><b>${esc(d.name)}</b><span class="sm">${esc([d.brand, d.model].filter(Boolean).join(' ') || 'Trail camera')}${cn ? ' \u00B7 via ' + esc(cn.name) : ''}</span><br><span class="sm">${view}${face ? ' \u00B7 ' + face : ''}</span><br><span class="sm">${pr ? 'Out ' + ago(d.deployedAt).replace(' ago', '') : 'Not on a property yet'}${bat}${last}${d.lastChecked ? ' \u00B7 checked ' + ago(d.lastChecked) : ''}</span>${d.notes ? `<br><span class="sm">${esc(d.notes)}</span>` : ''}</div>
    <div class="acts"><select class="dsel" data-a="assign" title="Which property is this camera on?"><option value="">Unassigned</option>${S.props.map((p) => `<option value="${p.id}" ${p.id === d.propertyId ? 'selected' : ''}>${esc(p.name.trim())}</option>`).join('')}</select>${pr ? '<button class="btn" data-a="view">VIEW</button><button class="btn" data-a="deploy">PLACE</button><button class="btn" data-a="checked">CHECKED</button>' : ''}<button class="btn" data-a="edit">EDIT</button></div></div>`;
}
function connCard(c) {
  let host = c.url; try { host = new URL(c.url).host; } catch (e) { /* keep raw */ }
  const st = c.lastError ? `<span class="devlow">${esc(c.lastError)}</span>` : c.lastSync ? `<span style="color:#34D399">synced ${ago2(c.lastSync)}${c.lastCount != null ? ' \u00B7 ' + c.lastCount + ' new' : ''}</span>` : '<span class="sm">not synced yet</span>';
  return `<div class="devrow conn" data-cid="${c.id}"><div class="di">&#128279;</div><div class="dm"><b>${esc(c.name)}</b><span class="sm">${c.kind === 'json' ? 'JSON link' : 'MCP server'} \u00B7 ${esc(host)}${c.kind === 'mcp' ? ' \u00B7 tool: ' + esc(c.tool || 'none picked') : ''}</span><br>${st}</div>
    <div class="acts"><button class="btn green" data-c="sync">SYNC NOW</button><button class="btn" data-c="edit">EDIT</button><button class="btn" data-c="del">REMOVE</button></div></div>`;
}
async function devPage() {
  const [dv, cn] = await Promise.all([api('/devices'), api('/connectors')]);
  S.devices = dv.devices; const conns = cn.connectors, box = $('#devPage');
  const groups = S.props.map((p) => ({ p, list: S.devices.filter((d) => d.propertyId === p.id) })).concat([{ p: null, list: S.devices.filter((d) => !d.propertyId || !S.props.some((p) => p.id === d.propertyId)) }]);
  box.innerHTML = `<div class="sm devintro">Connect your camera service (an MCP server or JSON link), or add cameras by hand. Pull each one under the property it is on. Photos from a camera land in that property&#8217;s wildlife log and in Updates.</div>
    <div class="devsec">CAMERA SERVICES \u00B7 ${conns.length}</div>${conns.map(connCard).join('') || '<div class="sm">None connected. Press <b>+ CONNECT A CAMERA SERVICE</b> and paste the MCP address your camera maker gives you.</div>'}
    ${dv.inbox ? `<div class="halert" style="margin-top:12px"><b>${dv.inbox}</b> camera photo${dv.inbox > 1 ? 's are' : ' is'} waiting. Put the camera on a property below and they drop onto its map.</div>` : ''}
    ${groups.map(({ p, list }) => `<div class="devsec">${p ? esc(p.name.trim()).toUpperCase() : 'NOT ON A PROPERTY'} \u00B7 ${list.length}${p && list.length ? ` <button class="btn" data-rep="${p.id}">CAMERA REPORT</button>` : ''}</div>${list.map((d) => devCard(d, conns)).join('') || '<div class="sm">No cameras here.</div>'}`).join('')}`;
  $('#dAdd').onclick = () => devEdit(null); $('#cAdd').onclick = () => connEdit(null);
  box.querySelectorAll('.devrow[data-id]').forEach((row) => {
    const d = S.devices.find((x) => x.id === row.dataset.id);
    row.querySelectorAll('[data-a]').forEach((b) => {
      const go = async () => {
        const act = b.dataset.a;
        if (act === 'edit') return devEdit(d);
        if (act === 'deploy') return devDeploy(d);
        if (act === 'view') { await api('/active', { method: 'POST', body: { id: d.propertyId } }); await loadAll(d.propertyId); const f = S.prop.features.find((x) => x.id === d.featureId); if (f) map.setView(f.coords[0], 19); return; }
        if (act === 'checked') { await api('/devices/' + d.id, { method: 'PUT', body: { lastChecked: Date.now() } }); return showHome('devices'); }
        if (act === 'assign') {
          const v = b.value;
          try {
            if (!v) await api('/devices/' + d.id, { method: 'PUT', body: { pull: true } });
            else { await api('/devices/' + d.id, { method: 'PUT', body: { propertyId: v } }); toast('Camera is on the property now. Press PLACE (or drag it on the map) to set its exact spot.', true); }
            await refresh(); showHome('devices');
          } catch (e) { toast(e.message); }
        }
      };
      if (b.tagName === 'SELECT') b.onchange = go; else b.onclick = go;
    });
  });
  box.querySelectorAll('[data-rep]').forEach((b) => (b.onclick = () => camReport(b.dataset.rep)));
  box.querySelectorAll('.conn').forEach((row) => {
    const c = conns.find((x) => x.id === row.dataset.cid);
    row.querySelectorAll('[data-c]').forEach((b) => (b.onclick = async () => {
      if (b.dataset.c === 'edit') return connEdit(c);
      if (b.dataset.c === 'del') { if (!confirm(`Remove "${c.name}"? Cameras and photos already pulled stay.`)) return; await api('/connectors/' + c.id, { method: 'DELETE' }); return showHome('devices'); }
      b.disabled = true; b.textContent = 'SYNCING\u2026';
      const r = await api('/connectors/' + c.id + '/sync', { method: 'POST' });
      toast(r.ok ? `Pulled ${r.total} item${r.total === 1 ? '' : 's'}: ${r.fresh} new photo${r.fresh === 1 ? '' : 's'}${r.newDev ? ', ' + r.newDev + ' new camera' + (r.newDev > 1 ? 's' : '') : ''}` : r.error, r.ok);
      await refresh(); showHome('devices');
    }));
  });
}
async function camReport(pid) {
  let r; try { r = await api(`/properties/${pid}/camera-report`); } catch (e) { return toast(e.message); }
  const pr = S.props.find((p) => p.id === pid), W = ['dawn', 'midday', 'dusk', 'night'], mx = (o) => Math.max(1, ...Object.values(o));
  const bars = (o, col) => W.map((k) => `<div class="rbar"><span>${k}</span><i style="width:${Math.round(o[k] / mx(o) * 100)}%;background:${col}"></i><b>${o[k]}</b></div>`).join('');
  modal(`<h3>ALL CAMERAS · ${esc(pr ? pr.name.trim() : '')}</h3><div class="sm">Last ${r.days} days, every camera put together.</div>
    <div class="repbox">${r.tips.map((t) => `<div class="rtip">${esc(t)}</div>`).join('')}</div>
    <div class="devsec">WHEN DEER MOVE (all cameras) \u00B7 ${r.all.deer} deer</div>${bars(r.all.when, '#E0A83C')}
    <div class="devsec">WHAT SHOWS UP \u00B7 ${r.all.total} pictures</div><div class="sm">${Object.entries(r.all.species).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${(SP[k] || SP.other)[1]} ${(SP[k] || SP.other)[0]} ${v}`).join(' \u00B7 ') || 'Nothing yet'}</div>
    <div class="devsec">EACH CAMERA</div>${r.cameras.map((c) => `<div class="devrow"><div class="di">&#128247;</div><div class="dm"><b>${esc(c.name)}</b><span class="sm">${c.deer} deer \u00B7 ${c.total} pictures${c.last ? ' \u00B7 last ' + ago2(c.last) : ' \u00B7 nothing yet'}${c.battery != null ? ' \u00B7 battery ' + c.battery + '%' : ''}${c.facing != null ? ' \u00B7 faces ' + P.compass(c.facing) : ''}${c.dirs && c.dirs.some((x) => x) ? ' \u00B7 traffic mostly ' + ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][c.dirs.indexOf(Math.max(...c.dirs))] : ''}</span><div class="mini">${bars(c.when, '#38BDF8')}</div></div></div>`).join('')}
    <div class="foot"><button class="btn" id="rX">CLOSE</button></div>`, (m, close) => { $('#rX', m).onclick = close; });
}
async function devModal() { await showHome('devices'); }
function connEdit(c) {
  modal(`<h3>${c ? 'EDIT CAMERA SERVICE' : 'CONNECT A CAMERA SERVICE'}</h3>
    <div class="sm">Paste the address of your camera maker&#8217;s MCP server (or a link that returns your photos as JSON). Its login key goes below if it needs one. It stays on this computer.</div>
    <label>NAME</label><input id="cn" value="${esc(c ? c.name : '')}" placeholder="e.g. Spypoint">
    <label>TYPE</label><select id="ck"><option value="mcp" ${!c || c.kind === 'mcp' ? 'selected' : ''}>MCP server</option><option value="json" ${c && c.kind === 'json' ? 'selected' : ''}>JSON link</option></select>
    <label>ADDRESS</label><input id="cu" value="${esc(c ? c.url : '')}" placeholder="https://...">
    <label>LOGIN KEY / TOKEN ${c && c.hasToken ? '(saved, leave empty to keep)' : '(optional)'}</label><input id="ct" type="password" autocomplete="off">
    <div id="cmcp"><label>WHAT TO ASK IT FOR</label><div style="display:flex;gap:6px"><select id="ctool" style="flex:1"><option value="${esc(c ? c.tool : '')}">${esc(c && c.tool ? c.tool : 'press FIND TOOLS first')}</option></select><button class="btn" id="cfind">FIND TOOLS</button></div>
    <label>EXTRA SETTINGS (optional, JSON)</label><input id="ca" value="${esc(c ? c.args : '')}" placeholder='{"days": 7}'></div>
    <div class="foot"><button class="btn" id="cC">CANCEL</button><button class="btn red" id="cS">SAVE</button></div>`,
  (m, close) => {
    const kindUI = () => { $('#cmcp', m).style.display = $('#ck', m).value === 'mcp' ? '' : 'none'; }; $('#ck', m).onchange = kindUI; kindUI();
    $('#cC', m).onclick = () => { close(); };
    const save = async () => {
      const body = { name: $('#cn', m).value.trim() || 'Camera service', kind: $('#ck', m).value, url: $('#cu', m).value.trim(), token: $('#ct', m).value, tool: $('#ctool', m).value, args: $('#ca', m).value.trim() };
      return c ? api('/connectors/' + c.id, { method: 'PUT', body }) : api('/connectors', { method: 'POST', body });
    };
    $('#cfind', m).onclick = async () => {
      try {
        const rec = await save(); c = c || rec; const r = await api('/connectors/' + c.id + '/discover', { method: 'POST' });
        if (r.error) return toast(r.error);
        $('#ctool', m).innerHTML = r.tools.map((t) => `<option value="${esc(t.name)}" ${t.name === c.tool ? 'selected' : ''}>${esc(t.name)}${t.description ? ' \u2014 ' + esc(t.description.slice(0, 60)) : ''}</option>`).join('') || '<option value="">(no tools found)</option>';
        toast(`Found ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}. Pick the one that lists photos, then SAVE.`, true);
      } catch (e) { toast(e.message); }
    };
    $('#cS', m).onclick = async () => { try { await save(); close(); showHome('devices'); } catch (e) { toast(e.message); } };
  });
}
async function devEdit(d) {
  let models = []; try { models = (await cached('models', () => api('/camera-models'), 3600000)).models; } catch (e) { /* offline: type it in */ }
  const ft = d && S.props.flatMap((p) => p.features).find((f) => f.id === d.featureId), face = ft && ft.facing != null ? Math.round(ft.facing) : d && d.facing != null ? Math.round(d.facing) : '';
  const brands = [...new Set(models.map((x) => x.brand))];
  modal(`<h3>${d ? 'EDIT DEVICE' : 'ADD DEVICE'}</h3>
    <label>NAME</label><input id="dn" value="${esc(d ? d.name : '')}" placeholder="e.g. Cam 5 \u00B7 Creek Crossing">
    <div class="two"><div><label>BRAND</label><input id="db" list="dbl" value="${esc(d ? d.brand : '')}" placeholder="Tactacam, Reconyx\u2026" autocomplete="off"><datalist id="dbl">${brands.map((b) => `<option value="${esc(b)}">`).join('')}</datalist></div>
    <div><label>MODEL</label><input id="dm" list="dml" value="${esc(d ? d.model : '')}" autocomplete="off"><datalist id="dml"></datalist></div></div>
    <div class="sm" id="dhint">Pick a model and I fill in the lens width and reach. These are typical numbers, so check your manual and change them if yours differ.</div>
    <div class="two"><div><label>HOW WIDE IT SEES (DEGREES)</label><input id="dfov" type="number" min="10" max="180" value="${d && d.fov ? d.fov : ''}" placeholder="e.g. 52"></div>
    <div><label>HOW FAR IT REACHES (FEET)</label><input id="drng" type="number" min="10" max="300" value="${d && d.rangeFt ? d.rangeFt : ''}" placeholder="e.g. 80"></div></div>
    <div class="two"><div><label>WHICH WAY IT POINTS</label><select id="dface"><option value="">Pick a direction\u2026</option>${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((c, i) => `<option value="${i * 45}">${c}</option>`).join('')}</select></div>
    <div><label>OR EXACT DEGREES (0 = north)</label><input id="dfd" type="number" min="0" max="359" value="${face}"></div></div>
    <div class="sm">Easier on the map: select the camera and drag the gold turn handle until the blue view cone covers what the camera sees.</div>
    <div class="two"><div><label>BATTERY % (optional)</label><input id="dbat" type="number" min="0" max="100" value="${d && d.battery != null ? d.battery : ''}"></div><div></div></div>
    <label>NOTES</label><textarea id="dno" rows="2" placeholder="SD card, lock code, mounted on\u2026">${esc(d ? d.notes : '')}</textarea>
    <div class="foot">${d ? '<button class="btn" id="dDel">DELETE</button>' : ''}<button class="btn" id="dC">CANCEL</button><button class="btn red" id="dS">SAVE</button></div>`,
  (m, close) => {
    const fillModels = () => { const b = $('#db', m).value.trim().toLowerCase(); $('#dml', m).innerHTML = models.filter((x) => !b || x.brand.toLowerCase() === b).map((x) => `<option value="${esc(x.model)}">`).join(''); };
    fillModels(); $('#db', m).oninput = fillModels;
    $('#dm', m).onchange = () => {
      const b = $('#db', m).value.trim().toLowerCase(), md = $('#dm', m).value.trim().toLowerCase();
      const hit = models.find((x) => x.model.toLowerCase() === md && (!b || x.brand.toLowerCase() === b)); if (!hit) return;
      $('#db', m).value = hit.brand; $('#dfov', m).value = hit.fov; $('#drng', m).value = hit.rangeFt;
      $('#dhint', m).textContent = hit.kind === 'security' ? 'Security cameras see wide but short, and they are not built for woods. Treat what they show with care.' : `Filled in typical numbers for a ${hit.brand} ${hit.model}: ${hit.fov}\u00B0 wide, about ${hit.rangeFt} ft.`;
    };
    $('#dface', m).onchange = () => { if ($('#dface', m).value !== '') $('#dfd', m).value = $('#dface', m).value; };
    $('#dC', m).onclick = () => { close(); };
    if (d) $('#dDel', m).onclick = async () => { if (!confirm(`Delete "${d.name}" completely?`)) return; await api('/devices/' + d.id, { method: 'DELETE' }); close(); await refresh(); showHome('devices'); };
    $('#dS', m).onclick = async () => {
      const body = { name: $('#dn', m).value.trim() || 'Trail Cam', brand: $('#db', m).value, model: $('#dm', m).value, battery: $('#dbat', m).value, notes: $('#dno', m).value, fov: $('#dfov', m).value, rangeFt: $('#drng', m).value };
      if ($('#dfd', m).value !== '' || (d && face !== '')) body.facing = $('#dfd', m).value;
      try {
        if (d) await api('/devices/' + d.id, { method: 'PUT', body }); else await api('/devices', { method: 'POST', body });
        close(); await refresh(); if (!$('#home').classList.contains('hidden')) showHome('devices');
      } catch (e) { toast(e.message); }
    };
  });
}
function devDeploy(d) {
  modal(`<h3>PLACE "${esc(d.name)}"</h3><label>WHICH PROPERTY</label>
    <select id="dp">${S.props.map((p) => `<option value="${p.id}" ${p.id === (d.propertyId || S.activeId) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <div class="sm" style="margin-top:8px">Next you click the exact spot on the map.</div>
    <div class="foot"><button class="btn" id="pC">CANCEL</button><button class="btn red" id="pG">CLICK THE MAP</button></div>`,
  (m, close) => {
    $('#pC', m).onclick = () => { close(); };
    $('#pG', m).onclick = async () => {
      const pid = $('#dp', m).value; close();
      if (pid !== S.activeId || !$('#home').classList.contains('hidden')) { await api('/active', { method: 'POST', body: { id: pid } }); await loadAll(pid); }
      S.placeDev = d.id; if (S.tool) cancelDraw(); if (S.pm) pmExit();
      map.getContainer().classList.add('drawing'); map.getContainer().style.cursor = 'crosshair';
      const bar = $('#drawbar'); bar.classList.remove('hidden');
      bar.innerHTML = `<span>Click the map where <b>${esc(d.name)}</b> is set up</span><button class="btn" id="pdX">CANCEL</button>`;
      $('#pdX').onclick = stopPlacing;
    };
  });
}
function stopPlacing() { S.placeDev = null; map.getContainer().classList.remove('drawing'); map.getContainer().style.cursor = ''; $('#drawbar').classList.add('hidden'); }
async function placeDeviceAt(e) {
  const id = S.placeDev; stopPlacing();
  try { await api('/devices/' + id, { method: 'PUT', body: { propertyId: S.activeId, lat: e.latlng.lat, lng: e.latlng.lng } }); await loadDevices(); await refresh(); toast('Camera placed on the map', true); } catch (err) { toast(err.message); }
}
$('#fieldFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const r = await api('/field/import', { method: 'POST', body: { items: j.items } });
    const bits = [['cameras', 'camera'], ['stands', 'stand'], ['sightings', 'sighting'], ['wildlife', 'wildlife log'], ['shots', 'shot'], ['hunts', 'hunt']].filter(([k]) => r[k]).map(([k, l]) => `${r[k]} ${l}${r[k] > 1 && !/log$/.test(l) ? 's' : ''}`);
    await loadDevices(); await refresh(); loadWild(); loadPredict();
    toast(`Imported ${bits.join(', ') || 'nothing new'}${r.duplicates ? ' · ' + r.duplicates + ' already here' : ''}${r.skipped ? ' · ' + r.skipped + ' not near any property' : ''}`, true);
  } catch (err) { toast('Import failed: ' + err.message); }
};

/* ---------- wildlife + predators + what I'm hunting ---------- */
const SP = {
  deer: ['Whitetail deer', '🦌'], bear: ['Black bear', '🐻'], turkey: ['Turkey', '🦃'], hog: ['Feral hog', '🐗'], elk: ['Elk', '🫎'],
  coyote: ['Coyote', '🐺'], wolf: ['Wolf', '🐺'], bobcat: ['Bobcat', '🐈'], cougar: ['Mountain lion', '🐆'], fox: ['Fox', '🦊'],
  human: ['Person / ATV / gunfire', '🚜'], dog: ['Loose dog', '🐕'], raccoon: ['Raccoon', '🦝'], other: ['Other', '🐾'],
};
const GAME = ['deer', 'bear', 'turkey', 'hog', 'elk'];
const METH = { seen: 'Saw it', heard: 'Heard it', camera: 'On camera', tracks: 'Tracks', scat: 'Scat', damage: 'Damage / sign', other: 'Other' };
S.wild = { intel: null, events: [] };
async function loadWild() {
  if (!S.activeId) return;
  const id = S.activeId;
  try { const r = await api(`/properties/${id}/wildlife-intel`); if (id !== S.activeId) return; S.wild = r; } catch (e) { return; }
  renderWild(); renderWildMap();
}
function renderWild() {
  const ix = S.wild.intel; if (!ix || !S.prop) return;
  const tg = S.prop.targets || ['deer'];
  $('#targets').innerHTML = GAME.map((g) => `<div class="chip ${tg.includes(g) ? 'on' : ''}" style="--c:#34D399" data-g="${g}">${SP[g][1]} ${SP[g][0]}</div>`).join('');
  $('#targets').querySelectorAll('[data-g]').forEach((c) => (c.onclick = async () => {
    const set = new Set(tg); set.has(c.dataset.g) ? set.delete(c.dataset.g) : set.add(c.dataset.g);
    if (!set.size) set.add('deer');
    await api('/properties/' + S.activeId, { method: 'PUT', body: { targets: [...set] } }); await refresh(); loadWild();
  }));
  const pr = ix.pressure, col = pr > 0.6 ? '#EF4444' : pr > 0.25 ? '#F59E0B' : '#34D399';
  $('#wildIntel').innerHTML = ix.effects.length
    ? `<div class="wpress" style="--c:${col}"><b>Predator / disturbance pressure: ${pr > 0.6 ? 'HIGH' : pr > 0.25 ? 'MODERATE' : 'LIGHT'}</b><div class="sm">${esc(ix.headline)}</div></div>` +
      ix.effects.map((e) => `<details class="weff"><summary>${SP[e.species] ? SP[e.species][1] : '🐾'} ${esc(e.label)} · ${e.n14} in 14 days</summary><div class="sm">${esc(e.text)}</div></details>`).join('')
    : '<div class="sm" style="padding:2px 10px">No predators or disturbance logged. Log coyotes you hear, bears you see, anything.</div>';
  $('#wildDot').classList.toggle('hidden', !S.wild.events.some((e) => e.species !== 'deer' && Date.now() - e.ts < 172800000));
  const ev = S.wild.events.slice().sort((a, b) => b.ts - a.ts).slice(0, 40);
  $('#wildList').innerHTML = ev.map((e) => `<div class="wev"><span class="wi">${SP[e.species] ? SP[e.species][1] : '🐾'}</span><div style="min-width:0"><b>${esc((SP[e.species] || SP.other)[0])}${e.count > 1 ? ' ×' + e.count : ''}</b> <span class="sm">${esc(METH[e.method] || e.method)} · ${dstr(e.ts)} ${hm(e.ts)}${e.place === 'direction' ? ' · from ' + P.compass(e.heading) : ''}</span>${e.note ? `<div class="sm">${esc(e.note)}</div>` : ''}</div><button class="x" data-wx="${e.id}" title="Delete">✕</button></div>`).join('') || '';
  $('#wildList').querySelectorAll('[data-wx]').forEach((b) => (b.onclick = async () => { await api(`/properties/${S.activeId}/wildlife/${b.dataset.wx}`, { method: 'DELETE' }); await refresh(); loadWild(); }));
}
function renderWildMap() {
  G.wildlife.clearLayers();
  const ix = S.wild.intel; if (!ix) return;
  S.wild.events.filter((e) => e.lat != null && e.species !== 'deer').forEach((e) => {
    const m = L.marker([e.lat, e.lng], { icon: L.divIcon({ className: '', html: `<div class="wmk${e.place === 'direction' ? ' approx' : ''}${Date.now() - e.ts < 172800000 ? ' recent' : ''}">${(SP[e.species] || SP.other)[1]}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] }) }).addTo(G.wildlife);
    m.bindPopup(`<h4>${(SP[e.species] || SP.other)[1]} ${esc((SP[e.species] || SP.other)[0])}${e.count > 1 ? ' ×' + e.count : ''}</h4><span class="mono sm">${esc(METH[e.method] || e.method)} · ${dstr(e.ts)} ${hm(e.ts)}${e.place === 'direction' ? ' · heard from ' + P.compass(e.heading) + ' (approx.)' : ''}</span>${e.note ? '<br>' + esc(e.note) : ''}`);
  });
}
/* ---------- Scout Log layer: everything uploaded through Telegram / the Scout Log mini app that has a spot ---------- */
const SLK = { photo: ['#F59E0B', '\u{1F4F7}', 'Photo'], video: ['#F59E0B', '\u{1F3AC}', 'Video'], location: ['#94A3B8', '\u{1F4CD}', 'Spot'], note: ['#34D399', '\u{1F441}', 'Note'], hunt: ['#38BDF8', '\u{1F3F9}', 'Hunt'], shot: ['#EF4444', '\u{1F3AF}', 'Shot'] };
S.scoutLog = { entries: [], k: '', ai: null }; const SLM = {};
async function loadScoutLog() {
  const id = S.activeId;
  try { const [r, ai] = await Promise.all([api('/scout'), api('/scout/insight?propertyId=' + encodeURIComponent(id || ''))]); if (id !== S.activeId) return; S.scoutLog = { entries: r.entries || [], k: r.k || '', ai }; } catch (e) { return; }
  renderScoutLog(); renderMedia();
}
function renderScoutLog() {
  G.scoutlog.clearLayers(); Object.keys(SLM).forEach((k) => delete SLM[k]); if (!S.prop) return;
  const ai = (S.scoutLog.ai || {}).items || {};
  const asset = (u) => (S.scoutLog.k ? `${u}?k=${S.scoutLog.k}` : u);
  S.scoutLog.entries.filter((e) => e.lat != null && e.lng != null && e.propertyId === S.prop.id).forEach((e) => {
    const [col, ic, nm] = SLK[e.kind] || SLK.note, recent = Date.now() - e.ts < 172800000;
    const media = e.kind === 'photo' && e.file ? `<img src="${esc(asset(e.file))}" style="max-width:220px;border-radius:6px">` : e.kind === 'video' && e.file ? `<video src="${esc(asset(e.file))}" controls preload="metadata" style="max-width:220px"></video>` : '';
    const mk = L.marker([e.lat, e.lng], { icon: L.divIcon({ className: '', html: `<div class="slg${recent ? ' recent' : ''}" style="--c:${col}">${ic}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] }) }).addTo(G.scoutlog)
      .bindPopup(`<h4>${ic} ${nm}${e.stand ? ' · ' + esc(e.stand) : ''}</h4><span class="mono sm">${dstr(e.ts)} ${hm(e.ts)}</span>${e.caption ? '<br>' + esc(e.caption) : ''}${media ? '<br>' + media : ''}${ai[e.id] ? `<br><span class="sm">${ai[e.id].see ? '&#128065; ' + esc(ai[e.id].see) + '<br>' : ''}&#129504; ${esc(ai[e.id].read)}<br>${esc(ai[e.id].adds)}</span>` : ''}`);
    SLM[e.id] = mk;
  });
}
setInterval(() => { if (S.prop && !document.hidden) loadScoutLog(); }, 60000);
function renderMedia() {
  const d = S.scoutLog.ai; if (!d || !S.prop) return;
  const asset = (u) => (S.scoutLog.k ? `${u}?k=${S.scoutLog.k}` : u), sm = d.summary;
  const list = S.scoutLog.entries.filter((e) => e.propertyId === S.prop.id && e.kind !== 'location' && e.kind !== 'hunt' && e.kind !== 'shot' && (e.kind === 'photo' || e.kind === 'video' || e.lat != null)).slice(0, 40);
  $('#mediaN').textContent = list.length ? '· ' + list.length : '';
  $('#mediaAI').innerHTML = `<div class="wpress" style="--c:#F59E0B"><b>&#129504; WHAT THE AI THINKS</b>${sm.points.map((t) => `<div class="sm">&bull; ${esc(t)}</div>`).join('')}<div class="sm"><b>Next:</b> ${esc(sm.suggestion)}</div>${sm.hot ? '<button class="btn" id="mHot" style="margin-top:6px">SHOW HOT SPOT</button>' : ''}<div class="sm" style="opacity:.6;margin-top:4px">${esc(d.caveat)}</div></div>`;
  const hb = $('#mHot'); if (hb) hb.onclick = () => map.flyTo([sm.hot.lat, sm.hot.lng], 19, { duration: 0.6 });
  $('#mediaList').innerHTML = list.map((e) => {
    const a = d.items[e.id], th = e.kind === 'photo' && e.file ? `<img src="${esc(asset(e.file))}" loading="lazy">` : `<div class="mth">${e.kind === 'video' ? '&#127916;' : '&#128065;'}</div>`;
    return `<div class="mev" data-m="${e.id}">${th}<div style="min-width:0"><span class="sm mono">${dstr(e.ts)} ${hm(e.ts)}${e.lat == null ? ' · no location yet' : ''}</span>${e.caption ? `<div class="sm">${esc(e.caption)}</div>` : ''}${a ? `<div class="sm mai">${a.see ? '&#128065; ' + esc(a.see) + '<br>' : ''}&#129504; ${esc(a.read)}<br>${esc(a.adds)}</div>` : ''}</div></div>`;
  }).join('') || '<div class="sm" style="padding:2px 10px">Nothing yet. Send a location pin, then photos or videos, to the Telegram bot.</div>';
  $('#mediaList').querySelectorAll('[data-m]').forEach((el) => (el.onclick = () => { const mk = SLM[el.dataset.m]; if (!mk) return toast('No location on this one yet'); map.flyTo(mk.getLatLng(), 19, { duration: 0.6 }); setTimeout(() => mk.openPopup(), 650); }));
}
function wildForm() {
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const opt = (keys) => keys.map((k) => `<option value="${k}">${SP[k][1]} ${SP[k][0]}</option>`).join('');
  modal(`<h3>LOG WILDLIFE / SIGN</h3>
    <div class="two"><div><label>WHAT</label><select id="wS"><optgroup label="Predators">${opt(['coyote', 'bear', 'wolf', 'cougar', 'bobcat', 'fox'])}</optgroup><optgroup label="Game">${opt(['deer', 'turkey', 'hog', 'elk'])}</optgroup><optgroup label="Other">${opt(['human', 'dog', 'raccoon', 'other'])}</optgroup></select></div>
    <div><label>HOW</label><select id="wM">${Object.entries(METH).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div></div>
    <div class="two"><div><label>WHEN</label><input type="datetime-local" id="wT" value="${local}"></div><div><label>HOW MANY</label><input type="number" id="wN" min="1" value="1"></div></div>
    <label>WHERE</label><select id="wW"><option value="map">Pick the spot on the map</option><option value="dir">Heard from a direction</option><option value="around">Somewhere around the property</option></select>
    <div id="wDirBox" class="hidden"><label>HEARD FROM</label><select id="wD">${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((d, i) => `<option value="${i * 45}">${d}</option>`).join('')}</select></div>
    <label>NOTE</label><textarea id="wNote" rows="2" placeholder="Back yard, third night in a row, howling around 10 PM…"></textarea>
    <div class="foot"><button class="btn" id="c">CANCEL</button><button class="btn red" id="o">SAVE</button></div>`,
  (m, close) => {
    $('#wW', m).onchange = (e) => $('#wDirBox', m).classList.toggle('hidden', e.target.value !== 'dir');
    $('#wM', m).onchange = (e) => { if (e.target.value === 'heard') { $('#wW', m).value = 'dir'; $('#wDirBox', m).classList.remove('hidden'); } };
    $('#c', m).onclick = close;
    $('#o', m).onclick = async () => {
      const body = { species: $('#wS', m).value, method: $('#wM', m).value, count: Number($('#wN', m).value) || 1, ts: new Date($('#wT', m).value).getTime() || Date.now(), note: $('#wNote', m).value.trim() };
      const where = $('#wW', m).value; close();
      if (where === 'dir') body.heading = Number($('#wD', m).value);
      const send = async (extra) => { try { await api(`/properties/${S.activeId}/wildlife`, { method: 'POST', body: { ...body, ...extra } }); await refresh(); loadWild(); toast('Logged. The AI and the predictor use it now.', true); } catch (e) { toast(e.message); } };
      if (where === 'map') { S.placeWild = send; map.getContainer().classList.add('drawing'); map.getContainer().style.cursor = 'crosshair'; setView('show-map'); const bar = $('#drawbar'); bar.classList.remove('hidden'); bar.innerHTML = '<span>Click the map where it was</span><button class="btn" id="pwX">CANCEL</button>'; $('#pwX').onclick = stopWild; }
      else send({});
    };
  });
}
function stopWild() { S.placeWild = null; map.getContainer().classList.remove('drawing'); map.getContainer().style.cursor = ''; $('#drawbar').classList.add('hidden'); }
function placeWildAt(e) { const f = S.placeWild; stopWild(); f({ lat: e.latlng.lat, lng: e.latlng.lng }); }
$('#addWild').onclick = wildForm;
$('#expBtn').onclick = () => { window.location = `/api/properties/${S.activeId}/export`; };

/* ---------- property add / search ---------- */
function propertyModal() {
  let chosen = null;
  modal(`<h3>NEW HUNTING PROPERTY</h3>
    <label>SEARCH ADDRESS OR PARCEL ${S.cfg.googleMapsKey ? '(Google Places)' : '(OpenStreetMap search)'}</label>
    <div style="display:flex;gap:6px"><input id="q" placeholder="123 Main St, Town, ST" autocomplete="off"><button class="btn" id="go">SEARCH</button></div>
    <div id="res"></div>
    <label>PROPERTY NAME</label><input id="pn" placeholder="e.g. Grandpa's 40">
    <div class="sm" style="margin-top:8px">The map recenters, elevation is sampled live, then draw boundaries, bedding, stands & cameras with the toolbar.</div>
    <div class="foot"><button class="btn" id="c">CANCEL</button><button class="btn red" id="o">CREATE</button></div>`,
  (m, close) => {
    const pick = (lat, lng, label) => { chosen = { lat, lng, address: label }; if (!$('#pn', m).value) $('#pn', m).value = label.split(',')[0]; $('#res', m).innerHTML = `<div class="res on">${esc(label)}<br><span class="mono sm">${lat.toFixed(5)}, ${lng.toFixed(5)}</span></div>`; };
    const search = async () => {
      const q = $('#q', m).value.trim(); if (!q) return;
      try {
        const rows = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' + encodeURIComponent(q))).json();
        $('#res', m).innerHTML = rows.map((r, i) => `<div class="res" data-i="${i}">${esc(r.display_name)}</div>`).join('') || '<div class="sm">No results.</div>';
        $('#res', m).querySelectorAll('.res').forEach((el) => (el.onclick = () => { const r = rows[el.dataset.i]; pick(Number(r.lat), Number(r.lon), r.display_name); }));
      } catch (e) { toast('Search failed: ' + e.message); }
    };
    $('#go', m).onclick = search; $('#q', m).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
    if (window.google && google.maps && google.maps.places) {
      try {
        const ac = new google.maps.places.Autocomplete($('#q', m), { fields: ['geometry', 'formatted_address', 'name'] });
        ac.addListener('place_changed', () => { const p = ac.getPlace(); if (p.geometry) pick(p.geometry.location.lat(), p.geometry.location.lng(), p.formatted_address || p.name); });
        document.querySelectorAll('.pac-container').forEach((x) => (x.style.zIndex = 9000));
      } catch (e) { /* fall back to OSM search */ }
    }
    $('#c', m).onclick = close;
    $('#o', m).onclick = async () => {
      if (!chosen) return toast('Search and pick a location first');
      try { const np = await api('/properties', { method: 'POST', body: { name: $('#pn', m).value || 'New Property', address: chosen.address, lat: chosen.lat, lng: chosen.lng } }); close(); await loadAll(np.id); toast('Property created. Draw your boundary and stands.', true); } catch (e) { toast(e.message); }
    };
  });
}

/* ---------- loading ---------- */
function renderAll() {
  renderProps(); renderTools(); renderLayerBox(); applyLayerVis();
  computeField(); renderThermal(); renderElev(); renderFeatures(); renderSightings(); loadScoutLog(); renderPins(); renderBoard(); renderHud(); updateTime(); renderMcp();
}
async function refresh() {
  const st = await api('/state'); S.props = st.properties; S.prop = S.props.find((p) => p.id === S.activeId) || S.props[0];
  renderProps(); if (!S.prop || S.loaded !== S.prop.id) return; loadWild(); renderTerrStat(); renderThermal(); renderFeatures(); renderSightings(); loadScoutLog(); renderPins(); renderAI(); renderWalks(); renderBoard(); if (S.selFeat) renderSel(); if (S.jw && !(document.activeElement && document.activeElement.id === 'jNotes')) renderJournal();
  if (S.selPin && !S.prop.pins.find((p) => p.id === S.selPin)) closePin();
}
S.pc = {};
async function loadAll(id) {
  const st = await api('/state'); S.props = st.properties; S.activeId = id || st.activeProperty; S.prop = S.props.find((p) => p.id === S.activeId) || S.props[0];
  if (!S.prop) { S.activeId = null; renderProps(); return showHome(); }
  S.activeId = S.prop.id;
  hideHome(); loadDevices(); closePin(); journalClose(); S.loaded = null; S.filter = null; S.wx = null; S.grid = null; S.an = null; S.field = null;
  map.setView([S.prop.center.lat, S.prop.center.lng], Math.max(S.prop.zoom || 17, 18));
  $('#status').textContent = 'ACQUIRING WEATHER + TERRAIN…';
  const pc = S.pc[S.activeId];
  if (pc && Date.now() - pc.t < 600000) { // already loaded a moment ago: reuse the weather and terrain
    S.wx = pc.wx; S.grid = pc.grid; S.an = pc.an; S.dayStart = dayStartOf(Date.now()); S.scrub = nowHours(); S.live = true; buildTicks();
    renderAll(); S.loaded = S.activeId; loadPredict(); loadWild(); return;
  }
  renderAll();
  const wxP = api('/weather?propertyId=' + S.activeId), gridP = api(`/properties/${S.activeId}/elevation`);
  S.wx = await wxP;
  S.dayStart = dayStartOf(Date.now()); S.scrub = nowHours(); S.live = true; buildTicks();
  renderAll();
  try { S.grid = await gridP; S.an = P.analyzeGrid(S.grid); } catch (e) { toast('Terrain failed: ' + e.message); }
  S.pc[S.activeId] = { t: Date.now(), wx: S.wx, grid: S.grid, an: S.an };
  renderAll(); S.loaded = S.activeId; loadPredict(); loadWild();
}
function setView(v) { document.body.className = v; document.querySelectorAll('#mnav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); setTimeout(() => map.invalidateSize(), 50); }
document.querySelectorAll('#mnav button').forEach((b) => (b.onclick = () => setView(b.dataset.v)));

/* ---------- live events (MCP / other tabs) ---------- */
let evT = null;
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = async (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
    if (ev.type === 'mcp') {
      S.cfg = await api('/config'); renderMcp(); const b = $('#mcpBadge'); b.classList.add('ping'); setTimeout(() => b.classList.remove('ping'), 2000);
      if (ev.tool) toast('MCP uplink: AI called ' + ev.tool, true);
    } else if (ev.type === 'pin' || ev.type === 'changed') {
      clearTimeout(evT);
      evT = setTimeout(async () => { await refresh(); if (['context', 'features', 'terrain'].includes(ev.what)) loadPredict(); if (ev.type === 'pin' && ev.propertyId === S.activeId && S.loaded === S.activeId) { toast('AI placed a Red Target Pin on the board'); openPin(ev.pinId, true); } }, 200);
    }
  };
}

/* ---------- boot ---------- */
(async function boot() {
  try {
    S.cfg = await api('/config');
    $('#advisor').textContent = S.cfg.aiName || 'LOCAL ADVISOR';
    setBase(S.base);
    if (S.cfg.googleMapsKey) { const s = document.createElement('script'); s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(S.cfg.googleMapsKey) + '&libraries=places'; s.async = true; document.head.appendChild(s); }
    const st = await api('/state'); S.props = st.properties; S.prop = S.props.find((p) => p.id === st.activeProperty) || S.props[0]; S.activeId = S.prop ? S.prop.id : null;
    renderProps(); showHome();
    connectEvents();
    addMsg('assistant', `**CabinScout online.** I read your trail cams, live weather and the thermal model, then build an attack plan and drop a **Red Target Pin** on the map.\n\nTry a prompt below, or connect an external AI through the **MCP UPLINK** badge up top.`);
  } catch (e) { toast('Startup failed: ' + e.message); console.error(e); }
})();
})();
