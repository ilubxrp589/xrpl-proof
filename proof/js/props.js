/* The night desk's things, built here: a three-draw spyglass on a pillar-and-claw stand,
   and a stand the astrolabe hangs from, its chain wound down the post and coiled on the
   plinth. Turned parts are surfaces of revolution, arms and legs are tubes swept along
   curves, the chain is links. World units (1 = 5 mm). */

const TAU = Math.PI * 2;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// what each surface is made of (the shaders' part numbers)
export const BRASS = 0, RIBBED = 1, LEATHER = 2, GLASS = 3, BLACK = 4, WOOD = 5, CHAIN = 6;

/** A smooth curve through control points (Catmull-Rom), n points along it. */
function spline(ctrl, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = (i / (n - 1)) * (ctrl.length - 1), k = Math.min(ctrl.length - 2, Math.floor(f)), t = f - k;
    const p0 = ctrl[Math.max(0, k - 1)], p1 = ctrl[k], p2 = ctrl[k + 1], p3 = ctrl[Math.min(ctrl.length - 1, k + 2)];
    const t2 = t * t, t3 = t2 * t;
    out.push([0, 1, 2].map(j => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2
                                      + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
  }
  return out;
}

/** Points every `step` along a polyline. */
function resample(path, step) {
  const out = [path[0]];
  let need = step, prev = path[0];
  for (let k = 1; k < path.length; k++) {
    let seg = Math.hypot(...sub(path[k], prev));
    while (seg >= need) {
      const p = add(prev, mul(sub(path[k], prev), need / seg));
      out.push(p); prev = p; seg -= need; need = step;
    }
    need -= seg; prev = path[k];
  }
  return out;
}

class Geo {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.part = []; this.idx = []; }
  vert(p, n, u, v, part) {
    this.pos.push(p[0], p[1], p[2]); this.nrm.push(n[0], n[1], n[2]); this.uv.push(u, v); this.part.push(part);
    return this.pos.length / 3 - 1;
  }
  quads(rows, cols, at) {
    for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cols - 1; j++) {
      const a = at + i * cols + j, b = a + cols;
      this.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  /** A surface of revolution about the y axis through c: a profile of [r, y] points,
   *  bottom to top, the solid on its left; null starts a new run (a hard edge). */
  lathe(profile, part, seg = 48, c = [0, 0, 0], sx = 1, sz = 1) {
    const runs = [[]];
    for (const p of profile) p ? runs[runs.length - 1].push(p) : runs.push([]);
    for (const run of runs) {
      if (run.length < 2) continue;
      const at = this.pos.length / 3;
      for (let k = 0; k < run.length; k++) {
        const a = run[Math.max(0, k - 1)], b = run[Math.min(run.length - 1, k + 1)];
        const dr = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dr, dy) || 1;
        const nr = dy / l, ny = -dr / l;               // the profile turned a quarter: outward
        for (let i = 0; i <= seg; i++) {
          const t = (i / seg) * TAU, cs = Math.cos(t), sn = Math.sin(t);
          this.vert([c[0] + cs * run[k][0] * sx, c[1] + run[k][1], c[2] + sn * run[k][0] * sz],
                    norm([cs * nr / sx, ny, sn * nr / sz]), i / seg, run[k][1], part);
        }
      }
      this.quads(run.length, seg + 1, at);
    }
  }
  sphere(c, r, part, seg = 16) {
    const prof = [];
    for (let k = 0; k <= seg / 2; k++) { const a = -Math.PI / 2 + (k / (seg / 2)) * Math.PI; prof.push([Math.cos(a) * r, Math.sin(a) * r]); }
    this.lathe(prof, part, seg, c);
  }
  /** A tube along a path, radius r (or r(t), t 0..1 along it), its frame carried
   *  along without twisting; round ends. */
  tube(path, r, part, seg = 16, ends = true) {
    const n = path.length, at = this.pos.length / 3, R = typeof r === 'function' ? r : () => r;
    const T = path.map((p, k) => norm(sub(path[Math.min(n - 1, k + 1)], path[Math.max(0, k - 1)])));
    let N = norm(cross(T[0], Math.abs(T[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), len = 0;
    for (let k = 0; k < n; k++) {
      if (k) len += Math.hypot(...sub(path[k], path[k - 1]));
      N = norm(sub(N, mul(T[k], dot(N, T[k]))));
      const B = cross(T[k], N), rr = R(k / (n - 1));
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * TAU, d = add(mul(N, Math.cos(a)), mul(B, Math.sin(a)));
        this.vert(add(path[k], mul(d, rr)), d, i / seg, len, part);
      }
    }
    this.quads(n, seg + 1, at);
    if (ends) { this.sphere(path[0], R(0), part, seg); this.sphere(path[n - 1], R(1), part, seg); }
  }
  /** One chain link: an oval ring about c, its long axis a, lying in the plane normal to pn. */
  link(c, a, pn, A = 0.72, B = 0.42, r = 0.15, part = CHAIN, s1 = 14, s2 = 7) {
    const s = cross(pn, a), at = this.pos.length / 3;
    for (let i = 0; i <= s1; i++) {
      const t = (i / s1) * TAU;
      const q = add(c, add(mul(a, A * Math.cos(t)), mul(s, B * Math.sin(t))));
      const out = norm(cross(norm(add(mul(a, -A * Math.sin(t)), mul(s, B * Math.cos(t)))), pn));
      for (let j = 0; j <= s2; j++) {
        const f = (j / s2) * TAU, d = add(mul(out, Math.cos(f)), mul(pn, Math.sin(f)));
        this.vert(add(q, mul(d, r)), d, i / s1, j / s2, part);
      }
    }
    this.quads(s1 + 1, s2 + 1, at);
  }
  /** A chain laid along a path, each link turned a quarter from the last. floor(p), if
   *  given, is the surface under a point (or null): a link over it rests its lowest
   *  point on it, flat links lower than those standing on edge. */
  chain(path, pitch = 1.1, first = null, floor = null, A = 0.72, B = 0.42, r = 0.15) {
    const pts = resample(path, pitch);
    let N = first || norm(cross(norm(sub(pts[1], pts[0])), [1, 0, 0]));
    for (let k = 0; k < pts.length - 1; k++) {
      const a = norm(sub(pts[k + 1], pts[k]));
      N = norm(sub(N, mul(a, dot(N, a))));
      const pn = k % 2 ? cross(a, N) : N, sd = cross(pn, a);
      let c = mul(add(pts[k], pts[k + 1]), 0.5);
      const f = floor && floor(c);
      if (f !== null && f !== undefined) c = [c[0], f + Math.hypot(a[1] * A, sd[1] * B) + r, c[2]];
      this.link(c, a, pn, A, B, r);
    }
    return pts;
  }
  arrays() {
    return { pos: new Float32Array(this.pos), nrm: new Float32Array(this.nrm), uv: new Float32Array(this.uv),
             part: new Float32Array(this.part), idx: new Uint32Array(this.idx) };
  }
}

// ── the spyglass ─────────────────────────────────────────────────────────────
// the profile, eyepiece to object glass: [s0, r0, s1, r1, part], each band a cone, a
// cylinder or a flat ring between two (distance along the axis, radius) points
const BANDS = [
  [0, 0, 0, 0.42, BLACK],          // the eyehole
  [0, 0.42, 0, 1.12, BRASS],       // the eyepiece's face
  [0, 1.12, 0.3, 1.34, BRASS],     // its rounded rim
  [0.3, 1.34, 1.4, 1.34, RIBBED],  // the cap, ribbed for the fingers
  [1.4, 1.34, 1.4, 1.18, BRASS],
  [1.4, 1.18, 9.2, 1.18, BRASS],   // first draw
  [9.2, 1.18, 9.2, 1.52, BRASS],
  [9.2, 1.52, 10.5, 1.52, RIBBED], // its collar
  [10.5, 1.52, 10.5, 1.42, BRASS],
  [10.5, 1.42, 19.4, 1.42, BRASS], // second draw
  [19.4, 1.42, 19.4, 1.8, BRASS],
  [19.4, 1.8, 20.8, 1.8, RIBBED],
  [20.8, 1.8, 20.8, 1.68, BRASS],
  [20.8, 1.68, 29.6, 1.68, BRASS], // third draw
  [29.6, 1.68, 29.6, 2.1, BRASS],
  [29.6, 2.1, 31.3, 2.1, RIBBED],  // the barrel's collar
  [31.3, 2.1, 31.3, 2.03, BRASS],
  [31.3, 2.03, 47.6, 2.03, LEATHER], // the barrel, bound in leather
  [33.3, 2.03, 33.3, 2.38, BRASS],   // the stand's clamp, round the barrel at its balance
  [33.3, 2.38, 35.1, 2.38, BRASS],
  [35.1, 2.38, 35.1, 2.03, BRASS],
  [47.6, 2.03, 47.6, 2.32, BRASS],
  [47.6, 2.32, 49.7, 2.32, BRASS], // the object glass's cell
  [49.7, 2.32, 49.7, 2.24, BRASS],
  [49.7, 2.24, 52.2, 2.24, BRASS], // the sunshade
  [52.2, 2.24, 52.35, 2.12, BRASS],// its lip
  [52.35, 2.12, 52.35, 1.96, BRASS],
  [52.35, 1.96, 51.1, 1.96, BLACK],// inside the shade, blackened
  [51.1, 1.96, 51.1, 0, GLASS],    // the object glass
];
// the tube lies along +x, its axis at y = radius; the clamp (its pivot) is at s = 34.2
export const SPYGLASS = { length: 52.35, radius: 2.32, pivot: 34.2 };

export function spyglass(seg = 64) {
  const pos = [], nrm = [], uv = [], part = [], idx = [];
  for (const [s0, r0, s1, r1, p] of BANDS) {
    const ds = s1 - s0, dr = r1 - r0, l = Math.hypot(ds, dr) || 1;
    const ns = -dr / l, nr = ds / l;
    const base = pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      for (const [x, r] of [[s0, r0], [s1, r1]]) {
        pos.push(x, SPYGLASS.radius + c * r, s * r);
        nrm.push(ns, nr * c, nr * s);
        uv.push(i / seg, x);
        part.push(p);
      }
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2, b = a + 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv),
           part: new Float32Array(part), idx: new Uint32Array(idx) };
}

// ── the spyglass's stand: a turned brass pillar on three claw feet, a yoke on top
// holding the clamp's trunnions. Pillar along +y; the trunnions run along x, so the
// tube tilts in the y-z plane. Its pads stand on y = 0.
export const CLAW = { pivot: 24.4, pads: [] };

export function clawStand() {
  const g = new Geo();
  CLAW.pads = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + Math.PI / 6, d = [Math.cos(a), 0, Math.sin(a)];
    const P = (r, y) => [d[0] * r, y, d[2] * r];
    // a cabriole leg: out from the pillar's foot, down in an S, onto a round pad
    g.tube(spline([P(0.8, 6.5), P(2.3, 6.3), P(4.4, 4.9), P(6.2, 2.6), P(7.8, 1.2), P(8.9, 0.8)], 26), t => 0.95 - 0.44 * t, BRASS, 14, false);
    g.sphere(P(9.1, 0.66), 0.68, BRASS, 16);
    CLAW.pads.push([d[0] * 9.1, d[2] * 9.1]);
  }
  // the pillar: a baluster, with knops, turned in one piece
  g.lathe([[0, 5.3], [1.7, 5.3], [1.95, 5.8], [1.95, 6.7], [1.6, 7.1], [1.05, 7.7], [0.84, 8.5], [0.9, 11.0], [1.18, 12.5],
           [1.3, 13.3], [1.12, 14.1], [0.78, 14.9], [0.7, 17.8], [1.02, 18.5], [1.1, 19.3], [0.92, 19.9], [0.92, 20.6], [0, 20.6]], BRASS, 40);
  // the yoke, and the trunnions it holds: short pins into the clamp, with milled heads
  g.tube(spline([[-2.95, 25.0, 0], [-2.95, 23.4, 0], [-2.55, 21.9, 0], [-1.4, 21.0, 0], [0, 20.75, 0],
                 [1.4, 21.0, 0], [2.55, 21.9, 0], [2.95, 23.4, 0], [2.95, 25.0, 0]], 40), 0.44, BRASS, 12);
  for (const s of [-1, 1]) {
    g.tube([[s * 2.2, 24.4, 0], [s * 3.5, 24.4, 0]], 0.34, BRASS, 16, false);
    g.lathe([[0, -0.45], [0.72, -0.45], [0.8, -0.3], [0.8, 0.3], [0.72, 0.45], [0, 0.45]].map(([r, y]) => [r, y]), RIBBED, 24,
            [s * 3.95, 24.4, 0]);
  }
  return g.arrays();
}

