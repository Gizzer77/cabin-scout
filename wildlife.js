/* Wildlife log: every animal and bit of sign on a property, predator / disturbance pressure, and what it likely does to deer movement. */
const P = require('./public/physics.js');

const SPECIES = {
  deer: ['Whitetail deer', 'game'], bear: ['Black bear', 'both'], turkey: ['Turkey', 'game'], hog: ['Feral hog', 'game'], elk: ['Elk', 'game'],
  coyote: ['Coyote', 'pred'], wolf: ['Wolf', 'pred'], bobcat: ['Bobcat', 'pred'], cougar: ['Mountain lion', 'pred'], fox: ['Fox', 'pred'],
  human: ['Person / ATV / gunfire', 'human'], dog: ['Loose dog', 'human'], raccoon: ['Raccoon', 'other'], other: ['Other', 'other'],
};
const WEIGHT = { bear: 1, wolf: 1, cougar: 1, coyote: 0.6, bobcat: 0.3, fox: 0.1, human: 0.9, dog: 0.4 };
const METHODS = ['seen', 'heard', 'camera', 'tracks', 'scat', 'damage', 'other'];
const DAY = 86400000;

const offSec = (prop, ts) => Math.round(prop.center.lng / 15) * 3600 + (P.isDST(ts) ? 3600 : 0);
const dayKey = (prop, ts) => Math.floor((ts + offSec(prop, ts) * 1000) / DAY);
const hourOf = (prop, ts) => ((ts + offSec(prop, ts) * 1000) % DAY) / 3600000;
const bucket = (h) => (h >= 21 || h < 5 ? 'night' : h < 9 ? 'dawn' : h < 16 ? 'midday' : 'dusk');
const label = (sp) => (SPECIES[sp] || SPECIES.other)[0];

/* Build a stored event from request fields. place: map (lat/lng given) | direction (heard from a compass bearing) | around (no spot). */
function build(prop, b, uid, wx) {
  const ts = Number(b.ts) || Date.now();
  const sp = SPECIES[b.species] ? b.species : 'other';
  const e = { id: uid('w'), ts, species: sp, method: METHODS.includes(b.method) ? b.method : 'seen', count: Math.max(1, Math.min(99, Number(b.count) || 1)),
    note: String(b.note || '').slice(0, 400), photo: b.photo || null, place: 'around', lat: null, lng: null, wx: wx || null };
  if (b.deviceId) e.deviceId = String(b.deviceId);
  if (b.travel != null && b.travel !== '' && isFinite(Number(b.travel))) e.travel = ((Number(b.travel) % 360) + 360) % 360;
  const m = P.moonPhase(ts); e.moon = { name: m.name, illum: m.illum };
  if (typeof b.lat === 'number' && typeof b.lng === 'number') { e.place = 'map'; e.lat = b.lat; e.lng = b.lng; }
  else if (b.heading != null && b.heading !== '') {
    const h = Number(b.heading) * P.D2R, ll = P.offset(prop.center.lat, prop.center.lng, Math.sin(h) * 180, Math.cos(h) * 180);
    e.place = 'direction'; e.heading = Number(b.heading); e.lat = ll[0]; e.lng = ll[1];
  }
  return e;
}

const MSG = {
  coyote: (s) => `Coyotes ${s.heardOnly ? 'heard' : 'around'} on ${s.days7} of the last 7 days${s.streak >= 3 ? ` (${s.streak}-day streak)` : ''}. Adult deer don't abandon ground over coyotes alone, but expect tighter bedding in thick cover, less time in open fields at last light and more after-dark feeding while they are loud. ${s.mostlyNight ? 'Most of it is after dark, so daylight movement should be only mildly affected. ' : ''}Favor stands on cover edges and bedding transitions over the middle of open food. Does with fawns avoid the area where they hear them.`,
  bear: (s) => `A bear has shown up ${s.n14} time${s.n14 > 1 ? 's' : ''} in 14 days${s.streak >= 2 ? ` (${s.streak} days running)` : ''}. Bears take over shared food like oaks, apples and bait and deer give them room for hours to days. Expect deer to shift to other food and travel the downwind side of cover while it is working the area. If bear is a target, this is your best spot: sit on its trail or food source at the times it has been showing.`,
  wolf: () => 'Wolf sign is a big deal: deer abandon trails and bed far differently where wolves are active. Expect heavy disturbance and changed travel for days.',
  cougar: () => 'Mountain lion sign: deer will avoid the area for days, bed on open high ground with sightlines, and move erratically.',
  bobcat: () => 'Bobcat: little effect on adult deer. Mostly a threat to fawns, turkeys and small game.',
  fox: () => 'Fox: minor. No real effect on deer movement.',
  human: (s) => `Human disturbance (people, ATVs, gunfire) logged ${s.n14} time${s.n14 > 1 ? 's' : ''} in 14 days. Deer drop travel routes along that edge for days afterward and shift to night. Avoid that edge and hunt the quiet side, or sit there only on a rested day.`,
  dog: () => 'A loose dog pushes deer around like a coyote but louder and more random. Expect scattered, short-lived movement changes.',
};

