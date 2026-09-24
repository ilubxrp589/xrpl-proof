/* The temple on the note: a round, open colonnade of 35 columns under a dome.
 *
 * It is the chain of trust drawn as architecture, bottom to top:
 *   cornerstone   the one pinned key                     part CORNER
 *   steps         the validator list that key signed     part STEPS
 *   35 columns    one per listed validator; a column is  parts 0..34
 *                 inked when ITS signature on this
 *                 ledger has been checked here
 *   entablature   quorum: 28 columns carry the roof      part BEAM
 *   dome          the ledger header, hashed here         part DOME
 *   lantern       an account proven against that ledger part LANTERN
 *
 * Built procedurally (turned profiles, like a lathe) so every vertex knows
 * which part it belongs to, and carries two engraving coordinates:
 *   u  around the part's own axis (0..1)   → vertical lines, flutes
 *   v  along its profile, in world units   → horizontal lines
 * The engraving shader draws its lines along those, so they follow the form
 * the way a burin does, instead of lying flat across the screen.
 */
export const N_COLS = 35;
export const PART = { BEAM: 35, DOME: 36, STEPS: 37, CORNER: 38, LANTERN: 39, GROUND: 40 };

const TAU = Math.PI * 2;

// Proportions, in column diameters (lower shaft diameter = 1).
const D = 1.0;
const SPACING = 2.25 * D;                    // centre to centre around the ring
export const R_COL = (N_COLS * SPACING) / TAU; // ≈ 12.5
const H_BASE = 0.42, H_SHAFT = 6.6, H_CAP = 0.62;
const STEP_RISE = 0.34, STEP_RUN = 0.62, N_STEPS = 3;
const Y0 = N_STEPS * STEP_RISE;                    // top of the stylobate
const Y_CAP = Y0 + H_BASE + H_SHAFT + H_CAP;       // top of the abacus

/** Duplicate every interior point so the lathe shades each face flat. */
const hard = pts => pts.flatMap((p, k) => (k && k < pts.length - 1 ? [p, p] : [p]));

class Builder {
  constructor() { this.pos = []; this.nrm = []; this.att = []; this.idx = []; }
  get n() { return this.pos.length / 3; }
  vert(p, nm, part, u, v) {
    this.pos.push(p[0], p[1], p[2]);
    const l = Math.hypot(nm[0], nm[1], nm[2]) || 1;
    this.nrm.push(nm[0] / l, nm[1] / l, nm[2] / l);
    this.att.push(part, u, v, 0);
  }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  /** Revolve a profile [[r, y], …] about a vertical axis at (cx, cz).
   *  Repeated points make hard edges. rFn(r, angle, y) may reshape the radius
   *  (fluting). v runs along the profile's arc length. */
  lathe(profile, seg, part, cx = 0, cz = 0, rFn = null, a0 = -Math.PI / 2, a1 = TAU - Math.PI / 2) {
    const rows = [];
    let arc = 0;
    for (let j = 0; j < profile.length; j++) {
      if (j) arc += Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]);
      const row = [];
      for (let i = 0; i <= seg; i++) {
        const t = i / seg, a = a0 + (a1 - a0) * t;
        let r = profile[j][0];
        if (rFn) r = rFn(r, a, profile[j][1]);
        row.push({ x: cx + Math.cos(a) * r, y: profile[j][1], z: cz + Math.sin(a) * r, a, u: t, v: arc });
      }
      rows.push(row);
    }
    // normals from finite differences on the grid, per row pair (hard edges
    // fall out because repeated profile points give zero-length segments)
    const base = this.n;
    for (let j = 0; j < rows.length; j++) {
      for (let i = 0; i <= seg; i++) {
        const p = rows[j][i];
        const jp = rows[Math.min(j + 1, rows.length - 1)][i], jm = rows[Math.max(j - 1, 0)][i];
        let ty = [jp.x - jm.x, jp.y - jm.y, jp.z - jm.z];
        // prefer the segment that is not degenerate (hard edge)
        const up = rows[Math.min(j + 1, rows.length - 1)][i], dn = rows[Math.max(j - 1, 0)][i];
        const du = Math.hypot(up.x - p.x, up.y - p.y, up.z - p.z), dd = Math.hypot(p.x - dn.x, p.y - dn.y, p.z - dn.z);
        if (du < 1e-6 && dd > 1e-6) ty = [p.x - dn.x, p.y - dn.y, p.z - dn.z];
        else if (dd < 1e-6 && du > 1e-6) ty = [up.x - p.x, up.y - p.y, up.z - p.z];
        const ip = rows[j][Math.min(i + 1, seg)], im = rows[j][Math.max(i - 1, 0)];
        const tx = [ip.x - im.x, ip.y - im.y, ip.z - im.z];
        // n = ty × tx points outward for a CCW revolve
        const nm = [ty[1] * tx[2] - ty[2] * tx[1], ty[2] * tx[0] - ty[0] * tx[2], ty[0] * tx[1] - ty[1] * tx[0]];
        this.vert([p.x, p.y, p.z], nm, part, p.u, p.v);
      }
    }
    const W = seg + 1;
    for (let j = 0; j + 1 < rows.length; j++)
      for (let i = 0; i < seg; i++)
        this.quad(base + j * W + i, base + (j + 1) * W + i, base + (j + 1) * W + i + 1, base + j * W + i + 1);
  }
  /** An axis-aligned box rotated by `yaw` about its centre's vertical. */
  box(c, size, yaw, part) {
    const [sx, sy, sz] = size.map(s => s / 2), cs = Math.cos(yaw), sn = Math.sin(yaw);
    const R = (x, z) => [c[0] + x * cs - z * sn, z * cs + x * sn + c[2]];
    const faces = [
      [[1, 0, 0], [[sx, -sy, -sz], [sx, sy, -sz], [sx, sy, sz], [sx, -sy, sz]]],
      [[-1, 0, 0], [[-sx, -sy, sz], [-sx, sy, sz], [-sx, sy, -sz], [-sx, -sy, -sz]]],
      [[0, 1, 0], [[-sx, sy, -sz], [-sx, sy, sz], [sx, sy, sz], [sx, sy, -sz]]],
      [[0, -1, 0], [[-sx, -sy, sz], [-sx, -sy, -sz], [sx, -sy, -sz], [sx, -sy, sz]]],
      [[0, 0, 1], [[sx, -sy, sz], [sx, sy, sz], [-sx, sy, sz], [-sx, -sy, sz]]],
      [[0, 0, -1], [[-sx, -sy, -sz], [-sx, sy, -sz], [sx, sy, -sz], [sx, -sy, -sz]]],
    ];
    for (const [nl, qs] of faces) {
      const b = this.n;
      const [nx, nz] = [nl[0] * cs - nl[2] * sn, nl[2] * cs + nl[0] * sn];
      qs.forEach(([x, y, z], k) => {
        const [wx, wz] = R(x, z);
        this.vert([wx, c[1] + y, wz], [nx, nl[1], nz], part, k === 1 || k === 2 ? 1 : 0, y + sy);
      });
      this.quad(b, b + 1, b + 2, b + 3);
    }
  }
}

