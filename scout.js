/* Scouting log: photos, videos, notes and locations from the Telegram bot or the web uploader, saved under data/scout.json + data/uploads. Zero dependencies. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const UP_DIR = path.join(DATA_DIR, 'uploads');
const LOG_FILE = path.join(DATA_DIR, 'scout.json');
const BOT_FILE = path.join(DATA_DIR, 'telegram.json');
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
const uid = () => 'sc' + crypto.randomBytes(5).toString('hex');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
fs.mkdirSync(UP_DIR, { recursive: true });

let log = read(LOG_FILE, []);
const saveLog = () => fs.writeFileSync(LOG_FILE, JSON.stringify(log));
/* Once a map screenshot has coordinates only the spot matters, so the picture is thrown away. */
function dropShot(e) { fs.unlink(path.join(UP_DIR, path.basename(e.file)), () => {}); delete e.file; e.kind = 'location'; }
log.forEach((e) => { if (e.tag === 'location' && e.file && e.lat != null) dropShot(e); });
saveLog();

function add(entry) {
  const e = { id: uid(), ts: Date.now(), source: 'web' };
  for (const [k, v] of Object.entries(entry)) if (v !== undefined && v !== null) e[k] = v; // undefined must not wipe the defaults
  log.push(e); saveLog(); return e;
}
function setVision(id, f) { const e = log.find((x) => x.id === id); if (!e) return null; if (f.vision) e.vision = f.vision; if (f.visionSkip) e.visionSkip = true; saveLog(); return e; }
function update(id, f) {
  const e = log.find((x) => x.id === id); if (!e) return null;
  if (f.lat === null || (isFinite(f.lat) && isFinite(f.lng) && f.lat !== '' && f.lng !== '')) { e.lat = f.lat === null ? undefined : Number(f.lat); e.lng = f.lat === null ? undefined : Number(f.lng); }
  if (typeof f.caption === 'string') e.caption = f.caption.slice(0, 1000);
  if (e.tag === 'location' && e.file && e.lat != null) dropShot(e);
  if (isFinite(f.endTs)) e.endTs = Number(f.endTs);
  if (isFinite(f.arriveTs)) { e.arriveTs = Number(f.arriveTs); e.arriveLat = f.arriveLat; e.arriveLng = f.arriveLng; }
  if (typeof f.stand === 'string') e.stand = f.stand.slice(0, 80);
  if (typeof f.buckId === 'string') e.buckId = f.buckId || undefined;
  if (typeof f.result === 'string') e.result = f.result.slice(0, 20);
  if (typeof f.open === 'boolean') e.open = f.open;
  if (typeof f.propertyId === 'string') e.propertyId = f.propertyId || undefined;
  if (f.tag === '' || f.tag === 'location') e.tag = f.tag || undefined;
  saveLog(); return e;
}
/* Media pinned to a screenshot (pin + locFrom) always takes that screenshot's spot. Everything else with no location
   borrows the spot of the nearest-in-time screenshot/pin within `hours`. */
function autolocate(hours = 3) {
  let n = 0;
  for (const e of log) {
    if (!e.pin) continue;
    const s = log.find((x) => x.id === e.locFrom);
    if (s && s.lat != null && (e.lat !== s.lat || e.lng !== s.lng)) { e.lat = s.lat; e.lng = s.lng; n++; }
  }
  const src = log.filter((x) => x.lat != null && (x.tag === 'location' || x.kind === 'location'));
  for (const e of log) {
    if (e.lat != null || e.pin || e.tag === 'location' || e.kind === 'location' || e.kind === 'note' || e.kind === 'hunt' || !src.length) continue;
    const best = src.reduce((a, b) => (Math.abs(b.ts - e.ts) < Math.abs(a.ts - e.ts) ? b : a));
    if (Math.abs(best.ts - e.ts) <= hours * 3600e3) { e.lat = best.lat; e.lng = best.lng; e.locFrom = best.id; n++; }
  }
  if (n) saveLog(); return n;
}
const findFp = (fp) => (fp ? log.find((x) => x.fp === fp) : null);
/* GPS breadcrumbs of a hunt are kept out of the main list (they get big) and fetched on demand. */
function list() { return log.slice().sort((a, b) => b.ts - a.ts).map((e) => (e.track ? { ...e, track: undefined, trackN: e.track.length } : e)); }
function getTrack(id) { const e = log.find((x) => x.id === id); return (e && e.track) || []; }
function addTrack(id, pts) {
  const e = log.find((x) => x.id === id && x.kind === 'hunt'); if (!e) return null;
  e.track = e.track || [];
  for (const p of pts) if (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) e.track.push(p);
  if (e.track.length > 5000) e.track = e.track.slice(-5000);
  saveLog(); return e.track.length;
}
function remove(id) {
  const i = log.findIndex((x) => x.id === id);
  if (i < 0) return false;
  const [e] = log.splice(i, 1);
  if (e.file) fs.unlink(path.join(UP_DIR, path.basename(e.file)), () => {});
  saveLog(); return true;
}
const extFor = (type, name) => EXT[type] || path.extname(name || '').toLowerCase() || '.bin';