function intel(prop, now = Date.now()) {
  const evs = (prop.wildlife || []).filter((e) => now - e.ts < 30 * DAY);
  const today = dayKey(prop, now);
  const bySp = {};
  evs.forEach((e) => (bySp[e.species] = bySp[e.species] || []).push(e));
  const species = [], effects = [], alerts = [], zones = [];
  let sum = 0;
  Object.entries(bySp).forEach(([sp, arr]) => {
    const within = (d) => arr.filter((e) => now - e.ts < d * DAY);
    const days = new Set(within(7).map((e) => dayKey(prop, e.ts)));
    let streak = 0; for (let d = today; days.has(d) || (d === today && days.has(d - 1)); d--) { if (days.has(d)) streak++; else if (d !== today) break; }
    const when = { night: 0, dawn: 0, midday: 0, dusk: 0 }; arr.forEach((e) => when[bucket(hourOf(prop, e.ts))]++);
    const s = { species: sp, label: label(sp), kind: SPECIES[sp] ? SPECIES[sp][1] : 'other', n3: within(3).length, n7: within(7).length, n14: within(14).length, n30: arr.length,
      days7: days.size, streak, lastTs: Math.max(...arr.map((e) => e.ts)), when, heardOnly: arr.every((e) => e.method === 'heard'), mostlyNight: when.night >= arr.length * 0.7 };
    species.push(s);
    const w = WEIGHT[sp] || 0;
    if (w && s.n14) {
      within(14).forEach((e) => { sum += w * Math.exp(-(now - e.ts) / (6 * DAY)); });
      const text = MSG[sp] ? MSG[sp](s) : '';
      if (text) effects.push({ species: sp, label: s.label, text, n14: s.n14 });
      alerts.push({ level: w >= 0.9 ? 'warn' : 'info', text: `${s.label}: ${s.n14} log${s.n14 > 1 ? 's' : ''} in 14 days${s.days7 >= 3 ? ` · ${s.days7} of last 7 days` : ''}${s.streak >= 3 ? ` · ${s.streak}-day streak` : ''}` });
      const loc = within(14).filter((e) => e.lat != null);
      if (loc.length) {
        const c = [loc.reduce((a, e) => a + e.lat, 0) / loc.length, loc.reduce((a, e) => a + e.lng, 0) / loc.length];
        const spread = Math.max(...loc.map((e) => P.distM(c, [e.lat, e.lng])));
        zones.push({ species: sp, label: s.label, lat: c[0], lng: c[1], r: Math.round(Math.max(110, Math.min(320, spread * 1.3 + 80))), n14: s.n14, weight: w });
      }
    }
  });
  species.sort((a, b) => b.n14 - a.n14);
  const pressure = Math.min(1, Math.round((sum / 4) * 100) / 100);
  const headline = !effects.length ? '' : pressure > 0.6 ? 'High predator / disturbance pressure: expect deer to move later, in thicker cover, and to shift off shared food.' : pressure > 0.25 ? 'Moderate predator pressure: deer likely cautious at last light and hugging cover.' : 'Light predator activity: small effect on deer so far.';
  return { pressure, headline, species, effects, alerts, zones };
}

/* 0..1 pressure on a spot from nearby predator / disturbance zones */
function nearPressure(prop, coord, ix) {
  ix = ix || intel(prop);
  let p = 0;
  ix.zones.forEach((z) => { if (P.distM(coord, [z.lat, z.lng]) < z.r + 80) p += Math.min(1, z.n14 / 4) * z.weight; });
  return Math.min(1, p);
}

/* time-of-day weighted activity near a stand for NON-deer hunting targets (turkey, bear, hog...) */
function targetActivity(prop, stand, targets, s, e, off) {
  const want = targets.filter((t) => t !== 'deer');
  if (!want.length) return { score: 0, inWindow: 0 };
  const near = (prop.wildlife || []).filter((x) => want.includes(x.species) && P.distM(stand.coords[0], x.lat != null ? [x.lat, x.lng] : [prop.center.lat, prop.center.lng]) < 260);
  const winStart = (((s + off * 1000) % DAY) / 3600000), winEnd = winStart + (e - s) / 3600000;
  let sum = 0, n = 0;
  near.forEach((x) => {
    const age = (Date.now() - x.ts) / DAY, hr = (((x.ts + off * 1000) % DAY) / 3600000), inWin = hr >= winStart - 1 && hr <= winEnd + 1;
    sum += (inWin ? 1 : 0.15) * Math.exp(-age / 30) * (x.method === 'camera' || x.method === 'seen' ? 1.2 : 0.8); if (inWin) n++;
  });
  return { score: Math.min(1, sum / 4), inWindow: n };
}

module.exports = { SPECIES, METHODS, build, intel, nearPressure, targetActivity, label };
