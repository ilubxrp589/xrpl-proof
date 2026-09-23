/* GLSL for the Proof page.
 *   TEMPLE     the 35-column temple rendered as intaglio line engraving
 *   ENGRAVE    composes the vignette: contours, sky ruling, glory, ink state
 *   NOTE       the sheet: paper, underprint, raised ink, foil seal, thread,
 *              watermark, fluorescence, pencil, under four lights
 *   BENCH, POST
 *
 * Every engraved line is an iso-line of a field F: centres at integer F, ink
 * fraction w per period. lineAA() keeps the mean coverage at w at any pixel
 * footprint (a line thinner than a pixel is widened and dimmed instead of
 * breaking up), which is what stops moiré shimmer while the sheet moves.
 */
const HEAD = `#version 300 es
precision highp float;
precision highp int;
`;

const LINES = `
float lineCore(float F, float w, float d){
  float dw = clamp(w, d, 0.5);
  float g = 1.0 - abs(fract(F) * 2.0 - 1.0);
  float a = (1.0 - smoothstep(dw - 1.5 * d, dw + 1.5 * d, g)) * w / max(dw, 1e-6);
  return mix(a, w, clamp(2.0 * d - 1.0, 0.0, 1.0));
}
float lineAA(float F, float w, float d){
  return w <= 0.5 ? lineCore(F, w, d) : 1.0 - lineCore(F + 0.5, 1.0 - w, d);
}
// Lines along a phase, held near 'spacing' pixels apart by choosing the
// power-of-two frequency that fits and crossfading into the next octave.
float lines(float phase, float w, float spacing){
  float fw = max(length(vec2(dFdx(phase), dFdy(phase))), 1e-6);
  float L = log2(1.0 / (spacing * fw));
  float f0 = exp2(floor(L)), t = smoothstep(0.0, 1.0, fract(L));
  return mix(lineAA(phase * f0, w, fw * f0), lineAA(phase * f0 * 2.0, w, fw * f0 * 2.0), t);
}`;

const NOISE = `
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p){ float a = 0.5, s = 0.0; for(int i = 0; i < 5; i++){ s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }`;

// ── shadow map for the temple ────────────────────────────────────────────────
export const SHADOW_VS = HEAD + `
layout(location=0) in vec3 aPos;
uniform mat4 uLightVP, uModel;
void main(){ gl_Position = uLightVP * uModel * vec4(aPos, 1.0); }`;
export const SHADOW_FS = HEAD + `
out vec4 o;
void main(){ o = vec4(1.0); }`;

// ── the temple, engraved ─────────────────────────────────────────────────────
export const TEMPLE_VS = HEAD + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec4 aAtt;           // part, u, v, -
uniform mat4 uVP, uModel, uLightVP;
out vec3 vW; out vec3 vN; out vec4 vAtt; out vec4 vLS; out float vZ;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz; vN = mat3(uModel) * aNrm; vAtt = aAtt;
  vLS = uLightVP * w;
  gl_Position = uVP * w;
  vZ = gl_Position.w;
}`;

export const TEMPLE_FS = HEAD + LINES + `
in vec3 vW; in vec3 vN; in vec4 vAtt; in vec4 vLS; in float vZ;
uniform vec3 uLight;        // direction TO the lamp, temple space
uniform vec3 uEye;
uniform highp sampler2D uShadowDepth;
uniform float uSpacing;     // target line spacing in target pixels
uniform float uFar;
uniform vec2 uDepthFade;    // view depth where the far side starts, and ends, lightening
uniform vec2 uPartY[41];    // per part: y range, for ink that rises
layout(location=0) out vec4 o0;   // lines (full), scribe, part, rise
layout(location=1) out vec4 o1;   // depth, n.v, light, coverage

