/* The night desk's spyglass: a three-draw brass telescope, turned on a lathe, the
   barrel bound in leather. Built here as a surface of revolution about +x, in world
   units (1 = 5 mm), lying on the desk: its widest collar touches y = 0. */

// the profile, eyepiece to objective: [s0, r0, s1, r1, part], each band a cone, a
// cylinder or a flat ring between two (distance along the axis, radius) points
// parts: 0 brass, 1 ribbed brass, 2 leather, 3 glass, 4 black
const BANDS = [
  [0, 0, 0, 0.42, 4],            // the eyehole
  [0, 0.42, 0, 1.12, 0],         // the eyepiece's face
  [0, 1.12, 0.3, 1.34, 0],       // its rounded rim
  [0.3, 1.34, 1.4, 1.34, 1],     // the cap, ribbed for the fingers
  [1.4, 1.34, 1.4, 1.18, 0],
  [1.4, 1.18, 9.2, 1.18, 0],     // first draw
  [9.2, 1.18, 9.2, 1.52, 0],
  [9.2, 1.52, 10.5, 1.52, 1],    // its collar
  [10.5, 1.52, 10.5, 1.42, 0],
  [10.5, 1.42, 19.4, 1.42, 0],   // second draw
  [19.4, 1.42, 19.4, 1.8, 0],
  [19.4, 1.8, 20.8, 1.8, 1],
  [20.8, 1.8, 20.8, 1.68, 0],
  [20.8, 1.68, 29.6, 1.68, 0],   // third draw
  [29.6, 1.68, 29.6, 2.1, 0],
  [29.6, 2.1, 31.3, 2.1, 1],     // the barrel's collar
  [31.3, 2.1, 31.3, 2.03, 0],
  [31.3, 2.03, 47.6, 2.03, 2],   // the barrel, bound in leather
  [47.6, 2.03, 47.6, 2.32, 0],
  [47.6, 2.32, 49.7, 2.32, 0],   // the objective's cell
  [49.7, 2.32, 49.7, 2.24, 0],
  [49.7, 2.24, 52.2, 2.24, 0],   // the sunshade
  [52.2, 2.24, 52.35, 2.12, 0],  // its lip
  [52.35, 2.12, 52.35, 1.96, 0],
  [52.35, 1.96, 51.1, 1.96, 4],  // inside the shade, blackened
  [51.1, 1.96, 51.1, 0, 3],      // the object glass
];
export const SPYGLASS = { length: 52.35, radius: 2.32 };

export function spyglass(seg = 64) {
  const pos = [], nrm = [], uv = [], part = [], idx = [];
  for (const [s0, r0, s1, r1, p] of BANDS) {
    // the profile's outward normal: the band's direction turned a quarter
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
           part: new Float32Array(part), idx: new Uint16Array(idx) };
}
