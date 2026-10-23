/* Home dashboard summaries + predicted deer movement / suggested stand sites. */
const P = require('./public/physics.js');
const S = require('./services.js');
const Wild = require('./wildlife.js');

const ringsOf = (prop) => prop.features.filter((f) => f.type === 'boundary').map((f) => f.coords);
const inAny = (rings, pt) => !rings.length || rings.some((r) => P.pointInPoly(pt, r));
const round = (v, d = 0) => { const m = 10 ** d; return Math.round(v * m) / m; };
const ll = (c, e, n) => P.offset(c[0], c[1], e, n);
const mid = (a, b, t = 0.5) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const acresOf = (ring) => {
  if (!ring || ring.length < 3) return null;
  const c = ring[0], pts = ring.map((p) => P.toXY(p, c));
  let a = 0; pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; });
  return round(Math.abs(a) / 2 / 4046.86, 1);
};
const vecMeanDir = (arr) => {
  const x = arr.reduce((a, d) => a + Math.sin(d * P.D2R), 0), y = arr.reduce((a, d) => a + Math.cos(d * P.D2R), 0);
  return P.norm360(Math.atan2(x, y) / P.D2R);
};

/* ---------- predicted movement ---------- */
function terrainAnchors(an, boundary) {
  const inside = (c) => !boundary || inAny(boundary, P.offset(an.center.lat, an.center.lng, c.x, c.y));
  const cells = an.cells.filter(inside);
  const pick = (list, score, k, sep) => {
    const out = [];
    list.slice().sort((a, b) => score(b) - score(a)).forEach((c) => { if (out.length < k && out.every((o) => Math.hypot(o.x - c.x, o.y - c.y) >= sep)) out.push(c); });
    return out;
  };
  const bed = pick(cells.filter((c) => c.role === 'bench' || c.role === 'ridge'), (c) => c.z - c.slope, 2, 90);
  const food = pick(cells.filter((c) => c.role === 'flat' || c.role === 'basin'), (c) => -c.z, 2, 90);
  const pinch = cells.filter((c) => c.role === 'bench' || c.role === 'drain');
  const toLL = (c) => P.offset(an.center.lat, an.center.lng, c.x, c.y);
  return { beds: bed.map((c, i) => ({ name: 'Likely bedding ' + (i + 1), c: toLL(c) })), foods: food.map((c, i) => ({ name: 'Likely feed ' + (i + 1), c: toLL(c) })), pinches: pinch.map(toLL), inferred: true };
}

