/* Demo property: a fictional 5-acre timber bench so new users can explore every feature. Placed in central Pennsylvania state-game-land country. */
const P = require('./public/physics.js');
const CENTER = { lat: 40.9, lng: -77.8 };
let _n = 0;
const sid = (p) => p + (++_n).toString(36).padStart(3, '0');
const pt = (e, n) => P.offset(CENTER.lat, CENTER.lng, e, n);
const poly = (arr) => arr.map(([e, n]) => pt(e, n));

function features() {
  const F = [];
  const add = (type, kind, name, xy, extra = {}) => {
    const coords = kind === 'point' ? [pt(xy[0], xy[1])] : poly(xy);
    const f = { id: sid('f'), type, kind, name, coords, ...extra };
    F.push(f);
    return f;
  };
  add('boundary', 'polygon', 'Demo Timber Bench (~4.8 ac)', [[-95, -45], [110, -45], [110, 50], [-95, 50]]);
  add('buffer', 'polygon', 'Neighbor Houses & Road', [[112, -80], [220, -80], [220, 90], [112, 90]]);
  add('water', 'polygon', 'Cedar Swamp & Brook Basin', [[-280, -40], [-110, -70], [-84, -12], [-92, 70], [-140, 150], [-280, 130]]);
  const bA = add('bedding', 'polygon', 'Swamp-Edge Cedar Thicket', [[-92, -5], [-66, -9], [-54, 18], [-82, 30]]);
  const bB = add('bedding', 'polygon', 'Bench Knob Laurel Thicket', [[-26, 22], [10, 20], [18, 42], [-18, 46]]);
  add('bedding', 'polygon', 'South Slope Hemlock Shelf', [[10, -86], [56, -80], [60, -62], [18, -58]]);
  const oak = add('food', 'polygon', 'White Oak Flat', [[30, -28], [62, -26], [65, -5], [35, -3]]);
  add('food', 'polygon', 'Old Apple Trees', [[70, 15], [92, 15], [92, 35], [70, 35]]);
  add('pinch', 'point', 'Hemlock Pinch', [-38, -10]);
  add('pinch', 'point', 'Bench Neck Pinch', [15, 10]);
  add('scrape', 'point', 'Primary Scrape', [24, 24]);
  add('rubline', 'line', 'Cedar-to-Oak Rub Line', [[-60, 5], [-36, 8], [-10, 6], [15, 2], [32, -8]]);
  const a1 = add('access', 'line', 'North Fence Access', [[108, 42], [70, 45], [34, 44], [5, 40]]);
  const a2 = add('access', 'line', 'South Hollow Access', [[108, -38], [80, -42], [58, -42], [52, -34]]);
  const a3 = add('access', 'line', 'Fenceline to Pinch Hang-On', [[108, -30], [70, -36], [30, -34], [0, -26], [-12, -22]]);
  add('stand', 'point', 'Stand 1 · Oak Flat Ladder', [52, -32], {
    notes: '20 ft ladder stand on a white oak. Best on W / NW winds; overlooks Oak Flat from the south edge.', accessId: a2.id,
  });
  add('stand', 'point', 'Stand 2 · Pinch Point Hang-On', [-12, -22], {
    notes: 'Hang-on over the rub line and Hemlock Pinch. Needs a south or southeast wind to keep the bedding clean.', accessId: a3.id,
  });
  add('stand', 'point', 'Stand 3 · Swamp Edge Ground Blind', [-48, 38], {
    notes: 'Ground blind north of the cedar bedding. Strongest on a northerly wind. Enter only on a falling-temp evening to dodge thermals.', accessId: a1.id,
  });
  add('camera', 'point', 'Cam 1 · Oak Flat', [48, -12]);
  add('camera', 'point', 'Cam 2 · Rub Line', [-28, 6]);
  add('camera', 'point', 'Cam 3 · Swamp Crossing', [-62, -18]);
  add('camera', 'point', 'Cam 4 · Apple Trees', [80, 24]);
  return F;
}