/* Stream a raw request body to disk (videos are big, so no buffering). */
function saveStream(req, type, name, limit = 500e6) {
  return new Promise((resolve, reject) => {
    const file = uid() + extFor(type, name), full = path.join(UP_DIR, file), out = fs.createWriteStream(full);
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); out.destroy(); fs.unlink(full, () => {}); reject(new Error('File too large')); } });
    req.pipe(out);
    out.on('finish', () => resolve('/uploads/' + file));
    out.on('error', reject);
    req.on('error', reject);
  });
}

/* ---------- Telegram ---------- */
const tg = { token: process.env.TELEGRAM_BOT_TOKEN || '', chat: process.env.TELEGRAM_CHAT_ID || read(BOT_FILE, {}).chat || '', offset: 0, last: {}, name: '' };
const api = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${tg.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || 'Telegram error');
  return j.result;
};
const say = (chat, text) => api('sendMessage', { chat_id: chat, text }).catch(() => {});

async function download(fileId, suggested) {
  const f = await api('getFile', { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${tg.token}/${f.file_path}`);
  if (!r.ok) throw new Error('download failed');
  const name = uid() + (path.extname(f.file_path) || path.extname(suggested || '') || '.bin');
  fs.writeFileSync(path.join(UP_DIR, name), Buffer.from(await r.arrayBuffer()));
  return '/uploads/' + name;
}

const COORD = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/;
async function handle(msg) {
  const chat = String(msg.chat.id);
  if (!tg.chat) {
    tg.chat = chat; fs.writeFileSync(BOT_FILE, JSON.stringify({ chat }));
    await say(chat, 'Locked to this chat. Send a location pin, then photos/videos. They get logged with that spot.');
  }
  if (chat !== tg.chat) return;
  const text = msg.text || msg.caption || '';
  const base = { source: 'telegram', ts: (msg.date || 0) * 1000 || Date.now(), caption: text };
  if (msg.location) {
    tg.last = { lat: msg.location.latitude, lng: msg.location.longitude, ts: Date.now() };
    add({ ...base, kind: 'location', lat: tg.last.lat, lng: tg.last.lng, caption: msg.venue ? msg.venue.title : '' });
    return say(chat, `Location saved (${tg.last.lat.toFixed(5)}, ${tg.last.lng.toFixed(5)}). Photos/videos you send in the next 6 hours get this spot.`);
  }
  const doc = msg.document && /^(image|video)\//.test(msg.document.mime_type || '') ? msg.document : null;
  const media = msg.photo ? { id: msg.photo[msg.photo.length - 1].file_id, kind: 'photo' }
    : msg.video ? { id: msg.video.file_id, kind: 'video', name: msg.video.file_name }
    : doc ? { id: doc.file_id, kind: doc.mime_type.startsWith('video') ? 'video' : 'photo', name: doc.file_name } : null;
  const cm = COORD.exec(text);
  const pos = cm ? { lat: Number(cm[1]), lng: Number(cm[2]) } : tg.last.ts && Date.now() - tg.last.ts < 6 * 3600e3 ? { lat: tg.last.lat, lng: tg.last.lng } : {};
  if (media) {
    try {
      const file = await download(media.id, media.name);
      add({ ...base, kind: media.kind, file, ...pos });
      return say(chat, `${media.kind === 'video' ? 'Video' : 'Photo'} logged${pos.lat != null ? ' with location' : ' (no location yet, send a pin first)'}.`);
    } catch (e) {
      return say(chat, /too big/i.test(e.message) ? 'That file is over 20MB, the Telegram bot limit. Upload it on the website instead.' : 'Could not save that: ' + e.message);
    }
  }
  if (text.startsWith('/')) return say(chat, 'Send a location pin, then photos, videos or notes. I log them all to the Scout Log on the website.');
  if (text) { add({ ...base, kind: 'note', ...pos }); return say(chat, 'Note logged.'); }
}

async function poll() {
  for (;;) {
    try {
      tg.name = (await api('getMe')).username;
      console.log(`  Telegram bot                 ->  @${tg.name} ${tg.chat ? '(locked to your chat)' : '(message it to lock it to you)'}`);
      break;
    } catch (e) {
      if (/unauthorized|not found/i.test(e.message)) { console.log('  Telegram bot: token rejected (' + e.message + ')'); return; }
      console.log('  Telegram bot: ' + e.message + ', retrying...');
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  if (process.env.PUBLIC_URL) {
    const url = process.env.PUBLIC_URL.replace(/\/$/, '') + '/scout.html';
    api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Scout Log', web_app: { url } } }).then(() => console.log('  Mini App menu button         ->  ' + url)).catch((e) => console.log('  Menu button failed: ' + e.message));
  }
  for (;;) {
    try {
      const ups = await api('getUpdates', { offset: tg.offset, timeout: 30, allowed_updates: ['message'] });
      for (const u of ups) { tg.offset = u.update_id + 1; if (u.message) await handle(u.message).catch((e) => console.error('telegram:', e.message)); }
    } catch (e) { await new Promise((r) => setTimeout(r, 5000)); }
  }
}
function startTelegram() {
  if (tg.token) poll();
  else console.log('  Telegram bot                 ->  off (set TELEGRAM_BOT_TOKEN in .env)');
}

/* Mini App auth: Telegram signs initData with the bot token, so only the locked chat's owner gets in over the public tunnel. */
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
function authOk(initData) {
  if (!tg.token || !tg.chat || !initData) return false;
  const p = new URLSearchParams(initData), hash = p.get('hash'); p.delete('hash');
  const str = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const want = hmac(hmac('WebAppData', tg.token), str).toString('hex');
  if (!hash || hash.length !== want.length || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(want))) return false;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 7 * 86400) return false;
  try { return String(JSON.parse(p.get('user')).id) === tg.chat; } catch (e) { return false; }
}
const fileKey = () => (tg.token ? hmac(tg.token, 'scout-files').toString('hex').slice(0, 32) : '');

/* ---------- shots: blood trail / recovery points ---------- */
const TRAIL = ['blood', 'arrow', 'lastseen', 'found', 'other'];
function addPoint(id, pt) {
  const e = log.find((x) => x.id === id && x.kind === 'shot'); if (!e) return null;
  if (!TRAIL.includes(pt.type) || !isFinite(pt.lat) || !isFinite(pt.lng)) return e;
  e.trail = e.trail || []; e.trail.push({ type: pt.type, lat: +pt.lat, lng: +pt.lng, ts: Number(pt.ts) || Date.now() });
  saveLog(); return e;
}

/* ---------- season, tags and warning distances (kept on the PC so every device sees them) ---------- */
const SET_FILE = path.join(DATA_DIR, 'scout-settings.json');
const DEFAULTS = { seasonName: 'Bow season', seasonStart: '', seasonEnd: '', tagsTotal: 0, tagsUsed: 0, houseYd: 150, edgeYd: 50 };
const getSettings = () => ({ ...DEFAULTS, ...read(SET_FILE, {}) });
function setSettings(b) {
  const s = getSettings();
  if (typeof b.seasonName === 'string') s.seasonName = b.seasonName.slice(0, 40);
  for (const k of ['seasonStart', 'seasonEnd']) if (typeof b[k] === 'string' && /^(\d{4}-\d{2}-\d{2})?$/.test(b[k])) s[k] = b[k];
  for (const k of ['tagsTotal', 'tagsUsed', 'houseYd', 'edgeYd']) if (b[k] !== '' && b[k] != null && isFinite(b[k])) s[k] = Math.max(0, Math.min(999, Number(b[k])));
  fs.writeFileSync(SET_FILE, JSON.stringify(s)); return s;
}

module.exports = { setVision, addPoint, getSettings, setSettings, add, update, addTrack, getTrack, autolocate, findFp, authOk, fileKey, list, remove, saveStream, startTelegram, status: () => ({ bot: tg.name || null, locked: !!tg.chat }) };