/* ---------- where deer will NOT walk: water, houses, yards. A* finds a way around them ---------- */
function makeRouter(prop, an, opts = {}) {
  const rings = prop.features.filter((f) => f.type === 'boundary').map((f) => f.coords);
  const ctx = prop.context || {}, CELL = 6, o = [prop.center.lat, prop.center.lng];
  const bbox = (poly) => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; poly.forEach((p) => { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); }); return [a, b, c, d]; };
  const mk = (list, w) => list.map((coords) => ({ coords, bb: bbox(coords), w }));
  const polys = [].concat(
    mk(prop.features.filter((f) => f.type === 'water' && f.kind === 'polygon' && !(opts.scout && /Forested|Emergent/.test(f.wet || ''))).map((f) => f.coords), 60),
    opts.scout ? mk(prop.features.filter((f) => f.type === 'water' && f.kind === 'polygon' && /Forested|Emergent/.test(f.wet || '')).map((f) => f.coords), 4) : [],
    mk((ctx.buildings || []).map((b) => b.coords), 60),
    mk((ctx.developed || []).map((d) => d.coords), opts.scout ? 3 : 14),
    mk(prop.features.filter((f) => f.type === 'buffer' && f.kind === 'polygon').map((f) => f.coords), opts.scout ? 3 : 14),
    opts.avoidBed ? mk(prop.features.filter((f) => f.type === 'bedding' && f.kind === 'polygon').map((f) => f.coords), 9) : []);
  const spots = [], own = rings.length ? rings : null, mine = (c) => opts.scout && own && own.some((r) => P.pointInPoly(c, r));
  prop.features.filter((f) => f.type === 'house').forEach((f) => f.coords.forEach((c) => { if (!mine(c)) spots.push(c); }));
  (ctx.buildings || []).forEach((b) => { const c = P.centroid(b.coords); if (!mine(c)) spots.push(c); });
  const streams = prop.features.filter((f) => f.type === 'stream' && f.kind === 'line').map((f) => f.coords);
  const covers = (ctx.cover || []).map((c) => ({ coords: c.coords, bb: bbox(c.coords) }));
  const memo = new Map();
  const inBB = (p, bb) => p[0] >= bb[0] && p[0] <= bb[2] && p[1] >= bb[1] && p[1] <= bb[3];
  const cost = (p) => {
    let c = 1;
    for (const g of polys) if (inBB(p, g.bb) && P.pointInPoly(p, g.coords)) c = Math.max(c, g.w);
    for (const s of spots) { const d = P.distM(p, s), R = opts.scout ? 30 : 55; if (d < R) c = Math.max(c, d < 18 ? 40 : 12); }
    if (c < 10) {
      if (opts.scout && rings.length && !rings.some((r) => P.pointInPoly(p, r))) c += 4; // stay on your own land
      if (streams.some((l) => P.distToLine ? P.distToLine(p, l) < 4 : false)) c += 1.5;
      if (an) { try { const [x, y] = P.toXY(p, [an.center.lat, an.center.lng]), cl = P.cellAt(an, x, y); if (cl && cl.slope > 30) c += 3; else if (cl && cl.slope > 20) c += 1; } catch (e) { /* off grid */ } }
      if (covers.some((g) => inBB(p, g.bb) && P.pointInPoly(p, g.coords))) c *= 0.9;
    }
    return c;
  };
  const key = (i, j) => i + ',' + j;
  const at = (i, j) => { const k = key(i, j); let v = memo.get(k); if (v === undefined) { v = cost(P.offset(o[0], o[1], i * CELL, j * CELL)); memo.set(k, v); } return v; };
  const cellOf = (p) => { const [x, y] = P.toXY(p, o); return [Math.round(x / CELL), Math.round(y / CELL)]; };
  const llOf = (i, j) => P.offset(o[0], o[1], i * CELL, j * CELL);
  const BAD = 10;
  const blocked = (p) => { const [i, j] = cellOf(p); return at(i, j) >= BAD; };
  // nudge a point that landed in water / a yard to the nearest open ground
  const snap = (p) => {
    const [ci, cj] = cellOf(p); if (at(ci, cj) < BAD) return p;
    for (let r = 1; r <= 16; r++) { let best = null; for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) { if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue; const c = at(ci + i, cj + j); if (c < 3 && (!best || c < best.c)) best = { c, i: ci + i, j: cj + j }; } if (best) return llOf(best.i, best.j); }
    return null;
  };
  function route(a, z, pen) {
    const [si, sj] = cellOf(a), [ei, ej] = cellOf(z), m = 20;
    const minI = Math.min(si, ei) - m, maxI = Math.max(si, ei) + m, minJ = Math.min(sj, ej) - m, maxJ = Math.max(sj, ej) + m;
    if ((maxI - minI) * (maxJ - minJ) > 120000) return null;
    const g = new Map(), from = new Map(), heap = [[0, si, sj]], push = (n) => { heap.push(n); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { let l = 2 * k + 1, r = l + 1, s = k; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (r < heap.length && heap[r][0] < heap[s][0]) s = r; if (s === k) break; [heap[s], heap[k]] = [heap[k], heap[s]]; k = s; } } return top; };
    g.set(key(si, sj), 0);
    while (heap.length) {
      const [, i, j] = pop(), gc = g.get(key(i, j));
      if (i === ei && j === ej) break;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue; const ni = i + di, nj = j + dj;
        if (ni < minI || ni > maxI || nj < minJ || nj > maxJ) continue;
        const k = key(ni, nj), step = (di && dj ? 1.414 : 1) * ((at(ni, nj) + (pen && pen.has(k) ? 4 : 0)) + at(i, j)) / 2, ng = gc + step;
        if (g.has(k) && g.get(k) <= ng) continue;
        g.set(k, ng); from.set(k, [i, j]); push([ng + 0.95 * Math.hypot(ei - ni, ej - nj), ni, nj]);
      }
    }
    if (!from.has(key(ei, ej)) && !(si === ei && sj === ej)) return null;
    const cells = []; let cur = [ei, ej];
    while (cur) { cells.push(cur); cur = from.get(key(cur[0], cur[1])); }
    cells.reverse();
    const bad = cells.filter(([i, j]) => at(i, j) >= BAD).length / cells.length;
    let pts = cells.map(([i, j]) => llOf(i, j));
    pts = pts.filter((_, k) => k === 0 || k === pts.length - 1 || k % 2 === 0);
    for (let pass = 0; pass < 2 && pts.length > 2; pass++) { const sm = [pts[0]]; for (let k = 0; k < pts.length - 1; k++) { sm.push(mid(pts[k], pts[k + 1], 0.25), mid(pts[k], pts[k + 1], 0.75)); } sm.push(pts[pts.length - 1]); pts = sm; }
    return { pts, bad, len: cells.length * CELL, cells: cells.map(([i, j]) => key(i, j)) };
  }
  // longest stretch of a line that stays on open ground
  const cleanRun = (pts) => { let best = [], cur = []; pts.forEach((p) => { if (blocked(p)) { if (cur.length > best.length) best = cur; cur = []; } else cur.push(p); }); if (cur.length > best.length) best = cur; return best.length >= 3 ? best : null; };
  return { route, snap, blocked, cleanRun };
}

