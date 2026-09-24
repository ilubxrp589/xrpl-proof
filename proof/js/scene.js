/* The sky: Proof's scene, drawn in Deep Field's terms. Light means checked in
 * this browser; an outline means someone else said so.
 *   the key        a guide star: the one key this page trusts, built into it
 *   the gate       the validator list that key signed, drawn once the list
 *                  checks out: one housing and one light per validator
 *   a light        lit when that validator's signature on this ledger checks;
 *                  beyond it, its spectrum: lines set by the bytes it signed
 *   the horizon    open once a quorum has signed one ledger (Deep Field's rule)
 *   the heart      lit when the ledger's header hashes to what they signed
 *   the rings      behind the gate, one for each ledger proven on screen,
 *                  receding: looking through the gate is looking back
 *   an account     a body beyond the gate, reached from the heart (where the
 *                  state root is) by its real path through the state tree
 * WebGL 2, in HDR with bloom and ACES, as Deep Field is drawn. */
import { program, uniforms, texture, mesh, M, V } from './gl.js';

export const GATE = { R: 1, tube: 0.052, lip: 0.905, hz: 0.86 };
export const KEY_AT = [2.25, 2.05, -2.7];
export const BODY_AT = [2.3, -1.02, -0.45];
/** The home view: the gate, the key above it, an account beside it, the rings going back. */
export const HOME = { centre: [0.62, 0.22, -0.5], radius: 1.95, yaw: -0.5, pitch: 0.12 };
/** A tall screen is narrow: the home view stands further back, so the rings going back stay in it. */
export const HOME_TALL = { centre: [0.42, 0.3, -0.62], radius: 2.3, yaw: -0.5, pitch: 0.12 };
const MAXV = 64, LINES = 16, RINGS = 28;
const TAU = Math.PI * 2;
const clamp01 = x => Math.max(0, Math.min(1, x));
const ease = (v, t, up, down, dt) => v + (t - v) * (1 - Math.exp(-dt * (t > v ? up : down)));

/** Where validator i of n sits on the gate: clockwise from the top, as on the receipt. */
export function lightAt(i, n, lift = GATE.tube + 0.018) {
  const a = Math.PI / 2 - (i / n) * TAU;
  return [Math.cos(a) * GATE.R, Math.sin(a) * GATE.R, lift];
}

// ── shaders ────────────────────────────────────────────────────────────────
const HEAD = '#version 300 es\nprecision highp float;\n';
const FULL_VS = `#version 300 es
out vec2 vN;
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vN = p * 2.0 - 1.0; gl_Position = vec4(vN, 0.0, 1.0); }`;

// deep space: Deep Field's two washes and a slow nebula, by direction, so it turns with the view
const SKY_FS = HEAD + `
in vec2 vN; uniform mat4 uInv; uniform float uT; out vec4 o;
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float n3(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1, 0, 0)), f.x), mix(h13(i + vec3(0, 1, 0)), h13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h13(i + vec3(0, 0, 1)), h13(i + vec3(1, 0, 1)), f.x), mix(h13(i + vec3(0, 1, 1)), h13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int k = 0; k < 5; k++) { s += a * n3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }
void main() {
  vec4 q = uInv * vec4(vN, 1.0, 1.0); vec3 d = normalize(q.xyz / q.w);
  vec3 c = vec3(0.0004, 0.0009, 0.0030);
  c += vec3(0.0020, 0.0075, 0.030) * pow(max(dot(d, normalize(vec3(-0.6, 0.55, -0.55))), 0.0), 3.0) * 0.8;
  c += vec3(0.0034, 0.0021, 0.016) * pow(max(dot(d, normalize(vec3(0.65, -0.45, -0.6))), 0.0), 3.0) * 0.8;
  float f = fbm(d * 2.4 + vec3(0.0, 0.0, uT * 0.003));
  float w = smoothstep(0.5, 0.86, f);
  c += w * mix(vec3(0.005, 0.016, 0.042), vec3(0.028, 0.008, 0.012), smoothstep(0.35, 0.85, n3(d * 1.3 + 7.0))) * 0.45;
  o = vec4(c, 1.0);
}`;

// 2,600 stars on a distant shell, as Deep Field has
const STAR_VS = `#version 300 es
layout(location = 0) in vec3 aDir; layout(location = 1) in vec2 aCorner; layout(location = 2) in float aMag;
uniform mat4 uVPr; uniform vec2 uPx; out vec2 vC; out vec3 vCol;
void main() {
  vec4 p = uVPr * vec4(aDir * 100.0, 1.0);
  p.xy += aCorner * mix(0.8, 3.0, aMag * aMag) * uPx * p.w;
  gl_Position = p; vC = aCorner;
  vCol = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.9, 0.78), step(0.8, fract(aMag * 37.0))) * mix(0.18, 2.2, pow(aMag, 2.4));
}`;
const STAR_FS = HEAD + `in vec2 vC; in vec3 vCol; out vec4 o; void main() { o = vec4(vCol * exp(-4.5 * dot(vC, vC)), 1.0); }`;