float shadowAt(vec4 ls){
  vec3 p = ls.xyz / ls.w * 0.5 + 0.5;
  if(p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;
  vec2 texel = 1.0 / vec2(textureSize(uShadowDepth, 0));
  float s = 0.0;
  for(int i = -1; i <= 1; i++) for(int j = -1; j <= 1; j++){
    float d = texture(uShadowDepth, p.xy + vec2(i, j) * texel * 1.5).r;
    s += (p.z - 0.0015 > d) ? 0.0 : 1.0;
  }
  return s / 9.0;
}
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(uEye - vW);
  if(dot(N, V) < 0.0) N = -N;
  int part = int(vAtt.x + 0.5);
  float sh = shadowAt(vLS);
  float diff = max(dot(N, uLight) * 0.8 + 0.2, 0.0);
  float light = 0.08 + 0.92 * diff * mix(0.3, 1.0, sh) + 0.1 * max(N.y, 0.0);
  // engravers lighten what is far away, so depth reads without colour
  float far = smoothstep(uDepthFade.x, uDepthFade.y, vZ);
  float tone = clamp(pow(clamp(1.0 - light, 0.0, 1.0), 0.8) * 1.08 + 0.1, 0.0, 1.0) * mix(1.0, 0.55, far);

  // two families that follow the form, a third for the deepest shade
  float p1, p2;
  if(part < 35){ p1 = vAtt.y * 48.0; p2 = vW.y * 2.2; }           // flutes, then rings
  else if(part == 36){ p1 = vAtt.y * 140.0; p2 = vAtt.z * 2.4; }  // meridians, then latitudes
  else if(part == 40){ p1 = vW.z * 1.4; p2 = vW.x * 1.4; }        // the ground
  else { p1 = vW.y * 3.0; p2 = vAtt.y * 90.0; }                   // steps, beam, lantern

  float w1 = clamp(tone * 1.05, 0.0, 0.94);
  float w2 = clamp((tone - 0.42) * 1.7, 0.0, 0.8);
  float w3 = clamp((tone - 0.74) * 2.4, 0.0, 0.7);
  float ink = max(max(lines(p1, w1, uSpacing), lines(p2, w2, uSpacing * 1.15)),
                  lines(p1 * 0.7 + p2 * 0.7, w3, uSpacing * 1.3));
  // the scribe: faint first lines, cut before any ink is laid
  float scribe = lines(p1, 0.07, uSpacing * 1.6) * 0.55;

  vec2 yr = uPartY[part];
  float rise = clamp((vW.y - yr.x) / max(yr.y - yr.x, 1e-3), 0.0, 1.0);
  o0 = vec4(ink, scribe, float(part), rise);
  o1 = vec4(vZ / uFar, dot(N, V), light, 1.0);
}`;

// ── compose the vignette ─────────────────────────────────────────────────────
export const FULL_VS = HEAD + `
out vec2 vUv;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const ENGRAVE_FS = HEAD + LINES + NOISE + `
in vec2 vUv;
uniform sampler2D uG0, uG1;
uniform float uInk[41];     // per part: 0 scribe only, 1 fully inked
uniform float uGlory;       // the ledger header is proven: rays from the dome
uniform vec2 uDomeTop;      // in vUv
uniform float uTime, uSpacing, uContour;
uniform vec2 uRes;
uniform vec4 uCrop;         // the part of the whole vignette this target covers (texture uv)
out vec4 o;
void main(){
  vec4 g0 = texture(uG0, vUv), g1 = texture(uG1, vUv);
  vec2 px = uContour / uRes;
  float ink = 0.0, relief = 0.0;
  vec2 fv = mix(uCrop.xy, uCrop.zw, vUv);          // whole-vignette coordinates: fixed to the paper
  vec2 q = fv - 0.5;
  float fade = 1.0 - smoothstep(0.84, 1.0, length(q / 0.5));   // an engraved vignette fades out

  if(g1.a > 0.5){
    int part = int(g0.z + 0.5);
    float k = uInk[part];
    float inked = smoothstep(g0.w - 0.06, g0.w + 0.06, k * 1.12 - 0.06);
    ink = mix(g0.y, g0.x, inked);
    float c = 0.0;
    for(int i = 0; i < 4; i++){
      vec2 d = (i == 0) ? vec2(px.x, 0) : (i == 1) ? vec2(-px.x, 0) : (i == 2) ? vec2(0, px.y) : vec2(0, -px.y);
      vec4 n0 = texture(uG0, vUv + d), n1 = texture(uG1, vUv + d);
      float dz = clamp(abs(n1.x - g1.x) * 90.0 - 0.5, 0.0, 1.0);
      float dp = abs(n0.z - g0.z) > 0.5 ? 0.8 : 0.0;
      c = max(c, max(max(dz, dp), n1.a < 0.5 ? 1.0 : 0.0));
    }
    ink = max(ink, c * mix(0.45, 1.0, inked));
    relief = ink * mix(0.3, 1.0, inked);
  } else {
    // sky: horizontal ruling, heavier toward the top, broken by cloud
    float y = fv.y;
    float cloud = noise(vec2(fv.x * 5.0 + uTime * 0.01, y * 9.0)) * noise(vec2(fv.x * 11.0, y * 17.0 - uTime * 0.02));
    float wsky = clamp(0.05 + (y - 0.35) * 0.5 - cloud * 0.35, 0.0, 0.55);
    float rp = fv.y * uRes.y / ((uCrop.w - uCrop.y) * uSpacing * 1.05);   // rules fixed to the paper
    ink = lineAA(rp, wsky, fwidth(rp)) * step(0.16, y);
    // glory: rays from the dome once the ledger itself is proven
    vec2 d = (fv - uDomeTop) * vec2(uRes.x / uRes.y, 1.0);
    float ang = atan(d.y, d.x), r = length(d);
    float rays = lineAA(ang * 40.0 / 6.28318, 0.16 + 0.22 * smoothstep(0.6, 0.0, r), 0.08);
    float reach = smoothstep(uGlory * 0.95 + 0.02, uGlory * 0.95 - 0.12, r) * step(0.01, uGlory);
    ink = max(ink * (1.0 - reach * 0.7), rays * reach * step(uDomeTop.y - 0.3, fv.y) * 0.9);
    relief = ink * 0.6;
  }
  o = vec4(ink * fade, relief * fade, 0.0, 1.0);
}`;