function predict(prop, wx, an) {
  const rings = ringsOf(prop), boundary = rings.length ? rings : null;
  let beds = prop.features.filter((f) => f.type === 'bedding').map((f) => ({ name: f.name, c: P.centroid(f.coords) }));
  let foods = prop.features.filter((f) => f.type === 'food').map((f) => ({ name: f.name, c: P.centroid(f.coords) }));
  let pinches = prop.features.filter((f) => f.type === 'pinch').map((f) => f.coords[0]);
  let inferred = false;
  if ((!beds.length || !foods.length) && an) {
    const t = terrainAnchors(an, boundary);
    if (!beds.length) beds = t.beds; if (!foods.length) foods = t.foods; if (!pinches.length) pinches = t.pinches; inferred = true;
  }
  // ---- terrain and water pull deer along benches and creek edges; water itself is avoided
  const waters = prop.features.filter((f) => f.type === 'water' && f.kind === 'polygon').map((f) => f.coords);
  const inWater = (p) => waters.some((w) => P.pointInPoly(p, w));
  const terrainRoutes = [];
  if (an) {
    const cs = an.cells.filter((c) => c.role === 'bench' && inAny(boundary || [], P.offset(an.center.lat, an.center.lng, c.x, c.y)) || (!boundary && c.role === 'bench'));
    const key = (c) => c.i + ',' + c.j, byKey = new Map(cs.map((c) => [key(c), c])), seenK = new Set();
    const comps = [];
    cs.forEach((c) => { if (seenK.has(key(c))) return; const comp = [], q = [c]; seenK.add(key(c)); while (q.length) { const x = q.pop(); comp.push(x); for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const n = byKey.get((x.i + di) + ',' + (x.j + dj)); if (n && !seenK.has(key(n))) { seenK.add(key(n)); q.push(n); } } } comps.push(comp); });
    comps.filter((c) => c.length >= 4).sort((a, b) => b.length - a.length).slice(0, 2).forEach((comp, k) => {
      const mx = comp.reduce((a, c) => a + c.x, 0) / comp.length, my = comp.reduce((a, c) => a + c.y, 0) / comp.length;
      let sxx = 0, sxy = 0, syy = 0; comp.forEach((c) => { sxx += (c.x - mx) ** 2; sxy += (c.x - mx) * (c.y - my); syy += (c.y - my) ** 2; });
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
      const sorted = comp.slice().sort((a, b) => (a.x * ux + a.y * uy) - (b.x * ux + b.y * uy));
      const pts = sorted.map((c) => P.offset(an.center.lat, an.center.lng, c.x, c.y));
      terrainRoutes.push({ kind: 'bench', name: 'Bench travel route ' + (k + 1), pts, why: 'Deer like to walk the flat shelf (bench) on a slope: easy footing, cover above and below, and a wide view downhill.' });
    });
  }
  prop.features.filter((f) => f.type === 'stream' && f.kind === 'line' && f.coords.length >= 2).forEach((f, k) => {
    const pts = f.coords; if (boundary && !pts.some((p) => inAny(boundary, p))) return;
    terrainRoutes.push({ kind: 'water', name: (f.name || 'Creek') + ' edge route', pts: pts.map((p) => P.offset(p[0], p[1], 12, 0)), why: 'Deer commonly travel parallel to creeks and drains for water, cover and cool air, and cross at shallow spots.' });
  });
  const ctx = prop.context;
  if (ctx) {
    const c0 = [prop.center.lat, prop.center.lng], dev = ctx.developed;
    const ok = (o) => o.acres >= 2 && P.distM(P.centroid(o.coords), c0) < 900 && !dev.some((d) => P.pointInPoly(P.centroid(o.coords), d.coords));
    const generic = /^(forest|wood|scrub|farmland|meadow|orchard|grassland|heath)$/;
    const near = (list, k, label) => list.filter(ok).sort((a, b) => P.distM(P.centroid(a.coords), c0) - P.distM(P.centroid(b.coords), c0)).slice(0, k).map((o) => ({ name: label + (o.name && !generic.test(o.name) ? ' ' + o.name : ''), c: P.centroid(o.coords), off: true }));
    beds = beds.concat(near(ctx.cover, 3, 'Neighbor timber'));
    foods = foods.concat(near(ctx.food, 3, 'Neighbor field'));
  }
  const rt = makeRouter(prop, an);
  beds = beds.map((b) => ({ ...b, c: rt.snap(b.c) })).filter((b) => b.c);
  foods = foods.map((f) => ({ ...f, c: rt.snap(f.c) })).filter((f) => f.c);
  const touches = (pts) => !boundary || pts.some((p) => inAny(boundary, p) || boundary.some((r) => r.some((q) => P.distM(p, q) < 40)));
  const ix = Wild.intel(prop);
  const paths = [];
  beds.forEach((b) => {
    foods.map((f) => ({ f, d: P.distM(b.c, f.c) })).filter((x) => x.d > 25).sort((a, c) => a.d - c.d).slice(0, 2).forEach(({ f }) => {
      // bend the line through the pinch nearest the straight segment
      let via = null, best = 70;
      pinches.forEach((p) => { const d = P.distToSeg ? P.distToSeg(p, b.c, f.c) : P.distM(p, mid(b.c, f.c)); if (d < best) { best = d; via = p; } });
      const a = b.c, z = f.c, vs = via ? rt.snap(via) : null, v = vs || mid(a, z);
      let pts;
      const r1 = vs ? rt.route(a, vs) : null, r2 = vs ? rt.route(vs, z) : null, rd = rt.route(a, z);
      if (r1 && r2 && r1.bad + r2.bad < 0.1 && (!rd || r1.len + r2.len < rd.len * 1.6)) pts = r1.pts.concat(r2.pts.slice(1));
      else if (rd && rd.bad < 0.1) pts = rd.pts;
      else return; // the only way between them is through water or a yard: deer will not use it
      const hits = prop.sightings.filter((s) => pts.some((p) => P.distM(p, [s.lat, s.lng]) < 40)).length;
      const off = !touches(pts);
      const zone = ix.zones.find((z) => pts.some((q) => P.distM(q, [z.lat, z.lng]) < z.r));
      paths.push({ off, predator: zone ? zone.label : null, name: `${b.name} ⇄ ${f.name}`, pts, via: v, pinch: !!via, sightings: hits, from: b.name, to: f.name, strength: round(Math.min(1, 0.35 + hits * 0.12 + (via ? 0.25 : 0)) * (zone ? 0.8 : 1), 2) });
    });
  });
  terrainRoutes.forEach((t) => {
    t.pts = rt.cleanRun(t.pts); if (!t.pts) return;
    const hits = prop.sightings.filter((s) => t.pts.some((p) => P.distM(p, [s.lat, s.lng]) < 45)).length;
    const zone = ix.zones.find((z) => t.pts.some((q) => P.distM(q, [z.lat, z.lng]) < z.r));
    paths.push({ predator: zone ? zone.label : null, name: t.name, pts: t.pts, via: t.pts[Math.floor(t.pts.length / 2)], pinch: false, sightings: hits, from: t.name, to: '', terrain: t.kind, why: t.why, strength: round(Math.min(1, 0.4 + hits * 0.12) * (zone ? 0.8 : 1), 2) });
  });
  // a route that crosses open water is much less likely
  paths.forEach((p) => { const wet = p.pts.filter(inWater).length / p.pts.length; if (wet > 0.3 && !p.terrain) { p.strength = round(p.strength * (1 - Math.min(0.6, wet)), 2); p.water = Math.round(wet * 100); } });
  paths.sort((a, b) => b.strength - a.strength);

  // stand sites: downwind of the crossing so scent blows away from the trail
  const winds = wx ? wx.hours.filter((h) => h.ms > Date.now() && h.ms < Date.now() + 48 * 3600000).map((h) => h.windDir) : [];
  const wind = winds.length ? vecMeanDir(winds) : 270;
  const existing = prop.features.filter((f) => f.type === 'stand');
  const sites = [];
  paths.filter((p) => !p.off).slice(0, 5).forEach((p) => {
    const at = p.pinch ? p.via : p.pts[5];
    const down = P.norm360(wind + 180) * P.D2R; // wind blows toward this bearing
    let spot = null;
    for (const dist of [20, 15, 11]) {
      const cand = ll(at, Math.sin(down) * dist, Math.cos(down) * dist);
      if (!boundary || inAny(boundary, cand)) { spot = cand; break; }
    }
    if (!spot || rt.blocked(spot)) return;
    if (prop.features.some((f) => f.type === 'house' && P.distM(f.coords[0], spot) < 70)) return; // too close to a house
    const near = existing.find((s) => P.distM(s.coords[0], spot) < 45);
    if (near || sites.some((s) => P.distM(s.coords, spot) < 45)) return;
    const brg = P.bearing(spot, at); // wind must come FROM the trail side toward the stand => wind dir ≈ bearing(stand→trail)
    sites.push({ name: `Suggested setup ${sites.length + 1}`, coords: spot, trail: p.name, goodWinds: P.compass(brg) + ' (±45°)', why: `${p.pinch ? 'Pinch point on' : 'Crossing on'} ${p.name}${p.sightings ? `, ${p.sightings} logged sighting${p.sightings > 1 ? 's' : ''} within 40 m` : ''}. Set 12 to 22 yards off the trail (bow range), downwind so the ${P.compass(P.norm360(wind))} prevailing wind carries your scent away.`, score: round(p.strength * 10, 1) });
  });
  const relief = an ? Math.round((an.maxM - an.minM) * 3.28) : null;
  const summary = { reliefFt: relief, benches: an ? an.cells.filter((c) => c.role === 'bench').length : 0, drains: an ? an.cells.filter((c) => c.role === 'drain').length : 0, ponds: waters.length, streams: prop.features.filter((f) => f.type === 'stream').length };
  const bld = (prop.context && prop.context.buildings || []).length;
  return { beds: beds.map((b) => ({ name: b.name, c: b.c })), foods: foods.map((f) => ({ name: f.name, c: f.c })), houses: bld, offProperty: paths.filter((p) => p.off).length, caveat: 'Routes are terrain and land-cover guesses. They avoid water, houses and yards, but only camera sightings can confirm them.', terrain: summary, inferred, windFrom: round(wind), paths, sites, existingCovered: existing.length, predatorPressure: ix.pressure };
}