// the gate: a shaded ring and lip, and a housing per validator that glows when it signed
const GATE_VS = `#version 300 es
layout(location = 0) in vec3 aP; layout(location = 1) in vec3 aN; layout(location = 2) in float aI;
uniform mat4 uVP; out vec3 vP; out vec3 vN; flat out int vI;
void main() { vP = aP; vN = aN; vI = int(aI + 0.5) - 1; gl_Position = uVP * vec4(aP, 1.0); }`;
const GATE_FS = HEAD + `
in vec3 vP; in vec3 vN; flat in int vI;
uniform vec3 uEye; uniform float uLit[64]; uniform float uOpen, uBuilt; out vec4 o;
void main() {
  // the list is checked: the gate is drawn round from the top, as the list is read
  float a = fract(0.25 - atan(vP.y, vP.x) / 6.2831853);
  if (a > uBuilt) discard;
  vec3 N = normalize(vN), V = normalize(uEye - vP);
  vec3 L1 = normalize(vec3(-0.45, 0.75, 0.6)), L2 = normalize(vec3(0.7, -0.25, -0.7));
  vec3 H = normalize(L1 + V);
  float dif = max(dot(N, L1), 0.0), back = max(dot(N, L2), 0.0), sp = pow(max(dot(N, H), 0.0), 56.0);
  float fr = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  vec3 c = vec3(0.020, 0.040, 0.066) * (0.3 + 1.7 * dif) + vec3(0.04, 0.10, 0.17) * back * 0.4
         + vec3(0.5, 0.58, 0.68) * sp * 0.45 + vec3(0.05, 0.15, 0.27) * fr * 0.8;
  if (vI >= 0) c = c * 0.7 + vec3(0.30, 0.95, 1.5) * uLit[vI] * (0.2 + 0.3 * max(N.z, 0.0));
  else {
    vec2 rad = normalize(vP.xy + 1e-5);
    c += vec3(0.05, 0.16, 0.28) * max(-dot(N.xy, rad), 0.0) * step(length(vP.xy), 0.97) * uOpen;
  }
  c += vec3(0.4, 0.9, 1.3) * smoothstep(0.03, 0.0, uBuilt - a) * step(uBuilt, 0.999) * 2.0;   // the drawing edge
  o = vec4(c, 1.0);
}`;

// the event horizon: Deep Field's log-spiral well, open only once a quorum signed
const HZ_VS = `#version 300 es
layout(location = 0) in vec2 aQ; uniform mat4 uVP; uniform float uR; out vec2 vQ;
void main() { vQ = aQ; gl_Position = uVP * vec4(aQ * uR, 0.0, 1.0); }`;
const HZ_FS = HEAD + `
in vec2 vQ; uniform float uT, uOpen; out vec4 o;
void main() {
  float r = length(vQ) / max(uOpen, 1e-3);
  if (r > 1.0) discard;
  float a = atan(vQ.y, vQ.x + 1e-6), lr = log(max(r, 0.018));   // atan(0, 0) is undefined
  float r1 = sin(lr * 7.0 - uT * 1.35 + a * 2.0) * 0.5 + 0.5;
  float r2 = sin(lr * 13.0 - uT * 2.10 - a) * 0.5 + 0.5;
  float r3 = sin(lr * 3.4 - uT * 0.80 + a) * 0.5 + 0.5;
  float body = pow(r1 * 0.46 + r2 * 0.24 + r3 * 0.30, 1.7) * smoothstep(1.0, 0.42, r) * smoothstep(0.0, 0.1, r);
  o = vec4(vec3(0.075, 0.180, 0.290) * body * 2.2 * uOpen, 1.0);
}`;

// light: sprites facing the eye (Deep Field's node flare, soft glows, hollow rings)
const SPRITE_VS = `#version 300 es
layout(location = 0) in vec3 aC; layout(location = 1) in vec2 aK; layout(location = 2) in float aS;
layout(location = 3) in vec3 aCol; layout(location = 4) in float aKind;
uniform mat4 uV, uP; out vec2 vK; out vec3 vCol; flat out int vKind;
void main() { vec4 c = uV * vec4(aC, 1.0); c.xy += aK * aS; gl_Position = uP * c; vK = aK; vCol = aCol; vKind = int(aKind + 0.5); }`;
const SPRITE_FS = HEAD + `
in vec2 vK; in vec3 vCol; flat in int vKind; out vec4 o;
void main() {
  float d2 = dot(vK, vK); if (d2 > 1.0) discard;
  float d = sqrt(d2), a;
  if (vKind == 1) a = exp(-24.0 * d2) * 1.55 + exp(-420.0 * (d - 0.62) * (d - 0.62)) * 0.3 + pow(1.0 - d, 7.0) * 0.3;
  else if (vKind == 2) a = exp(-260.0 * (d - 0.8) * (d - 0.8));
  else if (vKind == 3) a = exp(-24.0 * d2) * 1.6 + pow(1.0 - d, 6.0) * 0.4
                          + (exp(-900.0 * vK.y * vK.y) + exp(-900.0 * vK.x * vK.x)) * pow(1.0 - d, 1.5) * 0.9;
  else a = exp(-4.2 * d2) + 0.22 * pow(1.0 - d, 3.0);
  o = vec4(vCol * a, 1.0);
}`;

// lines of light: ribbons (the key's filament, an account's path) and the spectra, built on the CPU
const RIB_VS = `#version 300 es
layout(location = 0) in vec3 aP; layout(location = 1) in vec3 aCol; layout(location = 2) in float aV;
uniform mat4 uVP; out vec3 vCol; out float vV;
void main() { vCol = aCol; vV = aV; gl_Position = uVP * vec4(aP, 1.0); }`;
const RIB_FS = HEAD + `in vec3 vCol; in float vV; out vec4 o; void main() { o = vec4(vCol * exp(-3.2 * vV * vV), 1.0); }`;
const SPEC_VS = `#version 300 es
layout(location = 0) in vec3 aP; layout(location = 1) in float aI; layout(location = 2) in float aK; layout(location = 3) in float aV;
uniform mat4 uVP; uniform float uLit[64]; out float vA; out float vV;
void main() { vA = aK * uLit[int(aI + 0.5)]; vV = aV; gl_Position = uVP * vec4(aP, 1.0); }`;
const SPEC_FS = HEAD + `in float vA; in float vV; out vec4 o; void main() { o = vec4(vec3(0.34, 0.86, 1.35) * vA * 0.32 * exp(-2.6 * vV * vV), 1.0); }`;

