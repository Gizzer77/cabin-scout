/* Device connectors: talk to any MCP server (Streamable HTTP) or plain JSON URL that lists trail-cam photos, and turn what comes back into camera events. */
const SPECIES = ['deer', 'bear', 'turkey', 'hog', 'elk', 'coyote', 'wolf', 'bobcat', 'cougar', 'fox', 'human', 'dog', 'raccoon'];
const ALIAS = { buck: 'deer', doe: 'deer', fawn: 'deer', whitetail: 'deer', antler: 'deer', gobbler: 'turkey', hen: 'turkey', tom: 'turkey', boar: 'hog', pig: 'hog', 'mountain lion': 'cougar', puma: 'cougar', person: 'human', people: 'human', hunter: 'human', man: 'human', vehicle: 'human', atv: 'human', truck: 'human', canine: 'dog', 'black bear': 'bear', cub: 'bear' };

const text = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
function speciesOf(it) {
  const hay = ['species', 'animal', 'label', 'class', 'tags', 'tag', 'detections', 'subject', 'category', 'type', 'caption', 'description'].map((k) => text(it[k])).join(' ').toLowerCase();
  for (const k of Object.keys(ALIAS)) if (new RegExp('\\b' + k + 's?\\b').test(hay)) return ALIAS[k];
  for (const k of SPECIES) if (new RegExp('\\b' + k + 's?\\b').test(hay)) return k;
  return hay.trim() ? 'other' : null;
}
function tsOf(it) {
  for (const k of ['timestamp', 'ts', 'time', 'date', 'datetime', 'taken', 'takenAt', 'taken_at', 'capturedAt', 'captured_at', 'createdAt', 'created_at', 'dateTaken', 'photoDate']) {
    let v = it[k]; if (v == null || v === '') continue;
    if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) { v = Number(v); return v < 1e11 ? v * 1000 : v; }
    const t = Date.parse(v); if (isFinite(t)) return t;
  }
  return null;
}
const pick = (it, keys) => { for (const k of keys) if (it[k] != null && it[k] !== '' && typeof it[k] !== 'object') return String(it[k]); return ''; };
function camOf(it) {
  const c = it.camera || it.device || it.cam;
  if (c && typeof c === 'object') return pick(c, ['name', 'label', 'id', 'serial']);
  return pick(it, ['cameraName', 'camera_name', 'camName', 'deviceName', 'device_name', 'camera', 'device', 'cam', 'cameraId', 'camera_id', 'deviceId', 'device_id', 'serial']);
}
function listIn(o, depth = 0) {
  if (Array.isArray(o)) return o.filter((x) => x && typeof x === 'object');
  if (!o || typeof o !== 'object' || depth > 3) return [];
  let best = [];
  for (const k of Object.keys(o)) { const l = listIn(o[k], depth + 1); if (l.length > best.length) best = l; }
  return best;
}
/* One raw item -> { cam, ts, species, photo, battery, note, extId, raw } (null when it has nothing we can use) */
function normalize(it) {
  const cam = camOf(it), ts = tsOf(it), sp = speciesOf(it);
  const photo = pick(it, ['image', 'imageUrl', 'image_url', 'photo', 'photoUrl', 'photo_url', 'thumbnail', 'thumb', 'url', 'link', 'largeUrl']);
  let battery = it.battery != null ? it.battery : it.batteryLevel != null ? it.batteryLevel : it.battery_level != null ? it.battery_level : (it.camera && it.camera.battery != null ? it.camera.battery : null);
  battery = battery == null || battery === '' ? null : Math.round(Number(battery) * (Number(battery) <= 1 && Number(battery) > 0 ? 100 : 1));
  if (!isFinite(battery)) battery = null;
  if (!cam && !ts && !sp) return null;
  return { cam: cam || 'Camera', ts: ts || null, species: sp, photo: /^https?:/.test(photo) ? photo : '', battery, note: pick(it, ['note', 'notes', 'caption', 'description', 'summary']).slice(0, 300), extId: pick(it, ['id', 'photoId', 'photo_id', 'eventId', 'event_id', 'uuid']) || `${cam}|${ts}|${sp}` };
}

/* ---- a tiny MCP client (Streamable HTTP; answers may come back as JSON or as an SSE stream) ---- */
async function rpc(c, session, method, params, isNote) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (c.token) headers.authorization = /^(bearer|basic) /i.test(c.token) ? c.token : 'Bearer ' + c.token;
  if (session.id) headers['mcp-session-id'] = session.id;
  const body = isNote ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++session.n, method, params };
  const r = await fetch(c.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  if (r.headers.get('mcp-session-id')) session.id = r.headers.get('mcp-session-id');
  if (isNote) return null;
  if (!r.ok) throw new Error(`${c.name || 'Connector'} answered ${r.status}${r.status === 401 || r.status === 403 ? ' (wrong or missing token)' : ''}`);
  const raw = await r.text(); let msg = null;
  if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
    raw.split(/\n\n/).forEach((blk) => { const d = blk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''); if (d) { try { const j = JSON.parse(d); if (j.id === session.n) msg = j; } catch (e) { /* skip */ } } });
  } else { try { msg = JSON.parse(raw); } catch (e) { throw new Error('Not an MCP server (reply was not JSON)'); } }
  if (!msg) throw new Error('No answer from the connector');
  if (msg.error) throw new Error(msg.error.message || 'Connector error');
  return msg.result;
}
async function open(c) {
  const s = { id: null, n: 0 };
  await rpc(c, s, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cabinscout', version: '1' } });
  await rpc(c, s, 'notifications/initialized', {}, true);
  return s;
}
async function discover(c) {
  if (c.kind === 'json') return { tools: [] };
  const s = await open(c); const r = await rpc(c, s, 'tools/list', {});
  return { tools: (r.tools || []).map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 200) })) };
}
/* Run the connector and give back normalized items. */
async function pull(c) {
  let data;
  if (c.kind === 'json') {
    const headers = c.token ? { authorization: /^(bearer|basic) /i.test(c.token) ? c.token : 'Bearer ' + c.token } : {};
    const r = await fetch(c.url, { headers, signal: AbortSignal.timeout(25000) }); if (!r.ok) throw new Error(`Answered ${r.status}`);
    data = await r.json();
  } else {
    if (!c.tool) throw new Error('Pick which tool to run (press FIND TOOLS)');
    const s = await open(c); let args = {}; try { args = c.args ? JSON.parse(c.args) : {}; } catch (e) { throw new Error('Tool arguments are not valid JSON'); }
    const r = await rpc(c, s, 'tools/call', { name: c.tool, arguments: args });
    if (r.isError) throw new Error(text((r.content || [])[0] && r.content[0].text).slice(0, 200) || 'Tool returned an error');
    if (r.structuredContent) data = r.structuredContent;
    else { const t = (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n'); try { data = JSON.parse(t); } catch (e) { data = { items: [{ note: t.slice(0, 300) }] }; } }
  }
  return listIn(data).map(normalize).filter(Boolean);
}
module.exports = { discover, pull, normalize, listIn };