function build(nowMs = Date.now()) {
  _n = 0;
  const feats = features();
  const cam = {};
  feats.filter((f) => f.type === 'camera').forEach((f, i) => (cam['c' + (i + 1)] = f));
  const bucks = [
    { id: 'buck1', name: 'Target Buck - Swamp 8-Point', color: '#EF4444', desc: '8 pt, ~3.5 yrs, heavy left brow tine, travels the swamp edge at first light.' },
    { id: 'buck2', name: 'Target Buck - Ridge Runner 10-Point', color: '#FF5500', desc: '10 pt, ~4.5 yrs, drops off the main ridge at dusk, mostly nocturnal. Wide spread.' },
    { id: 'does', name: 'Broken Brow Doe Group', color: '#38BDF8', desc: 'Lead doe with a broken brow plus two yearlings.' },
    { id: 'spike', name: 'Spike Buck (Yearling)', color: '#A3E635', desc: 'Young button-buck hanging with the does.' },
  ];
  const raw = [
    ['buck1', 2, 6.75, 'c3', 'Cruising', 100], ['buck1', 3, 17.5, 'c1', 'Feeding', 90], ['buck1', 5, 6.4, 'c2', 'Rubbing', 45],
    ['buck1', 6, 7.1, 'c3', 'Cruising', 80], ['buck1', 8, 16.9, 'c1', 'Feeding', 120], ['buck1', 9, 6.2, 'c2', 'Scraping', 60],
    ['buck1', 11, 17.3, 'c4', 'Feeding', 70], ['buck1', 13, 5.9, 'c3', 'Cruising', 95],
    ['buck2', 1, 17.8, 'c4', 'Cruising', 270], ['buck2', 4, 16.4, 'c1', 'Feeding', 200], ['buck2', 7, 17.1, 'c4', 'Feeding', 250],
    ['buck2', 10, 6.6, 'c2', 'Scraping', 300], ['buck2', 12, 18.0, 'c1', 'Cruising', 230], ['buck2', 15, 5.8, 'c2', 'Rubbing', 320],
    ['does', 0, 6.9, 'c1', 'Feeding', 110], ['does', 1, 17.2, 'c4', 'Feeding', 80], ['does', 3, 7.3, 'c3', 'Bedding', 0],
    ['does', 6, 16.7, 'c1', 'Feeding', 100], ['does', 9, 6.5, 'c3', 'Cruising', 90], ['does', 14, 17.0, 'c4', 'Feeding', 75],
    ['spike', 2, 17.4, 'c1', 'Feeding', 100], ['spike', 5, 7.0, 'c2', 'Cruising', 70], ['spike', 8, 17.6, 'c4', 'Feeding', 95],
    ['buck1', 1, 22.4, 'c2', 'Cruising', 85], ['buck2', 2, 4.9, 'c3', 'Cruising', 100],
  ];
  const sightings = raw.map((r, i) => {
    const [aid, daysAgo, hr, cid, behavior, heading] = r;
    const c = cam[cid].coords[0];
    const off = (P.isDST(nowMs) ? -4 : -5) * 3600000;
    const midnight = Math.floor((nowMs + off) / 86400000) * 86400000 - off;
    const ts = midnight - daysAgo * 86400000 + hr * 3600000;
    const jitter = P.offset(c[0], c[1], ((i * 37) % 17) - 8, ((i * 53) % 15) - 7);
    const wx = P.synthWx(ts, CENTER.lat, CENTER.lng);
    const b = bucks.find((x) => x.id === aid);
    return {
      id: sid('s'), num: i + 1, animalId: aid, animal: b.name, ts: Math.round(ts), featureId: cam[cid].id, camName: cam[cid].name,
      lat: jitter[0], lng: jitter[1], behavior, heading, note: '', photo: null, wx,
    };
  }).sort((a, b) => a.ts - b.ts).map((s, i) => ({ ...s, num: i + 1 }));
  return {
    id: 'demo', name: 'Demo Property (explore me)', address: 'Fictional demo land, central PA', center: CENTER, zoom: 17,
    terrainKind: 'demo', elevationMode: 'model', features: feats, sightings, bucks, pins: [],
    notes: [
      { id: sid('n'), ts: nowMs, text: 'Bench sits ~985 ft. Swamp basin ~950 ft to the W/NW. The main ridge climbs to 1,391 ft to the S/SW: expect strong evening downslope drains toward the swamp.' },
      { id: sid('n'), ts: nowMs, text: 'Neighbors to the east. A west wind carries scent into the houses (safe). A south or east wind pushes it toward the bedding (avoid).' },
    ],
  };
}

module.exports = { build, CENTER };