/* ---------- a beginner's scouting walk: where to start, where to go, what to look for ---------- */
function scoutStart(prop, boundary, rt) {
  const sf = prop.features.find((f) => f.type === 'start');
  if (sf) return { start: sf.coords[0], assumed: false };
  const refs = []; ((prop.context && prop.context.roads) || []).forEach((r) => r.coords.forEach((c) => refs.push(c)));
  prop.features.filter((f) => f.type === 'house').forEach((f) => f.coords.forEach((c) => refs.push(c)));
  const edge = []; boundary.forEach((r) => r.forEach((p) => edge.push(p)));
  return { start: edge.slice().sort((a, b) => (refs.length ? Math.min(...refs.map((q) => P.distM(q, a))) - Math.min(...refs.map((q) => P.distM(q, b))) : 0))[0], assumed: true };
}
/* the walk the hunter builds: their own points of interest, routed around water and yards, and back out a different way */
function walkRoute(prop, an, startPt, points, reorder) {
  const rings = ringsOf(prop), boundary = rings.length ? rings : null;
  const rt = makeRouter(prop, an, { avoidBed: true, scout: true });
  const sres = startPt ? { start: startPt, assumed: false } : boundary ? scoutStart(prop, boundary, rt) : { start: points[0], assumed: true };
  const start = rt.snap(sres.start) || sres.start, used = new Set(), warnings = [];
  let order = points.map((_, i) => i);
  if (reorder) { order = []; let cu = start, lf = points.map((p, i) => ({ p, i })); while (lf.length) { lf.sort((a, b) => P.distM(cu, a.p) - P.distM(cu, b.p)); const nx = lf.shift(); order.push(nx.i); cu = nx.p; } points = order.map((i) => points[i]); }
  let pts = [start], dist = 0, cur = start;
  points.forEach((p, i) => {
    const sp = rt.snap(p) || p, r = rt.route(cur, sp);
    if (r && r.bad < 0.1) { pts = pts.concat(r.pts.slice(1)); dist += r.len; r.cells.forEach((c) => used.add(c)); }
    else { pts.push(sp); dist += P.distM(cur, sp); warnings.push(`The way to point ${i + 1} crosses water or a yard.`); }
    cur = sp;
  });
  const back = rt.route(cur, start, used);
  if (back && back.bad < 0.1) { pts = pts.concat(back.pts.slice(1)); dist += back.len; }
  else { pts.push(start); dist += P.distM(cur, start); if (points.length) warnings.push('The way back to your start crosses water or a yard.'); }
  return { order, start, startAssumed: sres.assumed, pts, distM: Math.round(dist), minutes: Math.round(dist / 40 + points.length * 4), warnings };
}
function scoutPlan(prop, wx, an, opts = {}) {
  const rings = ringsOf(prop), boundary = rings.length ? rings : null;
  if (!boundary) return { error: 'Draw or pick the property boundary first so I know where you are allowed to walk.' };
  const pr = predict(prop, wx, an), rt = makeRouter(prop, an, { avoidBed: true, scout: true });
  const sres = scoutStart(prop, boundary, rt); let start = sres.start; const startAssumed = sres.assumed;
  start = rt.snap(start) || start;
  const winds = wx ? S.wxAt(wx, Date.now()) : null, wFrom = winds ? winds.windDir : null, wMph = winds ? Math.round(winds.windMph) : null;
  const toward = wFrom == null ? null : P.norm360(wFrom + 180); // your scent travels this way
  const tips = [
    wFrom != null ? `Wind is from ${P.compass(wFrom)} at ${wMph} mph. Walk with it in your face or from the side when you head toward bedding, so deer do not smell you coming.` : 'Check the wind before you go and keep it in your face when heading toward bedding.',
    'Scout in the middle of the day. Deer are bedded then, and you will not push them off their feeding trails at dawn or dusk.',
    'Stay on the edges. Never walk through a bedding area; look at it from a distance.',
    'Walk slowly: stop every 20 steps and look ahead. Write down or mark every rub, scrape, trail and bed you see.',
    'Wear rubber boots and keep your gloves and clothes clean of scent. Do not touch trees or branches more than you need to.',
    'Mark what you find on the map (scrape, pinch point, stand) so the plan gets better each trip.',
  ];
  const tipFor = (st) => {
    if (toward == null || st.kind === 'camera') return '';
    const nb = pr.beds.length ? pr.beds.slice().sort((a, b) => P.distM(st.c, a.c) - P.distM(st.c, b.c))[0] : null;
    return nb && P.distM(st.c, nb.c) < 160 && P.angDiff(toward, P.bearing(st.c, nb.c)) < 45 ? `Wind check: with the wind from ${P.compass(wFrom)}, your scent blows toward ${nb.name} from here. Do this stop on a wind from ${P.compass(P.norm360(wFrom + 180))} instead if you can.` : '';
  };
  const cand = [];
  const add = (c, name, why, look, pri, kind) => { const sp = rt.snap(c); if (!sp || !(inAny(boundary, sp))) return; if (prop.features.some((f) => f.type === 'bedding' && f.kind === 'polygon' && P.pointInPoly(sp, f.coords))) return; const wet = prop.features.some((f) => f.type === 'water' && /Forested|Emergent/.test(f.wet || '') && P.pointInPoly(sp, f.coords)); cand.push({ c: sp, name, why: why + (wet ? ' This is wet ground (swamp or marsh): wear waterproof boots and test each step.' : ''), look, pri, kind }); };
  prop.features.filter((f) => f.type === 'camera').forEach((f) => add(f.coords[0], 'Check ' + f.name, 'Swap the memory card and check the battery. Go in quietly and leave quickly.', ['Card and battery', 'Fresh tracks on the way in'], 1, 'camera'));
  pr.paths.filter((p) => !p.off).slice(0, opts.candidates ? 8 : 4).forEach((p) => {
    const at = p.pinch ? p.via : p.pts[Math.floor(p.pts.length / 2)];
    add(at, p.terrain === 'bench' ? 'Bench trail' : p.terrain === 'water' ? 'Creek edge' : p.pinch ? 'Pinch point' : 'Travel route', p.terrain ? p.why : `Deer likely walk between ${p.from} and ${p.to} here.`,
      ['Tracks in soft dirt or mud (heart-shaped, points forward)', 'Rubs: bark rubbed off saplings, 2 to 4 ft up', 'Droppings: shiny and moist means fresh', 'A worn trail through the leaves'], 2, 'route');
  });
  pr.sites.slice(0, opts.candidates ? 3 : 2).forEach((s) => add(s.coords, s.name.replace('Suggested setup', 'Possible stand'), s.why, ['A sturdy tree with cover behind you', 'Shooting lanes cleared to 25 yards or less (bow range)', 'How you would walk in and out without crossing the trail'], 3, 'stand'));
  if (!cand.some((c) => c.kind === 'stand')) { const bs = bestSpot(prop, an); if (bs) add(bs.coords, 'Possible stand', bs.why, ['A sturdy tree with cover behind you', 'Shooting lanes cleared to 25 yards or less (bow range)', 'How you would walk in and out without crossing the trail'], 3, 'stand'); }
  if (an) {
    const TW = { bench: 3, drain: 2.5, ridge: 2 }, TX = {
      bench: ['Bench (flat shelf on a slope)', 'Deer like to walk and bed on benches: easy footing, cover above and below, a view downhill.', ['Beds: oval flattened spots in the leaves', 'A worn trail along the shelf', 'Rubs on saplings']],
      drain: ['Drain (low line where the ground funnels)', 'Deer cross drains and creeks at the easy spots, and cold air flows down them at night.', ['Crossings: tracks in mud on both banks', 'A trail leading down into it', 'Scat near the crossing']],
      ridge: ['Ridge top', 'Deer travel ridges because they can see and smell danger from both sides.', ['A trail along the top', 'Beds on the sheltered side', 'Rubs and scrapes along the line']],
    };
    const cs = an.cells.filter((c) => TW[c.role]).map((c) => ({ c, p: P.offset(an.center.lat, an.center.lng, c.x, c.y) })).filter((o) => inAny(boundary, o.p) && !rt.blocked(o.p));
    const tp = [];
    cs.sort((x, y) => TW[y.c.role] - TW[x.c.role] || y.c.slope - x.c.slope).forEach((o) => { if (tp.length < 4 && tp.every((q) => P.distM(q.p, o.p) > 60)) tp.push(o); });
    tp.forEach((o) => add(o.p, TX[o.c.role][0], TX[o.c.role][1], TX[o.c.role][2], 2.8, 'route'));
  }
  if (opts.candidates) {
    prop.features.filter((f) => f.type === 'water' && /Forested|Emergent/.test(f.wet || '') && f.coords.some((q) => inAny(boundary, q))).slice(0, 4).forEach((f) => add(P.centroid(f.coords), /Forested/.test(f.wet) ? 'Swamp edge' : 'Marsh edge', 'Deer use the edges of wet ground for cover, water and travel. Walk the dry edge, not through it.', ['Tracks in the mud at the edge', 'Trails going in or out of the thick cover', 'Rubs and browsed twigs'], 2.5, 'route'));
    prop.features.filter((f) => f.type === 'food' && f.kind === 'polygon').slice(0, 3).forEach((f) => add(P.centroid(f.coords), 'Food source: ' + f.name, 'Check the edge of the food for tracks and droppings. Look from the edge at dawn or dusk but never walk through it.', ['Browsed plants or eaten acorns', 'Fresh droppings and tracks', 'Trails leading to it'], 2.6, 'route'));
  }
  pr.beds.slice(0, opts.candidates ? 3 : 2).forEach((b) => { const ring = boundary[0]; if (inAny(boundary, b.c)) add(P.offset(b.c[0], b.c[1], 0, -70), 'Look toward bedding', 'Do not walk into bedding. Stop here and glass it from a distance.', ['Thick cover, ridge tops, south-facing slopes', 'Oval flattened beds in the leaves', 'Fresh tracks heading in or out'], 4, 'bed'); });
  // keep the best few, spread out
  const picked = [];
  cand.sort((a, b) => a.pri - b.pri).forEach((c) => { if (picked.length < (opts.candidates ? 12 : 8) && picked.every((q) => P.distM(q.c, c.c) > (opts.candidates ? 35 : 40)) && P.distM(start, c.c) > 25) picked.push(c); });
  if (!picked.length) return { error: 'I could not find a good place to send you. Add a trail camera, bedding or food area, or a pinch point, then try again.' };
  if (opts.candidates) {
    const ord = []; let cu = start, lf = picked.slice();
    while (lf.length) { lf.sort((a, b) => P.distM(cu, a.c) - P.distM(cu, b.c)); const nx = lf.shift(); ord.push(nx); cu = nx.c; }
    return { start, startAssumed, windFrom: wFrom, windMph: wMph, tips, candidates: ord.map((c, i) => ({ id: 'c' + i, n: i + 1, name: c.name, why: c.why, look: c.look, wind: tipFor(c), kind: c.kind, coords: c.c })) };
  }
  // walk order: nearest next, back to the start at the end
  const order = []; let cur = start, left = picked.slice();
  while (left.length) { left.sort((a, b) => P.distM(cur, a.c) - P.distM(cur, b.c)); const nx = left.shift(); order.push(nx); cur = nx.c; }
  let pts = [start], dist = 0; const stops = [];
  cur = start;
  order.forEach((st) => {
    const r = rt.route(cur, st.c);
    if (!r || r.bad > 0.1) return; // only way there is through water or a yard
    pts = pts.concat(r.pts.slice(1)); dist += r.len; cur = st.c;
    const tip = tipFor(st);
    stops.push({ n: stops.length + 1, name: st.name, coords: st.c, why: st.why, look: st.look, wind: tip, kind: st.kind });
  });
  if (!stops.length) return { error: 'Every route to the good spots goes through water or yards. Try placing a Start marker closer to the land.' };
  const back = rt.route(cur, start); if (back && back.bad < 0.1) { pts = pts.concat(back.pts.slice(1)); dist += back.len; }
  return { start, startAssumed, pts, stops, tips, distM: Math.round(dist), minutes: Math.round(dist / 40 + stops.length * 4), windFrom: wFrom, windMph: wMph, note: 'A starting plan from terrain and land cover. Adjust for what you actually see on the ground.' };
}

