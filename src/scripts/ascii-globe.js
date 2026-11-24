/**
 * ASCII globe: an orthographic globe drawn as a grid of characters on a <canvas>,
 * after the SYMAP-style line-printer maps.
 *
 *   – each continent has its own character, so the five read apart without colour
 *   – Taiwan is drawn in --globe-home (purple); the selected conference's whole country
 *     in --globe-pick (red)
 *   – on selection a thin white arc grows along the sphere from Taiwan to the city
 *
 * Data, both rasterised once from Natural Earth (world-atlas) at 0.5° (720 × 360 cells,
 * row 0 = 90°N, column 0 = 180°W):
 *   public/data/land.bin       1 bit per cell, land or sea
 *   public/data/countries.bin  ISO 3166 numeric code per cell, run-length encoded as
 *                              [code high byte, code low byte, run 1–255] …
 *
 *   const globe = await createGlobe(canvas, { landUrl, countriesUrl, center, home, cities, onFrame });
 *   globe.select([lat, lon])  turn to a place and grow the arc to it (null clears the selection)
 *   globe.intro()             a short turn into `home`, for the first time the globe is seen
 *   onFrame(point, busy)      after every frame: the selected place in canvas pixels ({ x, y },
 *                             or null on the far side) and whether the turn/arc is still running
 *   Drag the globe to turn it by hand.
 *
 * Nothing animates unless select()/intro() is called or the globe is dragged.
 */

const RAD = Math.PI / 180;
const COLS = 132;                         // characters across the frame
const RADIUS = 0.43;                      // globe radius as a share of the frame width: the globe spans the frame, which crops top and bottom
const TAIWAN = 158;                       // ISO 3166 numeric
const W = 720, H = 360;

// the five continents (and Antarctica), one character each
export const CONTINENTS = [
  { id: 'asia', ch: '+' },
  { id: 'europe', ch: 'x' },
  { id: 'africa', ch: '=' },
  { id: 'americas', ch: 'o' },
  { id: 'oceania', ch: '*' },
  { id: 'antarctica', ch: '-' },
];

/** Rough continent of a land cell, from lat/lon alone (good enough at this resolution). */
function continent(lat, lon) {
  if (lat < -60) return 5;
  if ((lon > 112 && lat < -10) || (lon > 130 && lat < 0) || (lon < -150 && lat < 30)) return 4;
  if (lon < -168 && lat > 50) return 0;                                   // Chukotka
  if (lon < -25 || (lon < -10 && lat > 68)) return 3;                     // the Americas, Greenland
  // Africa: south of the Mediterranean, west of the Red Sea (a line from Suez to Bab-el-Mandeb)
  const redSea = lat > 30 ? 32.4 : lat > 12.6 ? 43.3 - ((lat - 12.6) * 9.1) / 17.4 : 52;
  const mediterranean = lat < 35.9 ? !(lat > 34.8 && lon > 21) : lat < 37.6 && lon > 0 && lon < 12;
  if (lon >= -26 && lon < redSea && mediterranean) return 2;
  if (lon >= 60 || (lon > 26 && lat < 41.3) || (lon > 41 && lat < 47)) return 0;
  if (lat > 34) return 1;
  return 0;
}

const unit = ([lat, lon]) => {
  const p = lat * RAD, l = lon * RAD;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};