// the rings behind the gate, one per ledger proven on screen
const RING_VS = `#version 300 es
layout(location = 0) in vec3 aA; uniform mat4 uVP; uniform float uZ, uR, uW; out float vT;
void main() { vT = aA.z; gl_Position = uVP * vec4(aA.xy * (uR + aA.z * uW), uZ, 1.0); }`;
const RING_FS = HEAD + `in float vT; uniform vec3 uCol; out vec4 o; void main() { o = vec4(uCol * exp(-3.0 * vT * vT), 1.0); }`;

// an account: a body with Deep Field's grid; solid and lit once proven, a bare grid while only told
const BODY_VS = `#version 300 es
layout(location = 0) in vec3 aP; uniform mat4 uVP; uniform vec3 uAt; uniform float uR; out vec3 vL; out vec3 vW;
void main() { vL = aP; vW = uAt + aP * uR; gl_Position = uVP * vec4(vW, 1.0); }`;
const BODY_FS = HEAD + `
in vec3 vL; in vec3 vW; uniform vec3 uEye; uniform float uLit, uTold, uSpin; out vec4 o;
void main() {
  vec3 N = normalize(vL), V = normalize(uEye - vW);
  float lon = atan(vL.z, vL.x + 1e-6) + uSpin, lat = asin(clamp(vL.y, -1.0, 1.0));
  vec2 g = vec2(lon / 6.2831853 * 18.0, lat / 3.1415927 * 9.0);
  vec2 f = abs(fract(g - 0.5) - 0.5) / max(fwidth(g), vec2(1e-4));   // fwidth is 0 where the grid is flat: no 0/0
  float line = 1.0 - min(min(f.x, f.y), 1.0);
  float fr = pow(1.0 - max(dot(N, V), 0.0), 2.5);
  if (uLit > 0.001) {
    float dif = max(dot(N, normalize(vec3(-0.5, 0.7, 0.6))), 0.0);
    vec3 c = vec3(0.015, 0.03, 0.05) * (0.4 + 1.6 * dif) + vec3(0.3, 0.8, 1.25) * line * 0.55 * uLit + vec3(0.2, 0.55, 0.9) * fr * uLit;
    o = vec4(c, 1.0);
  } else {
    // only told: a dashed grid, no body, no light
    float dash = step(0.5, fract((lon + lat) * 4.0));
    if (line * dash < 0.05) discard;
    o = vec4(vec3(0.20, 0.23, 0.28) * line * dash * uTold, 1.0);
  }
}`;

// HDR to the screen: bloom, then ACES filmic, as Deep Field's composite
const BRIGHT_FS = HEAD + `in vec2 vN; uniform sampler2D uSrc; out vec4 o;
void main() { vec3 c = texture(uSrc, vN * 0.5 + 0.5).rgb;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);        // one bad pixel must not spread through the glow
  float l = max(max(c.r, c.g), c.b);
  o = vec4(c * smoothstep(0.55, 1.4, l), 1.0); }`;
const DOWN_FS = HEAD + `in vec2 vN; uniform sampler2D uSrc; uniform vec2 uTx; out vec4 o;
void main() { vec2 uv = vN * 0.5 + 0.5; vec3 c = texture(uSrc, uv).rgb * 0.5;
  c += (texture(uSrc, uv + uTx * vec2(-1, -1)).rgb + texture(uSrc, uv + uTx * vec2(1, -1)).rgb
      + texture(uSrc, uv + uTx * vec2(-1, 1)).rgb + texture(uSrc, uv + uTx * vec2(1, 1)).rgb) * 0.125;
  o = vec4(c, 1.0); }`;
const UP_FS = HEAD + `in vec2 vN; uniform sampler2D uSrc; uniform vec2 uTx; out vec4 o;
void main() { vec2 uv = vN * 0.5 + 0.5; vec3 c = texture(uSrc, uv).rgb * 4.0;
  c += (texture(uSrc, uv + uTx * vec2(-1, 0)).rgb + texture(uSrc, uv + uTx * vec2(1, 0)).rgb
      + texture(uSrc, uv + uTx * vec2(0, -1)).rgb + texture(uSrc, uv + uTx * vec2(0, 1)).rgb) * 2.0;
  c += texture(uSrc, uv + uTx * vec2(-1, -1)).rgb + texture(uSrc, uv + uTx * vec2(1, -1)).rgb
     + texture(uSrc, uv + uTx * vec2(-1, 1)).rgb + texture(uSrc, uv + uTx * vec2(1, 1)).rgb;
  o = vec4(c / 16.0, 1.0); }`;
const COMP_FS = HEAD + `in vec2 vN; uniform sampler2D uHdr, uBloom; uniform float uBloomK, uT; out vec4 o;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec2 uv = vN * 0.5 + 0.5;
  vec3 c = texture(uHdr, uv).rgb;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  c += texture(uBloom, uv).rgb * uBloomK;
  c = pow(aces(c * 1.05), vec3(1.0 / 2.2));
  c *= 1.0 - 0.28 * pow(length(vN * vec2(0.85, 1.0)) * 0.72, 2.2);
  c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + uT) * 43758.5453) - 0.5) / 255.0;
  o = vec4(c, 1.0);
}`;