/** Doric column at angle `a` on the ring: base, fluted shaft with entasis,
 *  necking, echinus, square abacus. */
function column(B, i) {
  const a = (i / N_COLS) * TAU + Math.PI / 2;   // column 0 faces the viewer
  const cx = Math.cos(a) * R_COL, cz = Math.sin(a) * R_COL;
  const r = D / 2;
  B.lathe([[r * 1.32, Y0], [r * 1.32, Y0 + 0.12], [r * 1.36, Y0 + 0.14], [r * 1.36, Y0 + 0.2],
           [r * 1.2, Y0 + 0.3], [r * 1.08, Y0 + 0.36], [r * 1.02, Y0 + H_BASE]], 40, i, cx, cz);
  // shaft: entasis (a slight swelling, then taper to 0.8) and 20 flutes
  const prof = [];
  for (let k = 0; k <= 16; k++) {
    const t = k / 16;
    const rr = r * (1 - 0.2 * t * t + 0.035 * Math.sin(Math.PI * t));
    prof.push([rr, Y0 + H_BASE + t * H_SHAFT]);
  }
  const FL = 20;
  const flute = (rr, ang, y) => {
    const f = (((ang - a) / TAU) * FL % 1 + 1) % 1;
    const s = Math.sqrt(Math.max(0, 1 - (2 * f - 1) ** 2));
    return rr * (1 - 0.055 * s);
  };
  B.lathe(prof, FL * 6, i, cx, cz, flute);
  const yC = Y0 + H_BASE + H_SHAFT, rt = r * 0.8;
  B.lathe([[rt, yC], [rt * 1.04, yC + 0.03], [rt * 1.04, yC + 0.07], [rt, yC + 0.09],
           [rt * 1.02, yC + 0.12], [r * 1.12, yC + 0.3], [r * 1.26, yC + 0.4], [r * 1.26, yC + 0.42]], 40, i, cx, cz);
  B.box([cx, Y_CAP - 0.1, cz], [D * 1.38, 0.2, D * 1.38], a - Math.PI / 2, i);
}