// ── the sheet ────────────────────────────────────────────────────────────────
export const NOTE_VS = HEAD + `
layout(location=0) in vec2 aUv;
uniform mat4 uVP, uModel;
uniform vec2 uSize;
uniform float uTime, uCurl;
out vec2 vUv; out vec3 vW; out vec3 vN;
vec3 surf(vec2 uv){
  vec2 p = (uv - 0.5) * uSize;
  float z = uCurl * (0.55 * (uv.x - 0.5) * (uv.x - 0.5) - 0.18 * sin(3.14159 * uv.y)
            + 0.012 * sin(uv.x * 9.0 + uTime * 0.6) * sin(uv.y * 5.0 + uTime * 0.4));
  return vec3(p, z * uSize.y);
}
void main(){
  vUv = aUv;
  vec3 p = surf(aUv);
  vec3 px = surf(aUv + vec2(0.002, 0.0)) - p, py = surf(aUv + vec2(0.0, 0.002)) - p;
  vec4 w = uModel * vec4(p, 1.0);
  vW = w.xyz; vN = normalize(mat3(uModel) * cross(px, py));
  gl_Position = uVP * w;
}`;

export const NOTE_FS = HEAD + NOISE + `
in vec2 vUv; in vec3 vW; in vec3 vN;
uniform sampler2D uPlate, uFoil, uUvt, uWater, uDyn, uDynUv, uVig, uBack, uBackDyn;
uniform vec4 uVigRect;       // x, y, w, h in sheet uv
uniform vec4 uVigCrop;       // the part of the vignette the engraving target covers (texture uv)
uniform vec3 uSeal;          // centre uv, radius (in x-uv units)
uniform vec3 uEye, uLamp, uLampCol;
uniform int uMode;           // 0 day, 1 raking, 2 backlight, 3 ultraviolet
uniform float uTime, uQuorum, uFade, uAspect;
uniform vec2 uTexel;
out vec4 o;

const vec3 RAG = vec3(0.93, 0.925, 0.878);
const vec3 INK = vec3(0.052, 0.042, 0.082);
const vec3 RED = vec3(0.60, 0.16, 0.13);
const vec3 GRAPHITE = vec3(0.36, 0.37, 0.40);

// thin film (MgF2-like, n = 1.38) over metal, seen at cos(theta)
vec3 film(float d, float c){
  vec3 lam = vec3(650.0, 540.0, 450.0);
  float ct = sqrt(max(1.0 - (1.0 - c * c) / (1.38 * 1.38), 0.0));
  return 0.5 + 0.5 * cos(12.566 * 1.38 * d * ct / lam);
}
vec3 env(vec3 r){
  float lamp = pow(max(dot(r, normalize(vec3(-0.5, 0.7, 0.5))), 0.0), 60.0) * 9.0;
  float win = smoothstep(0.93, 0.99, dot(r, normalize(vec3(0.8, 0.35, 0.4)))) * 1.5;
  return vec3(0.035, 0.04, 0.038) + lamp * vec3(1.0, 0.8, 0.55) + win * vec3(0.55, 0.7, 0.9)
       + max(r.y, 0.0) * vec3(0.05, 0.06, 0.06);
}
vec3 spectrum(float x){   // 0..1 across the visible, soft bumps
  return clamp(vec3(1.0 - abs(x - 0.78) * 3.2, 1.0 - abs(x - 0.5) * 3.2, 1.0 - abs(x - 0.22) * 3.2), 0.0, 1.0);
}
vec4 vigAt(vec2 uv){
  vec2 v = (uv - uVigRect.xy) / uVigRect.zw;
  if(v.x < 0.0 || v.x > 1.0 || v.y < 0.0 || v.y > 1.0) return vec4(0.0);
  vec2 g = (vec2(v.x, 1.0 - v.y) - uVigCrop.xy) / (uVigCrop.zw - uVigCrop.xy);
  if(g.x < 0.0 || g.x > 1.0 || g.y < 0.0 || g.y > 1.0) return vec4(0.0);
  return texture(uVig, g);
}
float vig(vec2 uv){ return vigAt(uv).r; }
float inkFront(vec2 uv){ return clamp(texture(uPlate, uv, -0.6).a + texture(uDyn, uv, -0.6).r + vig(uv), 0.0, 1.0); }
float inkBack(vec2 uv){ return clamp(texture(uBack, uv, -0.6).a + texture(uBackDyn, uv, -0.6).r, 0.0, 1.0); }

void main(){
  bool back = !gl_FrontFacing;
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  if(back) uv.x = 1.0 - uv.x;
  vec3 N = normalize(vN); if(back) N = -N;
  vec3 V = normalize(uEye - vW);
  vec3 Ld = normalize(uLamp - vW);
  float dist = length(uLamp - vW);

  float fib = fbm(uv * vec2(1100.0, 300.0)) * 0.6 + fbm(uv * vec2(200.0, 800.0)) * 0.4;
  vec3 paper = RAG * (0.94 + 0.08 * fib) * (0.985 + 0.03 * fbm(uv * 14.0));
  vec4 plate = back ? texture(uBack, uv) : texture(uPlate, uv);
  vec3 col = paper * plate.rgb;

  float ink = back ? inkBack(uv) : inkFront(uv);
  vec4 dyn = back ? vec4(0.0) : texture(uDyn, uv);
  vec4 duv = back ? vec4(0.0) : texture(uDynUv, uv);
  // raised intaglio: the ink's height bends the normal; raking light shows it
  vec2 e = uTexel * 1.4;
  float hX = back ? inkBack(uv + vec2(e.x, 0.0)) : inkFront(uv + vec2(e.x, 0.0));
  float hY = back ? inkBack(uv + vec2(0.0, e.y)) : inkFront(uv + vec2(0.0, e.y));
  float bump = (uMode == 1 ? 2.6 : 1.0);
  vec3 T = normalize(vec3(1.0, 0.0, 0.0)), B = normalize(cross(N, T)); T = cross(B, N);
  vec3 Nb = normalize(N - (T * (hX - ink) - B * (hY - ink)) * 0.9 * bump
                        + (vec3(noise(uv * 2600.0), noise(uv * 2600.0 + 7.0), 0.0) - 0.5) * 0.04);

  // red letterpress, the optically variable count, pencil
  col = mix(col, RED * (0.9 + 0.1 * fib), dyn.g * 0.95);
  float cosv = clamp(dot(Nb, V), 0.0, 1.0);
  vec3 ovi = mix(vec3(0.12, 0.40, 0.33), vec3(0.64, 0.49, 0.12), smoothstep(0.62, 0.97, cosv + 0.1 * sin(uTime * 0.3)));
  col = mix(col, ovi, dyn.b * 0.97);
  col = mix(col, INK * (0.85 + 0.2 * fib), ink * 0.96);
  float pencil = duv.g;
  col = mix(col, GRAPHITE * (0.9 + 0.2 * noise(uv * 3000.0)), pencil * 0.85);

  // the foil: seal and thread windows, a film over a diffraction relief
  float foil = back ? 0.0 : texture(uFoil, uv).r;
  vec3 foilCol = vec3(0.0);
  if(foil > 0.01){
    vec2 sp = (uv - uSeal.xy) * vec2(1.0, 1.0 / uAspect) / uSeal.z;   // seal space, radius 1
    float r = length(sp), ang = atan(sp.y, sp.x);
    // the star: 35 rays, struck only when quorum holds
    float star = smoothstep(0.03, 0.0, abs(fract(ang * 35.0 / 6.28318) - 0.5) - 0.42 + r * 0.25) * smoothstep(0.92, 0.8, r);
    // concentric diffraction grooves, their pitch varying with angle
    vec2 tg = normalize(vec2(-sp.y, sp.x) + 1e-4);
    vec3 Tt = normalize(T * tg.x - B * tg.y);
    float u = dot(Tt, Ld + V);
    float pitch = 1.3 + 0.25 * sin(ang * 5.0 + r * 9.0);
    vec3 diff = vec3(0.0);
    for(int n = 1; n <= 2; n++){ float lam = abs(u) * pitch / float(n); diff += spectrum((lam - 0.35) / 0.5); }
    float thick = 300.0 + 150.0 * fbm(uv * vec2(40.0, 30.0) + uTime * 0.015);
    vec3 irid = film(thick, dot(Nb, V));
    vec3 R = reflect(-V, Nb);
    vec3 metal = env(R) * 1.3 + 0.2;
    foilCol = metal * mix(irid, diff * 1.4 + 0.2, 0.55);
    foilCol = mix(foilCol * 0.55, foilCol * 1.25 + star * 0.35, uQuorum);
    foilCol = mix(foilCol, foilCol.gbr, star * uQuorum * 0.5);
  }

  float lamb = max(dot(Nb, Ld), 0.0);
  float att = 1.0 / (1.0 + 0.00004 * dist * dist);
  vec3 H = normalize(Ld + V);
  float spec = pow(max(dot(Nb, H), 0.0), 50.0) * (0.02 + 0.3 * ink + 0.2 * pencil);
  vec3 lit;
  if(uMode == 2){
    // transmitted light: the lamp is behind the sheet. Ink and foil block it;
    // the watermark is the paper's own thickness.
    float wm = texture(uWater, back ? vec2(1.0 - uv.x, uv.y) : uv).r;
    float formation = 0.8 + 0.35 * fbm(uv * vec2(40.0, 26.0));
    float trans = (1.0 - ink * 0.9) * (1.0 - foil * 0.97) * exp(-1.1 * wm) * formation;
    lit = vec3(1.0, 0.92, 0.76) * 1.7 * trans * mix(vec3(1.0), plate.rgb, 0.3);
  } else if(uMode == 3){
    // ultraviolet: the sheet goes dark; fibres, the trusted key and the names
    // of validators whose signatures were checked fluoresce
    vec3 uvt = back ? vec3(0.0) : texture(uUvt, uv).rgb;
    vec3 base = vec3(0.035, 0.022, 0.085) * (0.8 + 0.3 * fib) * (1.0 - ink * 0.7);
    lit = base + uvt * 0.9 + duv.r * vec3(0.62, 1.0, 0.3) * 1.25 + dyn.b * vec3(0.2, 0.7, 0.55) * 0.18;
  } else {
    vec3 amb = mix(vec3(0.08, 0.09, 0.09), vec3(0.15, 0.145, 0.13), N.y * 0.5 + 0.5);
    lit = col * (amb + uLampCol * lamb * att) + uLampCol * spec * att;
    lit = mix(lit, foilCol * (0.35 + uLampCol * 0.65 * att), foil);
  }
  o = vec4(lit * uFade, 1.0);
}`;