// ── geometry ───────────────────────────────────────────────────────────────
function torus(R, r, nu, nv, z = 0) {
  const p = [], n = [], i = [], id = [];
  for (let a = 0; a <= nu; a++) for (let b = 0; b <= nv; b++) {
    const u = (a / nu) * TAU, v = (b / nv) * TAU, cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
    n.push(cv * cu, cv * su, sv); p.push((R + r * cv) * cu, (R + r * cv) * su, z + r * sv); id.push(0);
  }
  for (let a = 0; a < nu; a++) for (let b = 0; b < nv; b++) {
    const k = a * (nv + 1) + b;
    i.push(k, k + nv + 1, k + 1, k + 1, k + nv + 1, k + nv + 2);
  }
  return { p, n, i, id };
}
/** A housing for each validator: a small block on the ring's face, tagged with its index. */
function housings(count) {
  const p = [], n = [], i = [], id = [];
  const neg = x => x.map(v => -v);
  for (let v = 0; v < count; v++) {
    const a = Math.PI / 2 - (v / count) * TAU, c = Math.cos(a), s = Math.sin(a);
    const T = [-s, c, 0], Rd = [c, s, 0], Z = [0, 0, 1];
    const hw = Math.min(0.05, 2.2 / count), hr = 0.026, hz = 0.016, o = [c * GATE.R, s * GATE.R, GATE.tube * 0.78];
    // each face: its normal and half-extent, then the two axes across it with theirs
    const faces = [[Z, hz, T, hw, Rd, hr], [neg(Z), hz, Rd, hr, T, hw], [T, hw, Rd, hr, Z, hz],
                   [neg(T), hw, Z, hz, Rd, hr], [Rd, hr, Z, hz, T, hw], [neg(Rd), hr, T, hw, Z, hz]];
    for (const [f, ef, u, eu, w, ew] of faces) {
      const base = p.length / 3;
      for (const [su, sw] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
        for (let k = 0; k < 3; k++) p.push(o[k] + f[k] * ef + u[k] * eu * su + w[k] * ew * sw);
      for (let q = 0; q < 4; q++) { n.push(...f); id.push(v + 1); }
      i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return { p, n, i, id };
}
function merge(...parts) {
  const out = { p: [], n: [], i: [], id: [] };
  for (const g of parts) {
    const base = out.p.length / 3;
    out.p.push(...g.p); out.n.push(...g.n); out.id.push(...g.id); out.i.push(...g.i.map(k => k + base));
  }
  return out;
}
function sphere(nu = 48, nv = 24) {
  const p = [], i = [];
  for (let b = 0; b <= nv; b++) for (let a = 0; a <= nu; a++) {
    const th = (b / nv) * Math.PI, ph = (a / nu) * TAU;
    p.push(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
  }
  for (let b = 0; b < nv; b++) for (let a = 0; a < nu; a++) {
    const k = b * (nu + 1) + a;
    i.push(k, k + 1, k + nu + 1, k + 1, k + nu + 2, k + nu + 1);
  }
  return { p: new Float32Array(p), i: new Uint16Array(i) };
}

/** An interleaved buffer rebuilt from the CPU; attribute sizes in location order. */
function stream(gl, sizes) {
  const vao = gl.createVertexArray(), buf = gl.createBuffer(), stride = sizes.reduce((a, b) => a + b, 0);
  gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  let off = 0;
  sizes.forEach((s, k) => { gl.enableVertexAttribArray(k); gl.vertexAttribPointer(k, s, gl.FLOAT, false, stride * 4, off * 4); off += s; });
  gl.bindVertexArray(null);
  let cap = 0, n = 0;
  return {
    stride,
    set(data, verts) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      if (data.byteLength > cap) { gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); cap = data.byteLength; }
      else gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, verts * stride);
      n = verts;
    },
    draw() { if (!n) return; gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES, 0, n); gl.bindVertexArray(null); },
  };
}