/* Fallback when no route-based setup fits: the best open, dry spot on the land itself (benches/ridges first), clear of houses and existing stands. */
function bestSpot(prop, an) {
  if (!an) return null;
  const rings = ringsOf(prop), boundary = rings.length ? rings : null, rt = makeRouter(prop, an);
  const houses = []; prop.features.filter((f) => f.type === 'house').forEach((f) => f.coords.forEach((c) => houses.push(c)));
  ((prop.context && prop.context.buildings) || []).forEach((b) => houses.push(P.centroid(b.coords)));
  const stands = prop.features.filter((f) => f.type === 'stand').map((f) => f.coords[0]);
  const W = { bench: 3, ridge: 2, drain: 1.5, slope: 1, flat: 0.5, basin: 0 };
  let best = null;
  an.cells.forEach((c) => {
    const p = P.offset(an.center.lat, an.center.lng, c.x, c.y);
    if (boundary && !inAny(boundary, p)) return;
    if (rt.blocked(p) || stands.some((q) => P.distM(q, p) < 45) || houses.some((q) => P.distM(q, p) < 70)) return;
    let sc = W[c.role] != null ? W[c.role] : 0;
    if (boundary) { const edge = Math.min(...boundary.map((r) => P.distToLine(p, r.concat([r[0]])))); if (edge < 12) return; sc += Math.min(edge, 60) / 60; }
    if (prop.sightings.length) sc += Math.min(2, prop.sightings.filter((x) => P.distM(p, [x.lat, x.lng]) < 60).length * 0.4);
    if (!best || sc > best.sc) best = { sc, coords: p, role: c.role };
  });
  if (!best) return null;
  return { coords: best.coords, why: `Open, dry ground${best.role !== 'flat' ? ' on a ' + best.role : ''}, away from houses and your other stands. This is a terrain pick, not a confirmed deer trail.` };
}