// ── the bench ────────────────────────────────────────────────────────────────
export const BENCH_VS = HEAD + `
layout(location=0) in vec2 aUv;
uniform mat4 uVP;
uniform float uSize;
out vec3 vW;
void main(){
  vec3 p = vec3((aUv.x - 0.5) * uSize, 0.0, (0.5 - aUv.y) * uSize);
  vW = p; gl_Position = uVP * vec4(p, 1.0);
}`;
export const BENCH_FS = HEAD + NOISE + `
in vec3 vW;
uniform vec3 uLamp, uLampCol, uEye;
uniform mat4 uNoteInv;
uniform vec2 uNoteSize;
uniform int uMode;
out vec4 o;
void main(){
  // green leather: a pebbled grain in a pool of lamplight
  vec2 p = vW.xz * 0.9;
  float g = noise(p * 3.0) * 0.6 + noise(p * 9.0) * 0.3 + noise(p * 27.0) * 0.1;
  vec3 N = normalize(vec3((noise(p * 9.0 + 3.1) - 0.5) * 0.35, 1.0, (noise(p * 9.0 + 7.7) - 0.5) * 0.35));
  vec3 L = normalize(uLamp - vW);
  float d = length(uLamp - vW);
  float pool = 1.6 / (1.0 + 0.0006 * d * d);
  vec3 base = vec3(0.045, 0.085, 0.066) * (0.75 + 0.45 * g);
  // the sheet's shadow: follow this point toward the lamp into the sheet
  vec3 lo = (uNoteInv * vec4(vW, 1.0)).xyz, ld = normalize((uNoteInv * vec4(L, 0.0)).xyz);
  float t = -lo.z / ld.z;
  vec2 hit = (lo + ld * t).xy / uNoteSize + 0.5;
  float soft = 0.015 + 0.03 * clamp(t / 30.0, 0.0, 2.0);
  float inside = smoothstep(-soft, soft, min(min(hit.x, 1.0 - hit.x), min(hit.y, 1.0 - hit.y)));
  float shadow = 1.0 - 0.82 * inside * step(0.0, t);
  vec3 H = normalize(L + normalize(uEye - vW));
  float spec = pow(max(dot(N, H), 0.0), 24.0) * 0.12;
  vec3 col = base * (0.12 + 1.5 * max(dot(N, L), 0.0) * pool * shadow) * uLampCol + spec * pool * shadow * uLampCol;
  if(uMode == 3) col *= vec3(0.3, 0.2, 0.75) * 0.6;
  if(uMode == 2) col *= 0.3;
  o = vec4(col * smoothstep(300.0, 70.0, length(vW.xz)), 1.0);
}`;

