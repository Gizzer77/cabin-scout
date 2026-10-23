/* CabinScout physics + geo helpers. Runs in the browser (window.Physics) and Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Physics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const D2R = Math.PI / 180;
  const M_LAT = 111320;
  const mLng = (lat) => 111320 * Math.cos(lat * D2R);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const norm360 = (d) => ((d % 360) + 360) % 360;
  const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

  /* ---------- geo ---------- */
  const offset = (lat, lng, east, north) => [lat + north / M_LAT, lng + east / mLng(lat)];
  const toXY = (p, o) => [(p[1] - o[1]) * mLng(o[0]), (p[0] - o[0]) * M_LAT]; // [east, north] m
  const distM = (a, b) => { const [x, y] = toXY(b, a); return Math.hypot(x, y); };
  const bearing = (a, b) => { const [x, y] = toXY(b, a); return norm360(Math.atan2(x, y) / D2R); };
  const COMP = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (deg) => COMP[Math.round(norm360(deg) / 22.5) % 16];
  const FT = 3.28084;

  function pointInPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((xi > pt[1]) !== (xj > pt[1]) && pt[0] < ((yj - yi) * (pt[1] - xi)) / (xj - xi) + yi) inside = !inside;
    }
    return inside;
  }
  function centroid(poly) {
    let a = 0, b = 0;
    poly.forEach((p) => { a += p[0]; b += p[1]; });
    return [a / poly.length, b / poly.length];
  }
  function distToSeg(p, a, b) {
    const [px, py] = toXY(p, a), [bx, by] = toXY(b, a);
    const l2 = bx * bx + by * by;
    const t = l2 ? clamp((px * bx + py * by) / l2, 0, 1) : 0;
    return Math.hypot(px - t * bx, py - t * by);
  }
  function distToLine(p, line) {
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) best = Math.min(best, distToSeg(p, line[i], line[i + 1]));
    return best;
  }
  function polyAreaAcres(poly) {
    if (poly.length < 3) return 0;
    const o = poly[0]; let s = 0;
    const xy = poly.map((p) => toXY(p, o));
    for (let i = 0; i < xy.length; i++) { const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length]; s += x1 * y2 - x2 * y1; }
    return Math.abs(s / 2) / 4046.86;
  }
  function featurePoints(f, step = 10) {
    const c = f.coords || [];
    if (f.kind === 'point' || c.length === 1) return c.slice(0, 1);
    const out = [];
    const closed = f.kind === 'polygon';
    const n = closed ? c.length : c.length - 1;
    for (let i = 0; i < n; i++) {
      const a = c[i], b = c[(i + 1) % c.length];
      const len = distM(a, b), k = Math.max(1, Math.ceil(len / step));
      for (let s = 0; s < k; s++) out.push([a[0] + ((b[0] - a[0]) * s) / k, a[1] + ((b[1] - a[1]) * s) / k]);
    }
    if (!closed) out.push(c[c.length - 1]);
    if (closed) out.push(centroid(c));
    return out;
  }

  /* ---------- astronomy ---------- */
  function solarPos(lat, lng, utcMs) {
    const n = utcMs / 86400000 + 2440587.5 - 2451545.0;
    const L = norm360(280.46 + 0.9856474 * n);
    const g = norm360(357.528 + 0.9856003 * n) * D2R;
    const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
    const eps = (23.439 - 4e-7 * n) * D2R;
    const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
    const H = (norm360(280.46061837 + 360.98564736629 * n + lng)) * D2R - ra;
    const la = lat * D2R;
    const elev = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(la) - Math.tan(dec) * Math.cos(la)) + Math.PI;
    return { elev: elev / D2R, az: norm360(az / D2R) };
  }
  // sunrise/sunset (ms) within the 24h after dayStartUtcMs
  function sunTimes(lat, lng, dayStartUtcMs) {
    let rise = null, set = null, prev = solarPos(lat, lng, dayStartUtcMs).elev;
    for (let t = dayStartUtcMs + 300000; t <= dayStartUtcMs + 86400000; t += 300000) {
      const e = solarPos(lat, lng, t).elev;
      if (prev < -0.833 && e >= -0.833 && rise === null) rise = t;
      if (prev >= -0.833 && e < -0.833 && set === null) set = t;
      prev = e;
    }
    return { sunrise: rise, sunset: set };
  }
  function moonPhase(ms) {
    const LUN = 29.530588853;
    const jd = ms / 86400000 + 2440587.5;
    const age = (((jd - 2451550.1) % LUN) + LUN) % LUN;
    const illum = (1 - Math.cos((2 * Math.PI * age) / LUN)) / 2;
    const names = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
    const icons = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
    const idx = Math.floor(((age / LUN) * 8 + 0.5)) % 8;
    return { age, illum: Math.round(illum * 100), name: names[idx], icon: icons[idx] };
  }

  /* ---------- synthetic fallbacks (offline demo mode) ---------- */
  function syntheticElevation(kind, x, y) {
    if (kind === 'demo') {
      let t = smooth((-60 - y) / 520);
      t *= 1 + 0.3 * clamp(-x / 300, 0, 1);
      let z = 985 + clamp(t, 0, 1.2) * 406;
      z -= smooth((-60 - x) / 90) * 35;
      z += 3 * Math.sin(x / 45) * Math.cos(y / 55);
      if (y > 100) z -= (y - 100) * 0.05;
      return z / FT;
    }
    return 300 + 12 * Math.sin(x / 120) + 10 * Math.cos(y / 90) + 8 * Math.sin((x + y) / 70);
  }
  // Deterministic weather as a function of absolute time. A cold front passes every ~6 days.
  const FRONT_D0 = Date.UTC(2026, 9, 17) / 86400000 - 4.5;
  function synthWx(ms, lat, lng) {
    const days = ms / 86400000;
    const ph = (2 * Math.PI * (days - FRONT_D0)) / 6;
    const off = Math.round((lng || -73) / 15) - 0; // crude local-solar offset hours
    const lh = (((ms / 3600000 + off + (isDST(ms) ? 1 : 0)) % 24) + 24) % 24;
    const P = 30.0 + 0.25 * Math.sin(ph);
    return {
      tempF: Math.round((47 + 12 * Math.cos(ph) + 8 * Math.sin((2 * Math.PI * (lh - 9)) / 24)) * 10) / 10,
      pressureInHg: Math.round(P * 100) / 100,
      windMph: Math.round((5.5 + 4 * Math.abs(Math.cos(ph)) + 1.5 * Math.sin(lh / 3.8)) * 10) / 10,
      windDir: Math.round(norm360(270 - 45 * Math.cos(ph) + 10 * Math.sin(days * 3))),
      cloud: Math.round(clamp(50 + 40 * Math.cos(ph + 0.5), 0, 100)),
    };
  }
  function isDST(ms) {
    const d = new Date(ms), y = d.getUTCFullYear();
    const nth = (m, wd, n) => { const f = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + ((wd - f + 7) % 7) + (n - 1) * 7; };
    const start = Date.UTC(y, 2, nth(2, 0, 2), 7), end = Date.UTC(y, 10, nth(10, 0, 1), 6);
    return ms >= start && ms < end;
  }

  /* ---------- terrain ---------- */
  // grid: {n, spacing(m), center:{lat,lng}, elevM:[row j (south->north)][col i (west->east)]}
  function analyzeGrid(g) {
    const n = g.n, s = g.spacing, z = g.elevM;
    const Z = (i, j) => z[clamp(j, 0, n - 1)][clamp(i, 0, n - 1)];
    const cells = [];
    let minM = Infinity, maxM = -Infinity;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { minM = Math.min(minM, z[j][i]); maxM = Math.max(maxM, z[j][i]); }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const dzdx = (Z(i + 1, j) - Z(i - 1, j)) / (2 * s), dzdy = (Z(i, j + 1) - Z(i, j - 1)) / (2 * s);
        const slope = Math.atan(Math.hypot(dzdx, dzdy)) / D2R;
        const aspect = norm360(Math.atan2(-dzdx, -dzdy) / D2R); // downhill azimuth
        let sum = 0, cnt = 0, hi = -Infinity, lo = Infinity;
        for (let dj = -4; dj <= 4; dj++) for (let di = -4; di <= 4; di++) {
          const v = Z(i + di, j + dj);
          if (Math.abs(di) <= 3 && Math.abs(dj) <= 3) { sum += v; cnt++; }
          hi = Math.max(hi, v); lo = Math.min(lo, v);
        }
        const zc = z[j][i], rel = zc - sum / cnt;
        let role = 'flat';
        if (rel > 5) role = 'ridge';
        else if (rel < -3 && slope < 3) role = 'basin';
        else if (rel < -4) role = 'drain';
        else if (slope < 6 && hi - zc > 10 && zc - lo > 6) role = 'bench';
        else if (slope >= 6) role = 'slope';
        const x = (i - (n - 1) / 2) * s, y = (j - (n - 1) / 2) * s;
        cells.push({ i, j, x, y, z: zc, slope, aspect, role });
      }
    }
    return { n, spacing: s, center: g.center, cells, minM, maxM };
  }

  /* ---------- thermal + wind field ---------- */
  const SHELTER = { ridge: 1.2, bench: 0.85, slope: 0.9, flat: 0.9, drain: 0.6, basin: 0.5 };
  // wx: {windMph, windDir(from), cloud}; ctx: {utcMs}; waterFn(lat,lng)->bool
  function computeField(an, wx, ctx, waterFn) {
    const c = an.center;
    const sun = solarPos(c.lat, c.lng, ctx.utcMs);
    const sunE = sun.elev;
    const cloud = clamp((wx.cloud || 0) / 100, 0, 1);
    const heatN = sunE > 0 ? Math.min(1, (Math.sin(sunE * D2R) * (1 - 0.75 * cloud)) / 0.55) : 0;
    const cool = sunE < 4 ? clamp((4 - sunE) / 12, 0, 1) * (1 - 0.6 * cloud) : 0;
    const transition = sunE > -6 && sunE < 6;
    const ws = (wx.windMph || 0) * 0.447;
    const flowDir = norm360((wx.windDir || 0) + 180);
    const cells = an.cells.map((cell) => {
      const ah = 0.35 + 0.65 * Math.max(0, Math.cos(angDiff(cell.aspect, sun.az) * D2R));
      const up = heatN * ah, down = cool;
      let s = up - down * 0.9;
      let tmag = 0.9 * Math.abs(s) * Math.pow(Math.min(1, cell.slope / 10), 0.7);
      const sw = transition && (cell.slope > 2 || cell.role === 'drain' || cell.role === 'basin' || cell.role === 'bench');
      if (sw) tmag *= 0.3;
      const tdir = s > 0 ? norm360(cell.aspect + 180) : cell.aspect;
      const tu = tmag * Math.sin(tdir * D2R), tv = tmag * Math.cos(tdir * D2R);
      const sh = (SHELTER[cell.role] || 0.9) * 0.7;
      const wu = ws * sh * Math.sin(flowDir * D2R), wv = ws * sh * Math.cos(flowDir * D2R);
      const ll = offset(c.lat, c.lng, cell.x, cell.y);
      const upd = !!(waterFn && waterFn(ll[0], ll[1]) && sunE > -3 && sunE < 22);
      return {
        x: cell.x, y: cell.y, u: wu + tu, v: wv + tv, tu, tv, tmag, wu, wv,
        mode: sw ? 'switch' : s > 0.02 ? 'rising' : s < -0.02 ? 'falling' : 'calm',
        sw, upd, role: cell.role, slope: cell.slope,
      };
    });
    return { n: an.n, spacing: an.spacing, center: c, cells, sun, transition, sunE, utcMs: ctx.utcMs,
      mode: transition ? 'switch' : sunE >= 6 ? 'rising' : 'falling' };
  }
  function cellAt(field, east, north) {
    const n = field.n, s = field.spacing, h = (n - 1) / 2;
    const i = clamp(Math.round(east / s + h), 0, n - 1), j = clamp(Math.round(north / s + h), 0, n - 1);
    return field.cells[j * n + i];
  }
  function flowAt(field, east, north) {
    const n = field.n, s = field.spacing, h = (n - 1) / 2;
    const fx = clamp(east / s + h, 0, n - 1), fy = clamp(north / s + h, 0, n - 1);
    const i0 = Math.floor(fx), j0 = Math.floor(fy), i1 = Math.min(n - 1, i0 + 1), j1 = Math.min(n - 1, j0 + 1);
    const tx = fx - i0, ty = fy - j0;
    const g = (i, j, k) => field.cells[j * n + i][k];
    const bil = (k) => (g(i0, j0, k) * (1 - tx) + g(i1, j0, k) * tx) * (1 - ty) + (g(i0, j1, k) * (1 - tx) + g(i1, j1, k) * tx) * ty;
    const u = bil('u'), v = bil('v');
    return { u, v, speed: Math.hypot(u, v), dir: norm360(Math.atan2(u, v) / D2R), cell: cellAt(field, east, north) };
  }

  /* ---------- scent cone ---------- */
  const CORRIDOR = { pinch: 'pinch point', scrape: 'scrape', rubline: 'rub line' };
  function sectorLatLngs(o, az, half, len) {
    const pts = [[o[0], o[1]]];
    for (let a = -half; a <= half + 0.01; a += Math.max(3, half / 6)) {
      const b = (az + a) * D2R;
      pts.push(offset(o[0], o[1], len * Math.sin(b), len * Math.cos(b)));
    }
    return pts;
  }
  function scentCone(origin, field, features) {
    const c = field.center;
    const [ox, oy] = toXY(origin, [c.lat, c.lng]);
    const f = flowAt(field, ox, oy);
    const calm = f.speed < 0.3;
    const len = clamp(55 + f.speed * 55, 55, 240);
    const half = clamp(42 - f.speed * 7, 14, 42);
    const az = f.dir;
    const inCone = (p) => {
      const [dx, dy] = toXY(p, origin);
      const d = Math.hypot(dx, dy);
      if (d > len || d < 3) return false;
      return angDiff(norm360(Math.atan2(dx, dy) / D2R), az) <= half;
    };
    const hits = { bedding: [], corridor: [], food: [], buffer: [] };
    (features || []).forEach((ft) => {
      const key = ft.type === 'bedding' ? 'bedding' : CORRIDOR[ft.type] ? 'corridor' : ft.type === 'food' ? 'food' : (ft.type === 'buffer' || ft.type === 'house' || ft.type === 'road') ? 'buffer' : null;
      if (!key) return;
      const pts = ft.type === 'house' ? [0, 1, 2, 3, 4, 5, 6, 7].map((k) => offset(ft.coords[0][0], ft.coords[0][1], Math.sin(k * 0.785) * 18, Math.cos(k * 0.785) * 18)) : featurePoints(ft, 12);
      if (pts.some(inCone)) hits[key].push(ft.name);
    });
    let status = 'green', reason;
    const sw = f.cell && (f.cell.sw || field.transition);
    if (hits.bedding.length || hits.corridor.length) {
      status = 'red';
      reason = 'Scent runs straight into ' + [...hits.bedding.map((n) => 'bedding "' + n + '"'), ...hits.corridor.map((n) => 'travel corridor "' + n + '"')].join(' and ') + '.';
    } else if (calm || sw) {
      status = 'yellow';
      reason = calm ? 'Near-dead air: scent will pool and swirl around the stand.' : 'Thermal switch in progress: scent can eddy in any direction for ~45 min.';
    } else if (hits.food.length) {
      status = 'yellow';
      reason = 'Scent crosses the feeding area "' + hits.food[0] + '": marginal, deer may circle downwind of it.';
    } else if (hits.buffer.length) {
      reason = 'Scent drifts into the neighborhood/road buffer, away from deer.';
    } else if (f.cell && f.cell.mode === 'falling' && (f.cell.role === 'drain' || f.cell.role === 'basin')) {
      reason = 'Cold air drains down the creek/swamp bottom and carries your scent away from trails.';
    } else reason = 'Scent clears into open timber; no bedding or travel corridor is downwind.';
    return {
      status, reason, azimuth: Math.round(az), compass: compass(az), speedMph: Math.round((f.speed / 0.447) * 10) / 10,
      length: Math.round(len), halfAngle: Math.round(half), hits, mode: f.cell ? f.cell.mode : 'calm',
      polygon: sectorLatLngs(origin, az, half, len),
    };
  }

  return { D2R, clamp, smooth, norm360, angDiff, offset, toXY, distM, bearing, compass, FT, pointInPoly, centroid, distToSeg,
    distToLine, polyAreaAcres, featurePoints, solarPos, sunTimes, moonPhase, syntheticElevation, synthWx, isDST,
    analyzeGrid, computeField, cellAt, flowAt, scentCone, sectorLatLngs };
});