/* ---------- home dashboard ---------- */
async function summary(prop, lite) {
  const out = { id: prop.id, name: prop.name, address: prop.address || '', center: prop.center, permission: prop.parcel ? prop.parcel.permission : '', owner: prop.parcel ? prop.parcel.owner : '' };
  const rs = ringsOf(prop);
  out.boundaries = rs; out.boundary = rs[0] || null;
  out.acres = (prop.parcel && prop.parcel.acres) || round(rs.reduce((a, r) => a + (acresOf(r) || 0), 0), 1) || null;
  const now = Date.now();
  out.counts = { cameras: prop.features.filter((f) => f.type === 'camera').length, stands: prop.features.filter((f) => f.type === 'stand').length, sightings: prop.sightings.length,
    recent: prop.sightings.filter((s) => now - s.ts < 48 * 3600000).length, bucks: prop.bucks.length, pins: prop.pins.length };
  const notes = [];
  if (!lite) try {
    const wx = await S.getWeather(prop), w = S.wxAt(wx, now);
    const tr12 = S.trend(wx, now, 12), later = S.wxAt(wx, now + 12 * 3600000);
    out.weather = { tempF: w.tempF, windMph: w.windMph, windDir: w.windDir, compass: P.compass(w.windDir), pressureInHg: w.pressureInHg, trend: tr12, cloud: w.cloud, precip: w.precip, source: wx.source };
    out.forecast = [0, 1, 2].map((d) => { const day = wx.hours.filter((h) => h.ms >= now + d * 86400000 && h.ms < now + (d + 1) * 86400000); return day.length ? { hi: Math.round(Math.max(...day.map((h) => h.tempF))), lo: Math.round(Math.min(...day.map((h) => h.tempF))), wind: P.compass(vecMeanDir(day.map((h) => h.windDir))), precip: Math.max(...day.map((h) => h.precip)) } : null; });
    if (tr12 > 0.06) notes.push({ level: 'hot', text: `Pressure climbing (+${tr12} inHg/12h): post-front movement window` });
    else if (tr12 < -0.06) notes.push({ level: 'hot', text: `Pressure falling (${tr12} inHg/12h): deer feed hard ahead of the front` });
    if (P.angDiff(w.windDir, later.windDir) > 60) notes.push({ level: 'warn', text: `Wind swings ${P.compass(w.windDir)} to ${P.compass(later.windDir)} in 12h: re-check stand choice` });
    if (w.tempF < 40) notes.push({ level: 'info', text: `Cold ${Math.round(w.tempF)}°F: deer up and moving in daylight` });
    if (w.precip > 60) notes.push({ level: 'warn', text: `${w.precip}% chance of precipitation` });
    if (prop.features.some((f) => f.type === 'stand')) {
      const plan = await S.planHunt(prop, '');
      if (plan && plan.best) { out.best = { stand: plan.best.standName, window: plan.best.window, scent: plan.best.scent.status, score: plan.best.score }; notes.unshift({ level: plan.best.scent.status === 'green' ? 'good' : 'info', text: `Best sit: ${plan.best.standName}, ${plan.best.window} (scent ${plan.best.scent.status})` }); }
    }
  } catch (e) { out.weather = null; }
  if (out.counts.recent) notes.push({ level: 'good', text: `${out.counts.recent} new deer sighting${out.counts.recent > 1 ? 's' : ''} in the last 48h` });
  if (!out.counts.cameras) notes.push({ level: 'info', text: 'No trail cameras placed yet' });
  if (!out.counts.stands) notes.push({ level: 'info', text: 'No stands yet. Open the property for suggested setups' });
  const wi = Wild.intel(prop);
  wi.alerts.forEach((a) => notes.push(a));
  out.targets = prop.targets || ['deer']; out.pressure = wi.pressure;
  out.notifications = notes;
  return out;
}