/** A small seeded generator, so the sky is the same on every visit. */
function seeded(s) { return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ── the renderer ───────────────────────────────────────────────────────────
export class Sky {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('This page needs WebGL 2, and this browser does not offer it.');
    this.gl = gl; this.canvas = canvas;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    this.coarse = matchMedia('(pointer: coarse)').matches;
    const P = (vs, fs, name) => program(gl, vs, fs, name);
    this.pSky = P(FULL_VS, SKY_FS, 'sky'); this.pStar = P(STAR_VS, STAR_FS, 'stars'); this.pGate = P(GATE_VS, GATE_FS, 'gate');
    this.pHz = P(HZ_VS, HZ_FS, 'horizon'); this.pSprite = P(SPRITE_VS, SPRITE_FS, 'sprite'); this.pRib = P(RIB_VS, RIB_FS, 'ribbon');
    this.pSpec = P(SPEC_VS, SPEC_FS, 'spectra'); this.pRing = P(RING_VS, RING_FS, 'rings'); this.pBody = P(BODY_VS, BODY_FS, 'body');
    this.pBright = P(FULL_VS, BRIGHT_FS, 'bright'); this.pDown = P(FULL_VS, DOWN_FS, 'down'); this.pUp = P(FULL_VS, UP_FS, 'up');
    this.pComp = P(FULL_VS, COMP_FS, 'composite');
    this.empty = gl.createVertexArray();

    // the shell of stars
    const rnd = seeded(20260923), sd = [], sc = [], sm = [];
    for (let k = 0; k < 2600; k++) {
      const z = rnd() * 2 - 1, a = rnd() * TAU, r = Math.sqrt(1 - z * z), m = rnd() ** 7;
      for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) { sd.push(r * Math.cos(a), z, r * Math.sin(a)); sc.push(cx, cy); sm.push(m); }
    }
    this.stars = mesh(gl, [[new Float32Array(sd), 3], [new Float32Array(sc), 2], [new Float32Array(sm), 1]]);
    // the horizon's disc and one ring's worth of annulus
    this.quad = mesh(gl, [[new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), 2]]);
    const an = [];
    for (let k = 0; k < 256; k++) {
      const a0 = (k / 256) * TAU, a1 = ((k + 1) / 256) * TAU, c0 = [Math.cos(a0), Math.sin(a0)], c1 = [Math.cos(a1), Math.sin(a1)];
      an.push(...c0, -1, ...c1, -1, ...c1, 1, ...c0, -1, ...c1, 1, ...c0, 1);
    }
    this.annulus = mesh(gl, [[new Float32Array(an), 3]]);
    const sp = sphere();
    this.ball = mesh(gl, [[sp.p, 3]], sp.i);
    this.sprites = stream(gl, [3, 2, 1, 3, 1]);
    this.ribbons = stream(gl, [3, 3, 1]);
    this.spectra = stream(gl, [3, 1, 1, 1]);

    // what is on screen, eased toward what has been checked
    this.n = 0; this.names = [];
    this.lit = new Float32Array(MAXV); this.litTo = new Float32Array(MAXV);
    this.vary = new Float32Array(MAXV).fill(1);
    this.lines = Array.from({ length: MAXV }, () => null);   // each light's spectrum: [pos, strength] × LINES
    this.specDirty = true;
    this.built = 0; this.builtTo = 0; this.thread = 0; this.threadTo = 0;
    this.open = 0; this.openTo = 0; this.heart = 0; this.heartTo = 0;
    this.rings = [];            // { born, z } per proven ledger, newest first
    this.acct = null;           // { state, path, told, drops, at }
    this.t = 0;
    this.view = { yaw: 0.42, pitch: 0.1, dist: 5, target: [0.2, 0.1, -0.6], lens: [0, 0] };
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.targets = null;
  }

  // ── what the page tells it ──
  /** The list checked out: the gate is drawn, one light per validator. */
  setList(validators) {
    const gl = this.gl;
    this.n = Math.min(MAXV, validators.length);
    this.names = validators.map(v => v.domain || v.master.slice(0, 10) + '…');
    // each light is sized from its own key, so a validator looks the same on every visit and every receipt
    validators.slice(0, MAXV).forEach((v, i) => { this.vary[i] = 0.82 + 0.36 * (parseInt(v.master.slice(2, 4), 16) % 5) / 4; });
    const g = merge(torus(GATE.R, GATE.tube, 220, 20), torus(GATE.lip, 0.02, 200, 12, -0.012), housings(this.n));
    this.gate = mesh(gl, [[new Float32Array(g.p), 3], [new Float32Array(g.n), 3], [new Float32Array(g.id), 1]],
      g.p.length / 3 > 65535 ? new Uint32Array(g.i) : new Uint16Array(g.i));
    this.lit.fill(0); this.litTo.fill(0); this.lines.fill(null); this.specDirty = true;
    this.built = 0; this.builtTo = 1; this.thread = 0; this.threadTo = 1; this.threadAt = this.t;
    this.open = this.openTo = 0; this.heart = this.heartTo = 0; this.rings = [];
  }
  /** Forget the list (the visitor chose to trust the other key). */
  clear() { this.builtTo = 0; this.threadTo = 0; this.litTo.fill(0); this.openTo = 0; this.heartTo = 0; }
  /** A new ledger on the press: the last one's light drains away slowly while this one's fills. */
  begin() { this.litTo.fill(0); this.openTo = 0; this.heartTo = 0; }
  /** Validator i's signature on this ledger checked: its light, and its spectrum from the signed bytes. */
  signed(i, sig) {
    if (i >= this.n) return;
    this.litTo[i] = 1;
    if (sig && sig.length) {
      const b = sig.length > 40 ? sig.subarray(sig.length - 32) : sig, ln = [];
      for (let k = 0; k < LINES; k++) ln.push(b[(2 * k) % b.length] / 255, 0.35 + 0.65 * b[(2 * k + 1) % b.length] / 255);
      this.lines[i] = ln; this.specDirty = true;
    }
  }
  /** The set of lights that should be lit, from a recount. */
  signers(set) { for (let i = 0; i < this.n; i++) this.litTo[i] = set.has(i) ? 1 : 0; }
  quorum(on) { this.openTo = on ? 1 : 0; if (!on) this.heartTo = 0; }
  /** The header hashed to what the quorum signed: the heart lights, and the ledger joins the rings. */
  header() {
    this.heartTo = 1;
    this.rings.unshift({ born: this.t });
    if (this.rings.length > RINGS) this.rings.length = RINGS;
  }
  /** An account: 'told' (the relay's word), 'proven', 'absent' (proven missing), or null. */
  account(a) {
    if (!a) { this.acct = null; return; }
    const was = this.acct;
    const same = was && was.addr === a.addr;
    this.acct = { ...a, since: same && was.state === a.state ? was.since : this.t, lit: same ? was.lit : 0, told: same ? was.told : 0 };
  }

  // ── the camera ──
  eye(v = this.view) {
    const cp = Math.cos(v.pitch);
    return [v.target[0] + v.dist * Math.sin(v.yaw) * cp, v.target[1] + v.dist * Math.sin(v.pitch), v.target[2] + v.dist * Math.cos(v.yaw) * cp];
  }
  matrices(v = this.view, w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight) {
    const eye = this.eye(v), view = M.lookAt(eye, v.target, [0, 1, 0]);
    const proj0 = M.perspective(0.62, w / h, 0.05, 400), [lx, ly] = v.lens;
    const proj = M.crop(proj0, -1 - lx, 1 - lx, -1 - ly, 1 - ly);
    return { eye, view, proj, vp: M.mul(proj, view), w, h };
  }
  /** A point in the scene, in CSS pixels on screen (z > 1 when it is behind the eye). */
  project(p, m = this.m || this.matrices()) {
    const q = M.apply(m.vp, p);
    const behind = V.dot(V.sub(p, m.eye), V.sub(this.view.target, m.eye)) < 0;
    return [(q[0] * 0.5 + 0.5) * m.w, (0.5 - q[1] * 0.5) * m.h, behind ? 2 : q[2]];
  }
  /** The view that shows a sphere (centre, radius) whole inside a box on screen (CSS px). */
  frameSphere(centre, radius, box, yaw, pitch, w = innerWidth, h = innerHeight) {
    const t = Math.tan(0.31), hx = (box[2] - box[0]) / w, hy = (box[3] - box[1]) / h;
    const dist = 1.06 * Math.max(radius / (t * hy), radius / (t * (w / h) * hx));
    const lens = [((box[0] + box[2]) / w) - 1, 1 - ((box[1] + box[3]) / h)];
    return { yaw, pitch, dist, target: centre.slice(), lens };
  }
  /** What is under the pointer: a validator's light, the key, the account, or nothing. */
  pick(x, y) {
    let best = null, bd = 1e9;
    const consider = (kind, p, r, i) => {
      const s = this.project(p);
      if (s[2] > 1) return;
      const d = Math.hypot(s[0] - x, s[1] - y);
      if (d < r && d < bd) { bd = d; best = { kind, i, at: s }; }
    };
    if (this.built > 0.99) for (let i = 0; i < this.n; i++) consider('validator', lightAt(i, this.n), 16, i);
    consider('key', KEY_AT, 22);
    if (this.acct) consider('account', BODY_AT, 30);
    return best;
  }

  // ── one frame ──
  frame(dt) { this.advance(dt); this.draw(); }
  /** Move time on: every light eases toward what has been checked. */
  advance(dt) {
    this.t += dt;
    const R = this.reduced ? 60 : 1;
    for (let i = 0; i < this.n; i++) this.lit[i] = ease(this.lit[i], this.litTo[i], 6 * R, 1.0 * R, dt);
    this.open = ease(this.open, this.openTo, 2.4 * R, 1.1 * R, dt);
    this.heart = ease(this.heart, this.heartTo, 5 * R, 1.2 * R, dt);
    // the key's thread reaches the gate first, then the gate is drawn round
    this.thread = this.threadTo ? Math.min(1, this.thread + dt * (this.reduced ? 100 : 1.25)) : Math.max(0, this.thread - dt * 2);
    if (this.thread >= 1 || !this.threadTo) this.built = this.builtTo ? Math.min(1, this.built + dt * (this.reduced ? 100 : 0.8)) : Math.max(0, this.built - dt * 2);
    for (const [k, r] of this.rings.entries()) r.z = ease(r.z === undefined ? 0 : r.z, -0.3 * (k + 1), 2.2 * R, 2.2 * R, dt);
    if (this.acct) {
      const a = this.acct;
      a.told = ease(a.told, 1, 3 * R, 3 * R, dt);
      a.lit = ease(a.lit, a.state === 'proven' ? 1 : 0, 3 * R, 2 * R, dt);
    }
  }

  draw() {
    const gl = this.gl, c = this.canvas;
    // the drawing buffer follows the window, at up to two device pixels per CSS pixel
    const scale = Math.min(devicePixelRatio || 1, this.coarse ? 1.6 : 2);
    const W = Math.max(1, Math.round(c.clientWidth * scale)), H = Math.max(1, Math.round(c.clientHeight * scale));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    this.ensureTargets(W, H);
    const m = this.m = this.matrices();
    const rot = m.view.slice(); rot[12] = rot[13] = rot[14] = 0;
    const vpr = M.mul(m.proj, rot);

    const T = this.targets;
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.hdr.fb); gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
    gl.useProgram(this.pSky.p); uniforms(gl, this.pSky, { uInv: M.invert(vpr), uT: this.t });
    gl.bindVertexArray(this.empty); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pStar.p); uniforms(gl, this.pStar, { uVPr: vpr, uPx: [2 / W * scale, 2 / H * scale] });
    this.stars.draw();

    // solid things
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LEQUAL);
    if (this.gate && this.built > 0.001) {
      gl.useProgram(this.pGate.p);
      uniforms(gl, this.pGate, { uVP: m.vp, uEye: m.eye, uLit: this.lit, uOpen: this.open, uBuilt: this.built });
      this.gate.draw();
    }
    const a = this.acct;
    if (a && a.state === 'proven' && a.lit > 0.01) {
      gl.useProgram(this.pBody.p);
      uniforms(gl, this.pBody, { uVP: m.vp, uAt: BODY_AT, uR: 0.17, uEye: m.eye, uLit: a.lit, uTold: 1, uSpin: this.t * 0.05 });
      this.ball.draw();
    }

    // light, added up
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
    this.drawRings(m);
    if (this.open > 0.002) {
      gl.useProgram(this.pHz.p); uniforms(gl, this.pHz, { uVP: m.vp, uR: GATE.hz, uT: this.t, uOpen: this.open });
      this.quad.draw();
    }
    if (a && (a.state !== 'proven' || a.lit < 0.99) && a.state !== 'absent') {
      gl.useProgram(this.pBody.p);
      uniforms(gl, this.pBody, { uVP: m.vp, uAt: BODY_AT, uR: 0.17, uEye: m.eye, uLit: 0, uTold: a.told * (1 - a.lit), uSpin: this.t * 0.05 });
      this.ball.draw();
    }
    if (this.specDirty) this.buildSpectra();
    gl.useProgram(this.pSpec.p); uniforms(gl, this.pSpec, { uVP: m.vp, uLit: this.lit });
    this.spectra.draw();
    this.buildRibbons(m);
    gl.useProgram(this.pRib.p); uniforms(gl, this.pRib, { uVP: m.vp });
    this.ribbons.draw();
    this.buildSprites();
    gl.useProgram(this.pSprite.p); uniforms(gl, this.pSprite, { uV: m.view, uP: m.proj });
    this.sprites.draw();
    gl.disable(gl.DEPTH_TEST); gl.depthMask(true);

    this.bloom(W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.disable(gl.BLEND);
    gl.useProgram(this.pComp.p);
    uniforms(gl, this.pComp, { uHdr: { tex: T.hdr.tex, unit: 0 }, uBloom: { tex: T.mips[0].tex, unit: 1 }, uBloomK: 0.85, uT: this.t % 7 });
    gl.bindVertexArray(this.empty); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  drawRings(m) {
    const gl = this.gl;
    gl.useProgram(this.pRing.p);
    this.rings.forEach((r, k) => {
      const age = this.t - r.born, fade = Math.pow(0.87, k) * Math.min(1, age * 1.5), flash = Math.exp(-age * 2.2);
      uniforms(gl, this.pRing, { uVP: m.vp, uZ: r.z || 0, uR: GATE.hz * (1 - 0.018 * k), uW: 0.006 + 0.012 * flash,
        uCol: [0.10 + 0.9 * flash, 0.36 + 1.2 * flash, 0.62 + 1.6 * flash].map(x => x * fade * 0.8) });
      this.annulus.draw();
    });
    // the gate's thin outer ring, as Deep Field has, once it is drawn
    if (this.built > 0.99) {
      uniforms(gl, this.pRing, { uVP: m.vp, uZ: 0, uR: 1.085, uW: 0.004, uCol: [0.05, 0.13, 0.22] });
      this.annulus.draw();
    }
  }

  buildSpectra() {
    const out = [];
    const w = Math.PI / Math.max(1, this.n) * 0.42;
    for (let i = 0; i < this.n; i++) {
      const ln = this.lines[i];
      if (!ln) continue;
      const a0 = Math.PI / 2 - (i / this.n) * TAU;
      for (let k = 0; k < LINES; k++) {
        const r = 1.13 + 0.26 * ln[2 * k], dr = 0.0055, s = ln[2 * k + 1];
        const P = (ang, rr) => [Math.cos(ang) * rr, Math.sin(ang) * rr, 0.01];
        const v = [[a0 - w, r - dr, -1], [a0 + w, r - dr, -1], [a0 + w, r + dr, 1], [a0 - w, r - dr, -1], [a0 + w, r + dr, 1], [a0 - w, r + dr, 1]];
        for (const [ang, rr, vv] of v) out.push(...P(ang, rr), i, s, vv);
      }
    }
    this.spectra.set(new Float32Array(out), out.length / 6);
    this.specDirty = false;
  }

  /** Camera-facing ribbons along polylines: [points, colour(t), width, alpha(t)]. */
  buildRibbons(m) {
    const out = [], fwd = V.norm(V.sub(this.view.target, m.eye));
    const ribbon = (pts, col, width) => {
      for (let k = 0; k < pts.length - 1; k++) {
        const p0 = pts[k], p1 = pts[k + 1], t = V.norm(V.sub(p1, p0));
        const s = V.norm(V.cross(t, fwd)).map(x => x * width);
        const c0 = col(k / (pts.length - 1)), c1 = col((k + 1) / (pts.length - 1));
        if (!c0 && !c1) continue;
        const z = [0, 0, 0], A = c0 || z, B = c1 || z;
        const q = (p, d, sign) => [p[0] + d[0] * sign, p[1] + d[1] * sign, p[2] + d[2] * sign];
        out.push(...q(p0, s, -1), ...A, -1, ...q(p1, s, -1), ...B, -1, ...q(p1, s, 1), ...B, 1,
                 ...q(p0, s, -1), ...A, -1, ...q(p1, s, 1), ...B, 1, ...q(p0, s, 1), ...A, 1);
      }
    };
    // the key's thread: from the guide star to the top of the gate, drawn once the list checks
    if (this.thread > 0.001 || this.built > 0.001) {
      const top = [0, GATE.R + GATE.tube, 0], mid = [(KEY_AT[0] + top[0]) / 2 + 0.2, (KEY_AT[1] + top[1]) / 2 + 0.55, (KEY_AT[2] + top[2]) / 2 + 0.3];
      const pts = [];
      for (let k = 0; k <= 48; k++) { const u = k / 48, a = (1 - u) ** 2, b = 2 * u * (1 - u), cc = u * u; pts.push([0, 1, 2].map(j => a * KEY_AT[j] + b * mid[j] + cc * top[j])); }
      const reach = this.thread, glint = this.threadTo && this.thread < 1 ? this.thread : -1;
      ribbon(pts, u => {
        if (u > reach + 0.001) return null;
        const g = glint >= 0 ? Math.exp(-Math.pow((u - glint) / 0.04, 2)) * 3 : 0;
        const base = 0.16 + g;
        return [1.0 * base * (1 - u) + 0.25 * base * u, 0.72 * base * (1 - u) + 0.7 * base * u, 0.32 * base * (1 - u) + 1.1 * base * u];
      }, 0.009);
    }
    // an account's path: from the heart (the state root) through one inner node per hex digit, hop by hop
    const a = this.acct;
    if (a && a.path && (a.state === 'proven' || a.state === 'absent')) {
      const pts = this.pathPoints(a), hops = pts.length - 1, shown = Math.min(hops, (this.t - a.since) * (this.reduced ? 100 : 5));
      ribbon(pts, u => {
        const k = u * hops;
        if (k > shown + 0.001) return null;
        const hot = Math.exp(-Math.pow(k - shown, 2) * 2) * 2.5;
        return [0.18 + 0.4 * hot, 0.55 + 0.9 * hot, 0.9 + 1.2 * hot].map(x => x * 0.55);
      }, 0.007);
    }
    this.ribbons.set(new Float32Array(out), out.length / 7);
  }

  pathPoints(a) {
    const end = a.state === 'absent' ? V.sub(BODY_AT, [0.25, -0.05, -0.15]) : BODY_AT;
    const hops = Math.max(1, a.path.length), dir = V.norm(end);
    const u = V.norm(V.cross(dir, [0, 1, 0])), w = V.cross(u, dir), pts = [];
    for (let k = 0; k <= hops; k++) {
      const f = k / hops, nib = k < a.path.length ? parseInt(a.path[k], 16) : 0, th = (nib / 16) * TAU;
      const off = Math.sin(Math.PI * f) * 0.3;
      pts.push([0, 1, 2].map(j => end[j] * f + (u[j] * Math.cos(th) + w[j] * Math.sin(th)) * off * (k > 0 && k < hops ? 1 : 0)));
    }
    return pts;
  }

  buildSprites() {
    const out = [];
    const put = (c, size, col, kind) => {
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) out.push(c[0], c[1], c[2], x, y, size, col[0], col[1], col[2], kind);
    };
    // the key: a gold guide star, always lit, since it is built into the page
    const breathe = this.reduced ? 1 : 0.92 + 0.08 * Math.sin(this.t * 1.3);
    put(KEY_AT, 0.95, [0.16, 0.11, 0.05].map(x => x * breathe), 0);
    put(KEY_AT, 0.2, [2.0, 1.45, 0.75], 3);
    // the lights, once the gate is drawn to them
    for (let i = 0; i < this.n; i++) {
      const p = lightAt(i, this.n), l = this.lit[i], v = this.vary[i];
      const along = ((i / this.n) + 0.0001);
      if (along > this.built) continue;
      if (l > 0.003) {
        put(p, 0.26 * v, [0.55 * 0.115, 1.10 * 0.115, 1.70 * 0.115].map(x => x * l), 0);
        put(p, 0.075 * v, [0.54, 0.88, 1.22].map(x => x * l), 1);
      }
      put(p, 0.036, [0.05, 0.08, 0.13].map(x => x * (1 - l)), 2);   // a socket, where no signature is checked yet
    }
    // the heart: the ledger's own light, once its header checks
    if (this.heart > 0.003) {
      put([0, 0, 0.02], 0.55, [0.10, 0.20, 0.30].map(x => x * this.heart), 0);
      put([0, 0, 0.02], 0.1, [1.3, 1.9, 2.4].map(x => x * this.heart), 1);
    }
    const a = this.acct;
    if (a) {
      if (a.state === 'proven') put(BODY_AT, 0.75, [0.05, 0.13, 0.22].map(x => x * a.lit), 0);
      if (a.path && (a.state === 'proven' || a.state === 'absent')) {
        const pts = this.pathPoints(a), shown = Math.min(pts.length - 1, (this.t - a.since) * (this.reduced ? 100 : 5));
        for (let k = 1; k < pts.length - 1; k++) if (k <= shown) put(pts[k], 0.05, [0.4, 0.9, 1.3], 1);   // the inner nodes
        if (a.state === 'absent' && shown >= pts.length - 1.01) put(pts[pts.length - 1], 0.16, [0.35, 0.5, 0.7], 2);   // nothing here
      }
    }
    this.sprites.set(new Float32Array(out), out.length / 10);
  }

  ensureTargets(W, H) {
    const gl = this.gl;
    if (this.targets && this.targets.W === W && this.targets.H === H) return;
    if (this.targets) this.targets.free();
    const fmt = this.hdr ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT } : {};
    const mk = (w, h, depth) => {
      const fb = gl.createFramebuffer(), tex = texture(gl, w, h, fmt);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      let rb = null;
      if (depth) {
        rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      }
      return { fb, tex, w, h, rb };
    };
    const hdr = mk(W, H, true), mips = [];
    let w = Math.max(1, W >> 1), h = Math.max(1, H >> 1);
    for (let k = 0; k < 6 && w > 2 && h > 2; k++) { mips.push(mk(w, h, false)); w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.targets = { W, H, hdr, mips, free() { for (const t of [hdr, ...mips]) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); if (t.rb) gl.deleteRenderbuffer(t.rb); } } };
  }

  bloom() {
    const gl = this.gl, { hdr, mips } = this.targets;
    gl.disable(gl.BLEND); gl.bindVertexArray(this.empty);
    const pass = (prog, dst, src, u = {}) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.viewport(0, 0, dst.w, dst.h);
      gl.useProgram(prog.p); uniforms(gl, prog, { uSrc: { tex: src.tex, unit: 0 }, ...u });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    pass(this.pBright, mips[0], hdr);
    for (let k = 1; k < mips.length; k++) pass(this.pDown, mips[k], mips[k - 1], { uTx: [1 / mips[k - 1].w, 1 / mips[k - 1].h] });
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let k = mips.length - 1; k > 0; k--) pass(this.pUp, mips[k - 1], mips[k], { uTx: [1 / mips[k].w, 1 / mips[k].h] });
    gl.disable(gl.BLEND);
  }
}
