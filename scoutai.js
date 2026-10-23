/* Reads the Scout Log (Telegram / mini-app uploads) against the property: when and where each upload happened, what else
   happened nearby, and what it adds. It works from time, place, weather and logged sightings, not from the pixels of a photo. */
const PH = require('./public/physics.js');
const R = 6371000, rad = (d) => d * Math.PI / 180;
const dist = (a, b) => { const dl = rad(b[0] - a[0]), dg = rad(b[1] - a[1]), x = Math.sin(dl / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const off = (p, ts) => (Math.round(p.center.lng / 15) * 3600 + (PH.isDST(ts) ? 3600 : 0)) * 1000;
const hourOf = (p, ts) => ((((ts + off(p, ts)) % 86400000) + 86400000) % 86400000) / 3600000;
const band = (p, ts) => {
  const o = off(p, ts), ds = Math.floor((ts + o) / 86400000) * 86400000 - o, t = PH.sunTimes(p.center.lat, p.center.lng, ds);
  if (!t.sunrise || !t.sunset) return 'daytime';
  const m = 60000;
  if (ts < t.sunrise - 30 * m || ts > t.sunset + 30 * m) return 'after dark';
  if (ts < t.sunrise + 90 * m) return 'first light';
  if (ts > t.sunset - 90 * m) return 'last light';
  const h = hourOf(p, ts); return h < 11 ? 'mid-morning' : h < 14 ? 'midday' : 'afternoon';
};
const fmtH = (h) => { const x = Math.floor(h), m = Math.round((h - x) * 60); return ((x + 11) % 12 + 1) + (m ? ':' + String(m).padStart(2, '0') : '') + (x < 12 ? ' am' : ' pm'); };
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

function analyze(p, entries) {
  const pts = entries.filter((e) => e.propertyId === p.id && e.lat != null && e.lng != null && e.kind !== 'location');
  const spots = entries.filter((e) => e.propertyId === p.id && e.lat != null && e.kind === 'location');
  const stands = p.features.filter((f) => (f.type === 'stand' || f.type === 'camera') && f.coords && f.coords[0]).map((f) => ({ name: f.name, type: f.type, c: f.coords[0] }));
  const sight = p.sightings || [], wild = p.wildlife || [];
  const items = {};
  pts.forEach((e) => {
    const c = [e.lat, e.lng], b = band(p, e.ts), tags = [], bits = [];
    bits.push(`${fmtH(hourOf(p, e.ts))}, ${b}`);
    const mp = PH.moonPhase(e.ts); if (b === 'after dark' && (mp.illum > 0.85 || mp.illum < 0.1)) bits.push(`${mp.name.toLowerCase()} (${mp.illum > 0.5 ? 'bright' : 'dark'} night)`);
    const near = stands.map((s) => ({ s, d: dist(c, s.c) })).sort((a, z) => a.d - z.d)[0];
    if (near) { const yd = Math.round(near.d * 1.094); bits.push(near.d < 40 ? `right at ${near.s.name}` : `${yd} yd from ${near.s.name}`); if (near.d > 250) tags.push('uncovered'); }
    const rep = pts.filter((x) => x.id !== e.id && dist(c, [x.lat, x.lng]) < 60);
    if (rep.length) { bits.push(`${plural(rep.length, 'other upload')} within 60 m, repeat activity`); tags.push('repeat'); }
    const ds = sight.filter((s) => dist(c, [s.lat, s.lng]) < 150 && Math.abs(s.ts - e.ts) < 3 * 86400000);
    const dw = wild.filter((w) => w.lat != null && dist(c, [w.lat, w.lng]) < 150 && Math.abs(w.ts - e.ts) < 3 * 86400000);
    if (ds.length) { bits.push(`${plural(ds.length, 'deer sighting')} nearby within 3 days`); tags.push('corroborated'); }
    if (dw.some((w) => ['coyote', 'bear', 'wolf', 'cougar', 'dog', 'human'].includes(w.species))) { bits.push('predator/human sign logged nearby'); tags.push('pressure'); }
    if (e.wx && e.wx.windDir != null) bits.push(`wind ${PH.compass(e.wx.windDir)} ${Math.round(e.wx.windMph || 0)} mph`);
    let adds;
    if (tags.includes('corroborated') || tags.includes('repeat')) adds = 'Adds confidence: this lines up with other activity here.';
    else if (tags.includes('uncovered')) adds = 'Adds new ground: no stand or camera covers this spot yet.';
    else adds = 'Single data point so far. A second upload here would show whether it is a pattern.';
    const v = e.vision; let see = null;
    if (v) { see = [v.summary, v.hunting_value && !/^nothing useful/i.test(v.hunting_value) ? v.hunting_value : ''].filter(Boolean).join(' ') + (v.confidence ? ` (${v.confidence} confidence)` : ''); if (v.kind === 'deer' && v.sex === 'buck') tags.push('buck'); }
    items[e.id] = { read: bits.join(' · '), adds, tags, see };
  });
  /* property-level read */
  const sum = { total: pts.length, media: pts.filter((e) => e.kind === 'photo' || e.kind === 'video').length, spots: spots.length, points: [], suggestion: '' };
  if (pts.length) {
    const cnt = {}; pts.forEach((e) => { const b = band(p, e.ts); cnt[b] = (cnt[b] || 0) + 1; });
    const top = Object.entries(cnt).sort((a, z) => z[1] - a[1])[0];
    if (pts.length >= 3 && top[1] / pts.length >= 0.5) sum.points.push(`Most uploads (${top[1]} of ${pts.length}) are from ${top[0]}. That is when you are seeing things, or just when you are out there. Log some from other times to tell which.`);
    const cl = []; pts.forEach((e) => { const k = cl.find((x) => dist(x.c, [e.lat, e.lng]) < 80); k ? (k.n++, k.es.push(e)) : cl.push({ c: [e.lat, e.lng], n: 1, es: [e] }); });
    cl.sort((a, z) => z.n - a.n);
    if (cl[0].n >= 2) {
      const h = cl[0], near = stands.map((s) => ({ s, d: dist(h.c, s.c) })).sort((a, z) => a.d - z.d)[0];
      sum.hot = { lat: h.c[0], lng: h.c[1], n: h.n };
      sum.points.push(`Hot spot: ${plural(h.n, 'upload')} within about 80 m of the same place.${near ? ` Nearest ${near.s.type} is ${near.s.name}, ${Math.round(near.d * 1.094)} yd away.` : ' No stand or camera is near it.'}`);
      if (near && near.d > 120) sum.suggestion = `Put a camera or stand near the hot spot. Nothing covers it today (nearest is ${Math.round(near.d * 1.094)} yd).`;
      else if (near) sum.suggestion = `${near.s.name} already covers the hot spot. Check its wind before the next sit.`;
    }
    const unc = pts.filter((e) => items[e.id].tags.includes('uncovered')).length;
    if (unc) sum.points.push(`${plural(unc, 'upload')} came from ground no stand or camera covers.`);
    const cor = pts.filter((e) => items[e.id].tags.includes('corroborated')).length;
    if (cor) sum.points.push(`${cor} line up with logged deer sightings, which backs those areas.`);
    if (!sum.suggestion) sum.suggestion = pts.length < 5 ? 'Not enough yet to call a pattern. Keep sending a location pin and photos each time you are out.' : 'Spread uploads across different times of day so the pattern is real, not just when you happen to be there.';
  } else sum.suggestion = 'Send a location pin, then photos or videos, and they will show up here and on the map.';
  return { items, summary: sum, caveat: 'Reads when and where, plus nearby sightings. It does not look at what is in the photo.' };
}
module.exports = { analyze };