async function overpass(q) {
  let err = '';
  for (const u of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']) {
    try {
      const r = await fetch(u, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'CabinScout/1.0' }, signal: AbortSignal.timeout(25000) });
      if (r.ok) return r.json();
      err = 'HTTP ' + r.status;
    } catch (e) { err = e.message; }
  }
  throw new Error('OpenStreetMap servers are busy (' + err + '). Try again in a minute.');
}
const bboxOf = (prop, pad) => {
  const rs = ringsOf(prop);
  const pts = rs.length ? rs.flat() : [[prop.center.lat, prop.center.lng]];
  return [Math.min(...pts.map((p) => p[0])) - pad, Math.min(...pts.map((p) => p[1])) - pad, Math.max(...pts.map((p) => p[0])) + pad, Math.max(...pts.map((p) => p[1])) + pad].join(',');
};
/* Land around the property (about 1 km): timber, fields, houses, roads. Deer don't stop at the fence line, so the predictor needs it. */
async function importContext(prop) {
  const bb = bboxOf(prop, 0.007);
  const retry = async (q) => { for (let i = 0; i < 3; i++) { try { return await overpass(q); } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 2500)); } } };
  const j = await retry(`[out:json][timeout:25];(way["landuse"~"forest|farmland|meadow|orchard|residential|industrial|commercial"](${bb});way["natural"~"wood|scrub|grassland|heath"](${bb}););out geom 400;`);
  const rj = await retry(`[out:json][timeout:25];way["highway"~"primary|secondary|tertiary|residential|unclassified|track"](${bb});out geom 200;`).catch(() => ({ elements: [] }));
  j.elements = (j.elements || []).concat(rj.elements || []);
  const bj = await retry(`[out:json][timeout:25];way["building"](${bb});out geom 900;`).catch(() => ({ elements: [] }));
  const ctx = { cover: [], food: [], developed: [], roads: [], buildings: [], v: 2, ts: Date.now() };
  (bj.elements || []).forEach((el) => { if (el.geometry && el.geometry.length >= 3 && ctx.buildings.length < 900) ctx.buildings.push({ coords: el.geometry.map((g) => [Math.round(g.lat * 1e6) / 1e6, Math.round(g.lon * 1e6) / 1e6]).slice(0, -1) }); });
  (j.elements || []).forEach((el) => {
    if (!el.geometry || el.geometry.length < 3) return;
    const t = el.tags || {}, c = el.geometry.map((g) => [Math.round(g.lat * 1e6) / 1e6, Math.round(g.lon * 1e6) / 1e6]);
    if (t.highway) { if (ctx.roads.length < 80) ctx.roads.push({ name: t.name || t.highway, coords: c }); return; }
    const closed = c.length > 3 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1]; if (!closed) return; c.pop();
    const kind = t.landuse || t.natural, o = { name: t.name || kind, coords: c, acres: acresOf(c) };
    if (/forest|wood|scrub/.test(kind)) ctx.cover.push(o);
    else if (/farmland|meadow|orchard|grassland|heath/.test(kind)) ctx.food.push(o);
    else ctx.developed.push(o);
  });
  ['cover', 'food', 'developed'].forEach((k) => { ctx[k] = ctx[k].sort((a, b) => b.acres - a.acres).slice(0, 60); });
  prop.context = ctx;
  return { cover: ctx.cover.length, fields: ctx.food.length, developed: ctx.developed.length, roads: ctx.roads.length };
}