// ── post ─────────────────────────────────────────────────────────────────────
export const BRIGHT_FS = HEAD + `
in vec2 vUv; uniform sampler2D uSrc; uniform float uThresh; out vec4 o;
void main(){ vec3 c = texture(uSrc, vUv).rgb; float l = max(max(c.r, c.g), c.b);
  o = vec4(c * smoothstep(uThresh, uThresh * 1.8, l), 1.0); }`;
export const BLUR_FS = HEAD + `
in vec2 vUv; uniform sampler2D uSrc; uniform vec2 uDir; out vec4 o;
void main(){
  vec3 s = texture(uSrc, vUv).rgb * 0.227;
  s += (texture(uSrc, vUv + uDir * 1.385).rgb + texture(uSrc, vUv - uDir * 1.385).rgb) * 0.316;
  s += (texture(uSrc, vUv + uDir * 3.231).rgb + texture(uSrc, vUv - uDir * 3.231).rgb) * 0.070;
  o = vec4(s, 1.0);
}`;
export const COMPOSE_FS = HEAD + `
in vec2 vUv;
uniform sampler2D uScene, uBloom0, uBloom1, uBloom2, uLoupe;
uniform vec2 uRes, uMouse;   // mouse in drawing-buffer pixels, bottom-left origin
uniform float uLoupeOn, uLoupeR, uTime, uExposure;
out vec4 o;
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec3 c = texture(uScene, vUv).rgb;
  c += texture(uBloom0, vUv).rgb * 0.3 + texture(uBloom1, vUv).rgb * 0.28 + texture(uBloom2, vUv).rgb * 0.24;
  vec2 d = gl_FragCoord.xy - uMouse;
  float r = length(d) / uLoupeR;
  if(uLoupeOn > 0.5 && r < 1.1){
    vec2 lu = d / uLoupeR;
    vec2 st = lu * (1.0 + 0.1 * dot(lu, lu)) * 0.5 + 0.5;
    vec3 lc = vec3(texture(uLoupe, st + lu * 0.004).r, texture(uLoupe, st).g, texture(uLoupe, st - lu * 0.004).b);
    float rim = smoothstep(0.945, 0.965, r) * smoothstep(1.06, 1.035, r);
    float bevel = sin((r - 0.945) / 0.115 * 3.14159);
    float sheen = pow(max(dot(normalize(lu + 1e-4), normalize(vec2(-0.6, 0.8))), 0.0), 3.0);
    vec3 brass = vec3(0.42, 0.31, 0.16) * (0.35 + 0.9 * sheen * bevel + 0.25 * bevel);
    c = mix(lc, c, smoothstep(0.935, 0.945, r));
    c = mix(c, brass, rim);
    c += vec3(0.16) * pow(max(1.0 - length(lu - vec2(-0.35, 0.45)) * 2.4, 0.0), 3.0) * step(r, 0.94);
  }
  c = aces(c * uExposure);
  c = pow(c, vec3(1.0 / 2.2));
  vec2 q = vUv - 0.5;
  c *= 1.0 - 0.55 * dot(q, q);
  c += (hash(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) * 0.016;
  o = vec4(c, 1.0);
}`;
