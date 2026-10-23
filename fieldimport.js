/* Imports a JSON export from the phone Field app: cameras, stands, sightings, wildlife, shots and hunts land on the right property. */
const P = require('./public/physics.js');
const Wild = require('./wildlife.js');

const YD = 0.9144;
const BEH = { Bedded: 'Bedding', Walking: 'Cruising', 'Alert/spooked': 'Cruising', Cruising: 'Cruising', Feeding: 'Feeding', Rubbing: 'Rubbing', Scraping: 'Scraping' };

function pickProp(props, lat, lng) {
  let best = null, bd = 1e12;
  for (const p of props) {
    if (p.features.some((f) => f.type === 'boundary' && P.pointInPoly([lat, lng], f.coords))) return p;
    const d = P.distM([lat, lng], [p.center.lat, p.center.lng]);
    if (d < bd) { bd = d; best = p; }
  }
  return bd < 3000 ? best : null;
}

function importField(store, h, items, forcedId) {
  const { uid, deployDevice } = h;
  const st = store.state, rep = { cameras: 0, stands: 0, sightings: 0, wildlife: 0, shots: 0, hunts: 0, duplicates: 0, skipped: 0, properties: [] };
  const touched = new Set(), hunts = {};
  const ordered = (Array.isArray(items) ? items : []).filter((i) => i && i.kind && i.id).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const it of ordered) {
    const lat = it.aLat != null && (it.kind === 'sighting' || it.kind === 'shot') ? it.aLat : it.lat, lng = it.aLat != null && (it.kind === 'sighting' || it.kind === 'shot') ? it.aLng : it.lng;
    if (typeof it.lat !== 'number' || typeof it.lng !== 'number') { rep.skipped++; continue; }
    const pr = (forcedId && st.properties.find((p) => p.id === forcedId)) || pickProp(st.properties, it.lat, it.lng);
    if (!pr) { rep.skipped++; continue; }
    pr.hunts = pr.hunts || [];
    const seen = (list) => list.some((x) => x.fieldId === it.id);
    const mark = () => { touched.add(pr); if (!rep.properties.includes(pr.name)) rep.properties.push(pr.name); };
    if (it.kind === 'camera') {
      let d = st.devices.find((x) => x.fieldId === it.id);
      if (d && pr.features.some((f) => f.id === d.featureId)) { rep.duplicates++; continue; }
      if (!d) { d = { id: uid('dev'), name: it.name || 'Field camera', brand: '', model: '', battery: null, notes: [it.heightFt ? `Mounted ${it.heightFt} ft.` : '', it.notes].filter(Boolean).join(' '), propertyId: null, featureId: null, deployedAt: null, addedAt: it.ts, fieldId: it.id }; st.devices.push(d); }
      deployDevice(d, pr.id, [it.lat, it.lng]);
      const f = pr.features.find((x) => x.id === d.featureId); if (f) { f.facing = it.facing; f.fov = it.fov || 45; f.fieldId = it.id; f.accM = it.acc; }
      rep.cameras++; mark();
    } else if (it.kind === 'stand') {
      if (seen(pr.features)) { rep.duplicates++; continue; }
      pr.features.push({ id: uid('f'), type: 'stand', kind: 'point', name: it.name || 'Field stand', coords: [[it.lat, it.lng]], fieldId: it.id, accM: it.acc,
        notes: [it.standType, it.heightFt ? it.heightFt + ' ft' : '', it.facing != null ? 'shooting lane ' + it.facing + '°' : '', it.bestWinds ? 'best winds ' + it.bestWinds : '', it.notes].filter(Boolean).join('. ') });
      rep.stands++; mark();
    } else if (it.kind === 'sighting') {
      if (it.species === 'deer') {
        if (seen(pr.sightings)) { rep.duplicates++; continue; }
        let b = pr.bucks.find((x) => x.id === 'unk_field'); if (!b) { b = { id: 'unk_field', name: 'Unidentified deer (field)', color: '#94A3B8', desc: 'Sighted in person, not on camera.' }; pr.bucks.push(b); }
        const note = [it.sex && it.sex !== 'unknown' ? it.sex : '', it.count > 1 ? it.count + ' deer' : '', it.rack, it.distYd ? it.distYd + ' yd' : '', it.noShotReason ? 'no shot: ' + it.noShotReason : '', it.note].filter(Boolean).join(', ');
        pr.sightings.push({ id: uid('s'), num: pr.sightings.reduce((a, s) => Math.max(a, s.num || 0), 0) + 1, animalId: b.id, animal: b.name, ts: it.ts, featureId: null, camName: 'Field sighting', lat, lng, behavior: BEH[it.behavior] || 'Cruising', heading: it.travel != null ? it.travel : null, note, photo: null, wx: it.wx || null, fieldId: it.id });
        rep.sightings++; mark();
      } else {
        if (seen(pr.wildlife)) { rep.duplicates++; continue; }
        const e = Wild.build(pr, { species: it.species, method: 'seen', count: it.count, ts: it.ts, lat, lng, note: [it.behavior, it.distYd ? it.distYd + ' yd away' : '', it.note].filter(Boolean).join(', ') }, uid, it.wx || null);
        e.fieldId = it.id; pr.wildlife.push(e); rep.wildlife++; mark();
      }
    } else if (it.kind === 'shot' || it.kind === 'hunt') {
      if (seen(pr.hunts)) { rep.duplicates++; continue; }
      pr.hunts.push({ ...it, fieldId: it.id, id: uid('hn'), propertyLat: it.lat }); mark();
      if (it.kind === 'shot') rep.shots++; else { rep.hunts++; hunts[it.id] = { pr, it }; }
    }
  }
  // one readable note per imported hunt
  Object.values(hunts).forEach(({ pr, it }) => {
    const mine = ordered.filter((x) => x.huntId === it.id), shots = mine.filter((x) => x.kind === 'shot'), seenN = mine.filter((x) => x.kind === 'sighting');
    const t = (ms) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const wx = it.wx ? `, wind ${P.compass(it.wx.windDir)} ${Math.round(it.wx.windMph)} mph, ${Math.round(it.wx.tempF)}°F, ${it.wx.pressureInHg} inHg` : '';
    pr.notes.push({ id: uid('n'), ts: it.endTs || it.startTs, text: `Hunt ${t(it.startTs)}${it.endTs ? ' to ' + t(it.endTs) : ''} at ${it.standName}${wx}. ${seenN.length} sighting${seenN.length === 1 ? '' : 's'}, ${shots.length} shot${shots.length === 1 ? '' : 's'}${shots.map((s) => ` (${(s.result || '').replace(/-/g, ' ')}, ${s.distYd || '?'} yd)`).join('')}.` });
  });
  touched.forEach((p) => store.changed(p.id, 'features'));
  return rep;
}

module.exports = { importField };