/* ---------- real water from OpenStreetMap: ponds, wetlands, streams ---------- */
/* USGS / US Fish & Wildlife National Wetlands Inventory: the swamps, marshes, ponds and rivers drawn on the USGS topo map */
const NWI = 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query';
const WET = {
  'Freshwater Forested/Shrub Wetland': { kind: 'Swamp (forested / shrub wetland)', color: '#14B8A6' },
  'Freshwater Emergent Wetland': { kind: 'Marsh (emergent wetland)', color: '#A3B83A' },
  'Freshwater Pond': { kind: 'Pond', color: '#3B82F6' },
  'Lake': { kind: 'Lake', color: '#2563EB' },
  'Riverine': { kind: 'River / stream channel', color: '#38BDF8' },
  'Estuarine and Marine Wetland': { kind: 'Tidal wetland', color: '#14B8A6' },
  'Other': { kind: 'Wetland', color: '#14B8A6' },
};
async function importNWI(prop, uid) {
  const [s0, w0, n0, e0] = bboxOf(prop, 0.006).split(',').map(Number);
  const u = `${NWI}?where=1%3D1&geometry=${w0},${s0},${e0},${n0}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=ATTRIBUTE,WETLAND_TYPE,ACRES&returnGeometry=true&geometryPrecision=6&resultRecordCount=700&f=geojson`;
  const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('NWI HTTP ' + r.status);
  const j = await r.json(); if (j.error) throw new Error('NWI: ' + (j.error.message || 'error'));
  let n = 0;
  (j.features || []).forEach((f) => {
    const g = f.geometry; if (!g) return;
    const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((q) => q[0]) : [];
    const pr = f.properties || {}, info = WET[pr.WETLAND_TYPE] || WET.Other;
    rings.forEach((ring) => {
      const c = ring.map(([x, y]) => [Math.round(y * 1e6) / 1e6, Math.round(x * 1e6) / 1e6]); if (c.length > 3) c.pop();
      if (c.length < 3) return;
      const ac = acresOf(c);
      prop.features.push({ id: uid('f'), type: 'water', kind: 'polygon', name: `${info.kind}${ac ? ' · ' + ac + ' ac' : ''}`, wet: pr.WETLAND_TYPE || '', color: info.color, notes: 'US Fish & Wildlife National Wetlands Inventory (the same wetlands the USGS topo map shows).', coords: c, src: 'nwi' }); n++;
    });
  });
  return n;
}
async function importWater(prop, uid) {
  let nwi = 0, nwiOk = false, osmOk = false, err = '';
  const keep = prop.features.filter((f) => f.src !== 'osm' && f.src !== 'nwi');
  const before = prop.features; prop.features = keep;
  try { nwi = await importNWI(prop, uid); nwiOk = true; } catch (e) { err = e.message; }
  let ponds = nwi, streams = 0;
  try {
    const bb = bboxOf(prop, 0.002);
    const j = await overpass(`[out:json][timeout:20];(${nwiOk ? '' : `way["natural"~"water|wetland"](${bb});`}way["waterway"~"stream|river|ditch|drain|canal"](${bb}););out geom;`);
    osmOk = true;
    (j.elements || []).forEach((el) => {
      if (!el.geometry || el.geometry.length < 2) return;
      const coords = el.geometry.map((g) => [g.lat, g.lon]), t = el.tags || {};
      if (t.waterway) { prop.features.push({ id: uid('f'), type: 'stream', kind: 'line', name: t.name || (t.waterway[0].toUpperCase() + t.waterway.slice(1)) + ' (OSM)', coords, src: 'osm' }); streams++; }
      else if (coords.length > 3) { if (coords[0][0] === coords[coords.length - 1][0]) coords.pop(); prop.features.push({ id: uid('f'), type: 'water', kind: 'polygon', name: t.name || (t.natural === 'wetland' ? 'Wetland (OSM)' : 'Water (OSM)'), coords, src: 'osm' }); ponds++; }
    });
  } catch (e) { err = err || e.message; }
  if (!nwiOk && !osmOk) { prop.features = before; throw new Error(err || 'water services busy'); }
  if (!osmOk) prop.features = prop.features.concat(before.filter((f) => f.src === 'osm')); // keep old creeks if OSM is busy
  prop.waterV = 2; prop._an = null; // water changes the airflow model
  return { ponds, streams, wetlands: nwi };
}

module.exports = { summary, predict, bestSpot, scoutPlan, walkRoute, importWater, importContext };