// ── the astrolabe's stand, gallows fashion: an oval plinth of French-polished mahogany
// with a brass inlay, a turned brass post at one end, and an arm reaching over from its
// top to a hook. The astrolabe hangs from the hook on five links, beside the post and
// over the plinth; a second chain winds down the post and lies coiled round its foot.
// The astrolabe's face looks along +z; the post stands at +x.
export const HANG = { post: 11.5, ring: null, plinth: [17.5, 11.5] };

export function hangingStand() {
  const g = new Geo(), X = HANG.post, [sx, sz] = [HANG.plinth[0] / 11, HANG.plinth[1] / 11];
  g.lathe([[0, 0], [10.6, 0], [11, 0.3], [11, 1.1], null, [11, 1.1], [10.7, 1.45], [10.15, 1.8], [9.75, 2.3], [9.45, 2.7], null,
           [9.45, 2.7], [9.2, 2.9], [0, 2.9]], WOOD, 96, [0, 0, 0], sx, sz);
  g.lathe([[8.3, 2.86], [8.3, 2.95], null, [8.3, 2.95], [7.8, 2.95], null, [7.8, 2.95], [7.8, 2.86]], BRASS, 128, [0, 0, 0], sx, sz);
  // the post
  g.lathe([[2.25, 2.9], [2.25, 3.3], null, [2.25, 3.3], [1.95, 3.45], [1.5, 3.75], [1.2, 4.3], [1.06, 5.0], [1.26, 5.6], [1.32, 6.0],
           [1.1, 6.5], [0.78, 7.2], [0.72, 12.2], [0.96, 13.1], [1.16, 13.7], [0.96, 14.3], [0.7, 15.1], [0.64, 44.3], [0.84, 45.0],
           [0.94, 45.7], [0.84, 46.4], [0.62, 46.9], [0.62, 47.6], [0.9, 47.9]], BRASS, 36, [X, 0, 0]);
  g.sphere([X, 48.7, 0], 0.95, BRASS, 20);
  g.lathe([[0.4, 49.4], [0.26, 50.0], [0.12, 50.6], [0, 50.9]], BRASS, 16, [X, 0, 0]);
  // the arm: out of the collar, over, and down into a hook whose tip turns back up
  const arm = spline([[X, 45.4, 0], [X - 1.3, 46.9, 0], [X - 4.5, 47.8, 0], [X - 9, 47.7, 0], [X - 12.3, 47.1, 0], [X - 14.4, 46.0, 0],
                      [X - 14.9, 44.9, 0], [X - 14.4, 44.05, 0], [X - 13.5, 44.25, 0], [X - 13.1, 44.95, 0]], 80);
  g.tube(arm, t => 0.52 - 0.14 * t, BRASS, 12);
  g.sphere([X - 13.1, 45.0, 0], 0.46, BRASS, 16);
  // five links down from the hook's cup to the astrolabe's ring: the first across the
  // hook's wire, the last across the ring
  const cup = [X - 14.25, 44.05, 0], wire = 0.39;
  const top = [cup[0], cup[1] + wire - 0.57, 0];
  const hung = g.chain([top, [top[0], top[1] - 5.51, 0]], 1.1, [1, 0, 0]);   // (5.51: five whole links, whatever the rounding)
  HANG.ring = [top[0], hung[hung.length - 1][1] + 0.62, 0];                 // the ring's top, resting in the last link
  // a second chain, clipped under the post's collar: wound down the post, then out round
  // the knops and coiled on the plinth
  const path = [];
  for (let k = 0; k <= 240; k++) {
    const t = k / 240, a = TAU * 2.6 * t;
    path.push([X + Math.cos(a) * 1.36, 43.9 - t * 28.5, Math.sin(a) * 1.36]);
  }
  for (let k = 1; k <= 60; k++) {
    const t = k / 60, r = 1.36 + 1.74 * Math.sin(Math.min(1, t * 2.2) * Math.PI / 2), a = TAU * (2.6 + 0.55 * t);
    path.push([X + Math.cos(a) * r, 15.4 - t * 12.0, Math.sin(a) * r]);
  }
  for (let k = 1; k <= 160; k++) {
    const t = k / 160, r = 3.1 + t * 2.4, a = TAU * (3.15 + 1.25 * t);
    path.push([X + Math.cos(a) * r, 3.4, Math.sin(a) * r]);
  }
  g.chain(path, 1.1, [0, 0, 1], p => (p[1] < 3.9 ? 2.9 : null));
  return g.arrays();
}