const toLatLon = ([x, y, z]) => [Math.asin(Math.max(-1, Math.min(1, z))) / RAD, Math.atan2(y, x) / RAD];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function slerp(a, b, t) {
  const om = angle(a, b);
  if (om < 1e-6) return b;
  const s = Math.sin(om), ka = Math.sin((1 - t) * om) / s, kb = Math.sin(t * om) / s;
  return [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
}
const cellOf = (lat, lon) => {
  const j = Math.min(H - 1, Math.max(0, Math.floor((90 - lat) * 2)));
  const i = (((Math.floor((lon + 180) * 2)) % W) + W) % W;
  return j * W + i;
};

export async function createGlobe(canvas, { landUrl, countriesUrl, center = [24.79, 121], home = center, cities = [], onFrame = () => {} }) {
  const [landBuf, countryBuf] = await Promise.all([landUrl, countriesUrl].map((u) => fetch(u).then((r) => r.arrayBuffer())));
  const bits = new Uint8Array(landBuf);
  const codes = new Uint16Array(W * H);
  { const b = new Uint8Array(countryBuf); let k = 0; for (let p = 0; p + 2 < b.length; p += 3) { codes.fill((b[p] << 8) | b[p + 1], k, k + b[p + 2]); k += b[p + 2]; } }
  const isLand = (lat, lon) => { const b = cellOf(lat, lon); return (bits[b >> 3] & (0x80 >> (b & 7))) !== 0; };
  const countryAt = (lat, lon) => codes[cellOf(lat, lon)];
  /** the country of a city; coastal cities may fall on a sea cell, so look one degree around */
  const countryNear = ([lat, lon]) => {
    for (let r = 0; r <= 2; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const c = countryAt(lat + dj * 0.5, lon + di * 0.5);
      if (c) return c;
    }
    return 0;
  };

  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let w = 0, h = 0, view = unit(center), active = null, pickCode = 0, arcT = 1, anim = 0, busy = false;
  const radius = () => Math.max(w * RADIUS, h * 0.6);

  function draw() {
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cell = w / COLS, rows = Math.ceil(h / cell), R = radius(), cx = w / 2, cy = h / 2;
    const [clat, clon] = toLatLon(view);
    const sp = Math.sin(clat * RAD), cp = Math.cos(clat * RAD), l0 = clon * RAD;
    const css = getComputedStyle(canvas);
    const ink = css.color;
    const homeC = css.getPropertyValue('--globe-home').trim() || '#9b5cff';
    const pickC = css.getPropertyValue('--globe-pick').trim() || '#ff4b4b';
    ctx.font = `${(cell * 1.18).toFixed(2)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let r = 0; r < rows; r++) {
      const py = (r + 0.5) * cell, v = (cy - py) / R;
      for (let c = 0; c < COLS; c++) {
        const px = (c + 0.5) * cell, u = (px - cx) / R, d2 = u * u + v * v;
        if (d2 > 1) continue;
        const z = Math.sqrt(1 - d2);
        const lat = Math.asin(z * sp + v * cp) / RAD;
        const lon = ((((l0 + Math.atan2(u, z * cp - v * sp)) / RAD) + 540) % 360) - 180;
        const depth = Math.min(1, z * 1.8);                          // fade towards the limb
        if (isLand(lat, lon)) {
          const code = countryAt(lat, lon);
          let fill = ink, ch = CONTINENTS[continent(lat, lon)].ch, a = 0.35 + 0.65 * depth;
          if (code === TAIWAN) { fill = homeC; ch = '#'; a = 1; }
          else if (pickCode && code === pickCode) { fill = pickC; a = 0.55 + 0.45 * depth; }
          ctx.fillStyle = fill;
          ctx.globalAlpha = a;
          ctx.fillText(ch, px, py);
        } else if ((r + c) % 2 === 0) {
          ctx.fillStyle = ink;
          ctx.globalAlpha = 0.13 * (0.3 + 0.7 * depth);              // ocean: sparse dots, enough to read the sphere
          ctx.fillText('·', px, py);
        }
      }
    }

    const projectRaw = (ll, min = 0) => {
      const p = ll[0] * RAD, d = ll[1] * RAD - l0;
      const cosc = sp * Math.sin(p) + cp * Math.cos(p) * Math.cos(d);
      if (cosc <= min) return null;
      return { x: cx + R * Math.cos(p) * Math.sin(d), y: cy - R * (cp * Math.sin(p) - sp * Math.cos(p) * Math.cos(d)) };
    };
    const project = (ll) => {                                         // snapped to the character grid
      const q = projectRaw(ll, 0.05);
      return q && { x: (Math.floor(q.x / cell) + 0.5) * cell, y: (Math.floor(q.y / cell) + 0.5) * cell };
    };

    // thin white arc along the sphere, grown from Taiwan towards the selected place (front side only)
    if (active && arcT > 0) {
      const a = unit(home), b = unit(active), tip = slerp(a, b, arcT);
      const steps = Math.max(16, Math.ceil(angle(a, tip) / RAD));
      ctx.strokeStyle = ink;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i <= steps; i++) {
        const q = projectRaw(toLatLon(slerp(a, tip, i / steps)));
        if (q) { pen ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); pen = true; } else pen = false;
      }
      ctx.stroke();
    }

    // □ every conference city in view
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1;
    for (const ll of cities) {
      const q = project(ll);
      if (!q) continue;
      ctx.clearRect(q.x - cell / 2, q.y - cell / 2, cell, cell);
      ctx.fillText('□', q.x, q.y);
    }
    // ■ in a ring for the selected one, once the arc has reached it
    const q = active && project(active);
    if (q && arcT >= 1) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = pickC;
      ctx.strokeStyle = pickC;
      ctx.clearRect(q.x - cell, q.y - cell, cell * 2, cell * 2);
      ctx.fillText('■', q.x, q.y);
      ctx.beginPath();
      ctx.arc(q.x, q.y, cell * 2.2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    onFrame(q || null, busy);
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    w = r.width; h = r.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    draw();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();
  document.fonts?.ready.then(draw);

  /** One timeline: the globe turns to `to` while the arc grows; done when both are. */
  function run(to, { turnMs, arcMs = 0 }) {
    cancelAnimationFrame(anim);
    const from = view;
    if (reduce.matches) { view = to; arcT = 1; busy = false; draw(); return; }
    const total = Math.max(turnMs, arcMs), t0 = performance.now();
    busy = true;
    const step = (now) => {
      const t = now - t0;
      view = turnMs > 0 ? slerp(from, to, ease(Math.min(1, t / turnMs))) : to;
      if (arcMs) arcT = ease(Math.min(1, t / arcMs));
      if (t >= total) busy = false;
      draw();
      if (busy) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }
  const turnTime = (to) => { const om = angle(view, to); return om < 1e-3 ? 0 : 260 + (om / Math.PI) * 450; };

  // drag to turn: the surface follows the pointer
  canvas.style.cursor = 'grab';
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (busy) { cancelAnimationFrame(anim); busy = false; arcT = 1; }
    const [lat, lon] = toLatLon(view);
    drag = { x: e.clientX, y: e.clientY, lat, lon, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const k = 180 / (Math.PI * radius());                                // degrees per pixel at the centre
    const lat = Math.max(-80, Math.min(80, drag.lat + (e.clientY - drag.y) * k));
    view = unit([lat, drag.lon - (e.clientX - drag.x) * k / Math.max(0.3, Math.cos(lat * RAD))]);
    draw();
  });
  const release = (e) => { if (drag && e.pointerId === drag.id) { drag = null; canvas.style.cursor = 'grab'; } };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  return {
    select(ll) {
      active = ll;
      pickCode = ll ? countryNear(ll) : 0;
      if (!ll) { cancelAnimationFrame(anim); busy = false; draw(); return; }
      const to = unit(ll), turnMs = turnTime(to);
      arcT = 0;
      run(to, { turnMs, arcMs: Math.max(turnMs, 380) });
    },
    intro() {
      if (reduce.matches) return;
      view = unit([home[0] - 12, home[1] - 110]);
      run(unit(home), { turnMs: 1500 });
    },
    redraw: draw,
  };
}