export function buildTholos() {
  const B = new Builder();
  // stylobate: three steps, hard-edged
  const rOut = R_COL + 1.25;
  const corners = [];
  for (let s = 0; s < N_STEPS; s++) {
    const r = rOut + (N_STEPS - 1 - s) * STEP_RUN;
    corners.push([r, s * STEP_RISE], [r, (s + 1) * STEP_RISE]);
  }
  corners.push([0.001, Y0]);
  B.lathe(hard(corners), 180, PART.STEPS);
  // cornerstone: one block set into the front of the bottom step
  B.box([0, STEP_RISE * 0.5, rOut + (N_STEPS - 1) * STEP_RUN - 0.05], [2.0, STEP_RISE * 1.02, 0.5], 0, PART.CORNER);

  for (let i = 0; i < N_COLS; i++) column(B, i);

  // entablature: architrave (two fasciae), frieze, cornice with overhang
  const y = Y_CAP, rin = R_COL - 0.62, rout = R_COL + 0.62;
  B.lathe(hard([[rout, y], [rout, y + 0.34], [rout + 0.05, y + 0.34], [rout + 0.05, y + 0.66],
           [rout + 0.12, y + 0.7], [rout, y + 0.74], [rout, y + 1.36], [rout + 0.1, y + 1.4],
           [rout + 0.55, y + 1.58], [rout + 0.6, y + 1.72], [rout + 0.2, y + 1.8], [rout - 0.3, y + 1.84],
           [rin, y + 1.84], [rin, y]]), 210, PART.BEAM);
  // triglyphs over each column and between them
  for (let k = 0; k < N_COLS * 2; k++) {
    const a = (k / (N_COLS * 2)) * TAU + Math.PI / 2;
    B.box([Math.cos(a) * (rout + 0.06), y + 1.05, Math.sin(a) * (rout + 0.06)], [0.5, 0.62, 0.14], a - Math.PI / 2, PART.BEAM);
  }
  // attic drum, then a ribbed dome springing from it, then the lantern
  const yA = y + 1.84, rD = rin + 0.2;
  B.lathe([[rD, yA], [rD, yA + 1.1], [rD + 0.12, yA + 1.16], [rD + 0.12, yA + 1.24], [rD - 0.1, yA + 1.3]], 180, PART.BEAM);
  const yS = yA + 1.3, rDome = rD - 0.1;
  const dprof = [];
  for (let k = 0; k <= 28; k++) {
    const t = (k / 28) * (Math.PI / 2) * 0.93;
    dprof.push([Math.cos(t) * rDome, yS + Math.sin(t) * rDome * 0.78]);
  }
  const yTop = dprof[dprof.length - 1][1], rEye = dprof[dprof.length - 1][0];
  B.lathe(dprof, 210, PART.DOME);
  // 35 ribs, one above each column: the ledger rests on its validators
  for (let i = 0; i < N_COLS; i++) {
    const a = (i / N_COLS) * TAU + Math.PI / 2, w = 0.06;
    const rib = dprof.map(([r, yy]) => [r + 0.09, yy + 0.02]);
    B.lathe(rib, 2, PART.DOME, 0, 0, null, a - w, a + w);
  }
  // lantern: ring, eight slender columns, cap, finial
  const yL = yTop, rL = rEye + 0.25;
  B.lathe([[rL, yL], [rL, yL + 0.3], [rL - 0.1, yL + 0.34]], 64, PART.LANTERN);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU + Math.PI / 8, cx = Math.cos(a) * (rL - 0.35), cz = Math.sin(a) * (rL - 0.35);
    B.lathe([[0.16, yL + 0.34], [0.13, yL + 2.0], [0.2, yL + 2.12]], 16, PART.LANTERN, cx, cz);
  }
  const yC = yL + 2.12;
  const cap = [[rL + 0.12, yC], [rL + 0.12, yC + 0.22]];
  for (let k = 0; k <= 10; k++) {
    const t = (k / 10) * Math.PI / 2;
    cap.push([Math.cos(t) * (rL - 0.05) + 0.001, yC + 0.22 + Math.sin(t) * (rL - 0.05) * 0.9]);
  }
  B.lathe(cap, 64, PART.LANTERN);
  const yF = cap[cap.length - 1][1];
  B.lathe([[0.001, yF], [0.18, yF + 0.05], [0.24, yF + 0.26], [0.16, yF + 0.46], [0.05, yF + 0.56],
           [0.04, yF + 1.2], [0.001, yF + 1.35]], 24, PART.LANTERN);

  // the ground the temple stands on, engraved as receding rules
  B.lathe([[70, -0.02], [0.001, -0.02]], 160, PART.GROUND);

  return {
    pos: new Float32Array(B.pos), nrm: new Float32Array(B.nrm),
    att: new Float32Array(B.att), idx: new Uint32Array(B.idx),
    bounds: { r: rOut + (N_STEPS - 1) * STEP_RUN, h: yF + 1.35, yDome: yS, yCap: Y_CAP },
  };
}
