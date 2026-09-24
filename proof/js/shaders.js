/* GLSL for the Proof page. Compiled twice over: as it is (the cream
 * certificate) or with NIGHT defined (the star atlas plate: dark stock,
 * silver and gold inks, an observatory under the night sky).
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
#ifdef NIGHT
  // on dark stock the ink is light: the lines gather where the light falls, as in
  // a moonlit plate, and thin out into the shadow
  float tone = clamp(pow(clamp(light, 0.0, 1.2), 1.1) * 0.9 - 0.03, 0.0, 0.8) * mix(1.0, 0.5, far);
#else
  float tone = clamp(pow(clamp(1.0 - light, 0.0, 1.0), 0.8) * 1.08 + 0.1, 0.0, 1.0) * mix(1.0, 0.55, far);
#endif

  // two families that follow the form, a third for the deepest shade
  float p1, p2;
  if(part < 35){ p1 = vAtt.y * 48.0; p2 = vW.y * 2.2; }           // flutes, then rings
  else if(part == 36){ p1 = vAtt.y * 140.0; p2 = vAtt.z * 2.4; }  // meridians, then latitudes
  else if(part == 40){ p1 = vW.z * 1.4; p2 = vW.x * 1.4; }        // the ground
#ifdef NIGHT
  else if(part == 39){ p1 = vAtt.z * 2.6; p2 = vAtt.y * 70.0; }   // the telescope: rings along it, lines down it
#endif
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
#ifdef NIGHT
// Stars, one chance per cell of a grid of 'cells' across the sky; the brightest
// carry engraved rays, so neighbouring cells are looked at too
float stars(vec2 sp, float cells, float seed, float density, float size, float pxs){
  vec2 c0 = floor(sp * cells);
  float s = 0.0;
  for(int dy = -1; dy <= 1; dy++) for(int dx = -1; dx <= 1; dx++){
    vec2 c = c0 + vec2(dx, dy);
    if(hash(c + seed) < 1.0 - density) continue;
    vec2 at = (c + 0.15 + 0.7 * vec2(hash(c + seed + 3.1), hash(c + seed + 7.7))) / cells;
    float m = pow(hash(c + seed + 1.3), 2.2);
    float r = max(size * (0.4 + 1.2 * m), pxs * 0.8);
    vec2 d = sp - at;
    float disc = 1.0 - smoothstep(r - pxs, r + pxs, length(d));
    float rays = 0.0;
    if(m > 0.5 && size > 0.002){
      float L = r * 5.0, t = pxs * 0.9 + r * 0.1;
      rays = max((1.0 - smoothstep(0.0, t, abs(d.y))) * (1.0 - smoothstep(L * 0.25, L, abs(d.x))),
                 (1.0 - smoothstep(0.0, t, abs(d.x))) * (1.0 - smoothstep(L * 0.25, L, abs(d.y))));
    }
    s = max(s, max(disc, rays * 0.9));
  }
  return s;
}
float seg(vec2 p, vec2 a, vec2 b){
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
// The Plough (Ursa Major) and Cassiopeia, in sky units, as a star atlas would set them
const vec2 UMA[7] = vec2[7](vec2(1.02, 0.86), vec2(1.1, 0.83), vec2(1.17, 0.8), vec2(1.24, 0.79),
                            vec2(1.25, 0.72), vec2(1.34, 0.7), vec2(1.34, 0.78));
const vec2 CAS[5] = vec2[5](vec2(0.1, 0.8), vec2(0.17, 0.87), vec2(0.23, 0.81), vec2(0.29, 0.9), vec2(0.36, 0.84));
float constellations(vec2 sp, float pxs){
  float w = max(0.0007, pxs * 0.7), s = 0.0, dst = 1e9;
  for(int i = 0; i < 6; i++) dst = min(dst, seg(sp, UMA[i], UMA[i + 1]));
  dst = min(dst, seg(sp, UMA[3], UMA[6]));
  for(int i = 0; i < 4; i++) dst = min(dst, seg(sp, CAS[i], CAS[i + 1]));
  s = (1.0 - smoothstep(w - pxs, w + pxs, dst)) * 0.7;
  for(int i = 0; i < 7; i++) s = max(s, 1.0 - smoothstep(0.0048 - pxs, 0.0048 + pxs, length(sp - UMA[i])));
  for(int i = 0; i < 5; i++) s = max(s, 1.0 - smoothstep(0.0044 - pxs, 0.0044 + pxs, length(sp - CAS[i])));
  return s;
}
#endif
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
#ifdef NIGHT
    // the night sky, engraved in light ink on the dark stock and fixed to the paper
    float asp = uRes.x / uRes.y;
    vec2 sp = vec2(fv.x * asp, fv.y);                            // square sky units
    float pxs = (uCrop.w - uCrop.y) / uRes.y;                    // one target pixel, in sky units
    float y = fv.y;
    float above = smoothstep(0.2, 0.3, y);                       // stars only above the horizon
    float sky = 0.0;
    sky = max(sky, stars(sp, 170.0, 1.0, 0.30, 0.0011, pxs));    // the faint crowd
    sky = max(sky, stars(sp, 64.0, 9.0, 0.42, 0.0021, pxs));     // the middle
    sky = max(sky, stars(sp, 19.0, 23.0, 0.55, 0.0036, pxs));    // the bright few, with rays
    sky *= above;
    // the Milky Way: a stippled band across the sky, thickening where it is densest
    vec2 dir = normalize(vec2(1.0, 0.55));
    float across = dot(sp - vec2(0.55, 0.5), vec2(-dir.y, dir.x));
    float band = exp(-pow(across / 0.11, 2.0)) * (0.35 + 0.65 * fbm(sp * 7.0)) * above;
    vec2 sc = floor(sp * 520.0);
    vec2 so = (sc + 0.5 + (vec2(hash(sc + 2.0), hash(sc + 5.0)) - 0.5) * 0.7) / 520.0;
    float dotr = max(0.33 / 520.0, pxs * 0.9);
    float stip = (1.0 - smoothstep(dotr - pxs, dotr + pxs, length(sp - so))) * step(1.0 - band * 0.62, hash(sc + 11.0));
    sky = max(sky, stip * 0.85);
    // two constellations, drawn as atlases draw them: fine lines between their stars
    sky = max(sky, constellations(sp, pxs) * above);
    // a glow along the horizon: light rules, fading upward
    float rp = fv.y * uRes.y / ((uCrop.w - uCrop.y) * uSpacing * 1.1);
    float glow = clamp(0.2 - (y - 0.22) * 1.7, 0.0, 0.2) * (0.7 + 0.3 * noise(vec2(fv.x * 7.0, y * 13.0)));
    sky = max(sky, lineAA(rp, glow, fwidth(rp)) * step(0.16, y));
    // the ledger's star, where the telescope points: always there, faint; once the
    // header hashes to what was signed, its rays spread
    vec2 d = (fv - uDomeTop) * vec2(asp, 1.0);
    float ang = atan(d.y, d.x), r = length(d);
    float rays = lineAA(ang * 44.0 / 6.28318, 0.045 + 0.16 * smoothstep(0.2, 0.0, r), 0.06);
    float reach = smoothstep(uGlory * 0.24 + 0.01, uGlory * 0.24 - 0.05, r) * step(0.01, uGlory);
    float core = 1.0 - smoothstep(0.009 - pxs, 0.009 + pxs, r);
    float halo = (1.0 - smoothstep(0.016, 0.02, r)) * smoothstep(0.012, 0.0135, r);
    sky = max(sky * (1.0 - reach * 0.5), max(rays * reach, max(core * (0.55 + 0.45 * uGlory), halo * uGlory)));
    ink = sky;
    relief = ink * 0.6;
#else
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
#endif
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
#ifdef NIGHT
const vec3 STOCK = vec3(0.020, 0.032, 0.068);   // midnight-dyed cotton
const vec3 SILVER = vec3(0.60, 0.63, 0.69);     // the intaglio ink
const vec3 GOLD = vec3(0.86, 0.66, 0.30);       // the serial's
const vec3 CHALK = vec3(0.70, 0.73, 0.78);      // a white pencil: the relay's word
#endif

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
  vec4 plate = back ? texture(uBack, uv) : texture(uPlate, uv);
#ifdef NIGHT
  // a deckled edge: the sheet was torn along a rule, not cut
  vec2 ed = min(uv, 1.0 - uv) * vec2(3600.0, 2400.0);
  float jag = 4.0 + 12.0 * fbm(uv * vec2(90.0, 60.0)) + 5.0 * noise(uv * vec2(700.0, 470.0));
  if(min(ed.x, ed.y) < jag) discard;
  // midnight stock: its cotton fibres paler than the dye, its tone never quite even
  float hair = smoothstep(0.58, 0.82, fbm(uv * vec2(1700.0, 420.0))) * 0.5 + smoothstep(0.62, 0.86, fbm(uv * vec2(380.0, 1500.0) + 3.0)) * 0.35;
  vec3 paper = STOCK * (0.86 + 0.22 * fib) * (0.96 + 0.08 * fbm(uv * 12.0)) + vec3(0.028, 0.036, 0.055) * hair;
  vec3 col = 1.0 - (1.0 - paper) * (1.0 - plate.rgb * 0.92);      // light inks laid over the dark ground
#else
  vec3 paper = RAG * (0.94 + 0.08 * fib) * (0.985 + 0.03 * fbm(uv * 14.0));
  vec3 col = paper * plate.rgb;
#endif

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

  // the serial, the optically variable count, the intaglio, pencil
  float cosv = clamp(dot(Nb, V), 0.0, 1.0);
  float pencil = duv.g;
#ifdef NIGHT
  col = mix(col, GOLD * (0.85 + 0.2 * fib), dyn.g * 0.95);
  vec3 ovi = mix(vec3(0.16, 0.50, 0.72), vec3(0.58, 0.34, 0.86), smoothstep(0.62, 0.97, cosv + 0.1 * sin(uTime * 0.3)));
  col = mix(col, ovi, dyn.b * 0.97);
  col = mix(col, SILVER * (0.82 + 0.25 * fib), ink * 0.96);
  col = mix(col, CHALK * (0.8 + 0.3 * noise(uv * 3000.0)), pencil * 0.8);
#else
  col = mix(col, RED * (0.9 + 0.1 * fib), dyn.g * 0.95);
  vec3 ovi = mix(vec3(0.12, 0.40, 0.33), vec3(0.64, 0.49, 0.12), smoothstep(0.62, 0.97, cosv + 0.1 * sin(uTime * 0.3)));
  col = mix(col, ovi, dyn.b * 0.97);
  col = mix(col, INK * (0.85 + 0.2 * fib), ink * 0.96);
  col = mix(col, GRAPHITE * (0.9 + 0.2 * noise(uv * 3000.0)), pencil * 0.85);
#endif

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
#ifdef NIGHT
  // silver and gold are metal: they take the lamp as a highlight, not as colour
  float metal = clamp(ink + dyn.g, 0.0, 1.0);
  float nh = max(dot(Nb, H), 0.0);
  float spec = pow(nh, 36.0) * (0.012 + 0.32 * ink + 0.42 * dyn.g + 0.1 * pencil) + pow(nh, 240.0) * 0.9 * metal;
  vec3 specCol = mix(uLampCol, uLampCol * GOLD * 1.25, clamp(dyn.g * 1.4, 0.0, 1.0));
  // metallic flakes in the stock, each at its own tilt: they glint as the lamp moves
  vec2 fc = floor(uv * vec2(1500.0, 1000.0));
  vec2 ff = fract(uv * vec2(1500.0, 1000.0)) - 0.5;
  float flake = step(0.9975, hash(fc)) * (1.0 - ink) * smoothstep(0.32, 0.12, length(ff));   // a small round flake, not a whole cell
  vec3 fn = normalize(N + (vec3(hash(fc + 1.7), hash(fc + 5.3), hash(fc + 9.1)) - 0.5) * 0.8);
  float glint = flake * pow(max(dot(fn, H), 0.0), 400.0) * 3.2;
#else
  float spec = pow(max(dot(Nb, H), 0.0), 50.0) * (0.02 + 0.3 * ink + 0.2 * pencil);
#endif
  vec3 lit;
  if(uMode == 2){
    // transmitted light: the lamp is behind the sheet. Ink and foil block it;
    // the watermark is the paper's own thickness.
    float wm = texture(uWater, back ? vec2(1.0 - uv.x, uv.y) : uv).r;
    float formation = 0.8 + 0.35 * fbm(uv * vec2(40.0, 26.0));
    float trans = (1.0 - ink * 0.9) * (1.0 - foil * 0.97) * exp(-1.1 * wm) * formation;
#ifdef NIGHT
    // dyed stock lets less through, and the dye tints it
    // dyed stock passes little of the lamp, and that little comes through blue
    lit = vec3(0.14, 0.24, 0.62) * trans * (1.0 - 0.35 * max(plate.r, max(plate.g, plate.b)));
#else
    lit = vec3(1.0, 0.92, 0.76) * 1.7 * trans * mix(vec3(1.0), plate.rgb, 0.3);
#endif
  } else if(uMode == 3){
    // ultraviolet: the sheet goes dark; fibres, the trusted key and the names
    // of validators whose signatures were checked fluoresce
    vec3 uvt = back ? vec3(0.0) : texture(uUvt, uv).rgb;
    vec3 base = vec3(0.035, 0.022, 0.085) * (0.8 + 0.3 * fib) * (1.0 - ink * 0.7);
    lit = base + uvt * 0.9 + duv.r * vec3(0.62, 1.0, 0.3) * 1.25 + dyn.b * vec3(0.2, 0.7, 0.55) * 0.18;
  } else {
#ifdef NIGHT
    vec3 amb = mix(vec3(0.05, 0.06, 0.08), vec3(0.11, 0.12, 0.14), N.y * 0.5 + 0.5);
    lit = col * (amb + uLampCol * lamb * att * (1.0 - 0.5 * metal)) + specCol * spec * att
        + uLampCol * glint * att * vec3(0.95, 0.9, 0.8);
    lit = mix(lit, foilCol * (0.35 + uLampCol * 0.65 * att), foil);
#else
    vec3 amb = mix(vec3(0.08, 0.09, 0.09), vec3(0.15, 0.145, 0.13), N.y * 0.5 + 0.5);
    lit = col * (amb + uLampCol * lamb * att) + uLampCol * spec * att;
    lit = mix(lit, foilCol * (0.35 + uLampCol * 0.65 * att), foil);
#endif
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
// the sheet's shadow on the desk and what lies on it: follow a point toward the lamp into the sheet
const SHEET_SHADOW = `
float sheetShadow(vec3 P, vec3 L){
  vec3 lo = (uNoteInv * vec4(P, 1.0)).xyz, ld = normalize((uNoteInv * vec4(L, 0.0)).xyz);
  float t = -lo.z / ld.z;
  vec2 hit = (lo + ld * t).xy / uNoteSize + 0.5;
  float soft = 0.015 + 0.03 * clamp(t / 30.0, 0.0, 2.0);
  float inside = smoothstep(-soft, soft, min(min(hit.x, 1.0 - hit.x), min(hit.y, 1.0 - hit.y)));
  return 1.0 - 0.82 * inside * step(0.0, t);
}`;

// a lamp's-eye depth map: how much of the lamp reaches P past what was drawn into it
const MAP_SHADOW = `
float mapShadow(highp sampler2D m, mat4 lvp, vec3 P){
  vec4 ls = lvp * vec4(P, 1.0);
  vec3 p = ls.xyz / ls.w * 0.5 + 0.5;
  if(p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  vec2 texel = 1.0 / vec2(textureSize(m, 0));
  float s = 0.0;
  for(int i = -1; i <= 1; i++) for(int j = -1; j <= 1; j++)
    s += (p.z - 0.0012 > texture(m, p.xy + vec2(i, j) * texel * 1.5).r) ? 0.0 : 1.0;
  return s / 9.0;
}`;

// the night desk's gloss: a microfacet highlight (GGX, Smith, Schlick), in the page's lamp units
const GLOSS = `
vec3 gloss(vec3 N, vec3 L, vec3 V, vec3 F0, float rough){
  vec3 H = normalize(L + V);
  float a = max(rough * rough, 0.012), a2 = a * a;
  float nl = max(dot(N, L), 0.0), nv = max(dot(N, V), 1e-3), nh = max(dot(N, H), 0.0), vh = max(dot(V, H), 0.0);
  float dd = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159 * dd * dd);
  float k = a * 0.5;
  float vis = 0.25 / ((nv * (1.0 - k) + k) * (nl * (1.0 - k) + k));
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - vh, 5.0);
  return D * vis * F * nl * 4.71;
}
// the room as polished metal sees it: dark walls and ceiling, faintly warm where the
// lamp's spill reaches them, a glow round the lamp itself, the lit desk below
vec3 room(vec3 R, float rough, vec3 Ld, vec3 lampCol){
  vec3 c = vec3(0.004, 0.005, 0.008) + vec3(0.03, 0.021, 0.012) * smoothstep(0.05, -0.35, R.y);
  c += lampCol * vec3(0.05, 0.04, 0.03) * smoothstep(-0.05, 0.45, R.y);
  c += lampCol * 0.2 * pow(max(dot(R, Ld), 0.0), mix(24.0, 3.0, rough)) * mix(1.0, 0.45, rough);
  return c;
}`;

export const BENCH_FS = HEAD + NOISE + `
in vec3 vW;
uniform vec3 uLamp, uLampCol, uEye;
uniform mat4 uNoteInv;
uniform vec2 uNoteSize;
uniform int uMode;
#ifdef NIGHT
uniform sampler2D uWood, uWoodS, uLeatherS;   // photographed: the wood's colour; its normal (x, y) + roughness; the leather's
uniform float uDeskOn;
uniform highp sampler2D uShadowA, uShadowB;   // the two stands and what they hold, seen from the lamp
uniform mat4 uShadowALVP, uShadowBLVP;
uniform float uPropsOn;
uniform vec4 uPlinth;                          // the astrolabe stand's oval plinth: centre x, z, its turn
uniform vec2 uPlinthR;                         // and its half-length, half-width
uniform vec2 uPads[3];                         // the telescope stand's three pads
` + MAP_SHADOW + `
#endif
` + SHEET_SHADOW + GLOSS + `
out vec4 o;
void main(){
  vec3 L = normalize(uLamp - vW);
  float d = length(uLamp - vW);
  float pool = 1.6 / (1.0 + 0.0006 * d * d);
  float shadow = sheetShadow(vW, L);
  vec3 V = normalize(uEye - vW);
#ifdef NIGHT
  // a varnished wooden desk, and on it a navy leather blotter with a gold-tooled border
  vec2 w = vW.xz;
  vec2 q = abs(w - vec2(0.0, 6.0)), hb = vec2(64.0, 46.0);
  float inB = step(q.x, hb.x) * step(q.y, hb.y);
  float edgeD = min(hb.x - q.x, hb.y - q.y);
  vec2 p = w * 0.9;
  float g = noise(p * 3.0) * 0.6 + noise(p * 9.0) * 0.3 + noise(p * 27.0) * 0.1;
  vec3 wood, Nw, leather, Nl;
  float wr, lr;
  if(uDeskOn > 0.5){
    // photographed wood, 1.5 m square, its grain run along the desk
    vec2 wuv = vec2(w.y, w.x) / 300.0 + vec2(0.31, 0.17);
    wood = pow(texture(uWood, wuv).rgb, vec3(2.2)) * 0.62;
    vec3 ws = texture(uWoodS, wuv).rgb;
    vec2 wn = ws.rg * 2.0 - 1.0;
    Nw = normalize(vec3(-wn.y, sqrt(max(0.0, 1.0 - dot(wn, wn))), wn.x));
    wr = mix(0.2, 0.42, ws.b);
    // photographed leather, 30 cm square, dyed navy
    vec2 luv = w / 60.0;
    vec3 ls = texture(uLeatherS, luv).rgb;
    vec2 ln = (ls.rg * 2.0 - 1.0) * 1.3;
    Nl = normalize(vec3(ln.x, sqrt(max(0.0, 1.0 - dot(ln, ln))), -ln.y));
    lr = mix(0.38, 0.72, ls.b);
    leather = vec3(0.020, 0.031, 0.074) * (0.72 + 0.36 * (1.0 - ls.b) + 0.27 * (g - 0.5));
  } else {
    float gr = fbm(vec2(w.x * 0.05, w.y * 1.6)) * 0.6 + fbm(vec2(w.x * 0.4, w.y * 7.0)) * 0.4;
    float ring = sin((w.y + fbm(w * 0.03) * 18.0) * 1.9) * 0.5 + 0.5;
    wood = mix(vec3(0.05, 0.028, 0.016), vec3(0.12, 0.07, 0.038), gr * 0.7 + ring * 0.3);
    Nw = normalize(vec3((fbm(vec2(w.x * 0.4, w.y * 7.0) + 2.0) - 0.5) * 0.12, 1.0, (gr - 0.5) * 0.3));
    leather = vec3(0.022, 0.034, 0.078) * (0.72 + 0.55 * g);
    Nl = normalize(vec3((noise(p * 9.0 + 3.1) - 0.5) * 0.35, 1.0, (noise(p * 9.0 + 7.7) - 0.5) * 0.35));
    wr = 0.34; lr = 0.6;
  }
  float tool = inB * (smoothstep(0.24, 0.0, abs(edgeD - 2.4)) + 0.8 * smoothstep(0.13, 0.0, abs(edgeD - 3.1)));
  vec3 base = mix(wood, leather, inB);
  base *= mix(1.0, 0.55, inB * smoothstep(0.6, 0.0, edgeD));      // the blotter's edge, turned down
  base = mix(base, vec3(0.62, 0.46, 0.2), tool);
  vec3 N = inB > 0.5 ? Nl : Nw;
  float rough = mix(mix(wr, lr, inB), 0.3, tool);
  // what stands on the desk: the two stands' shadows from the lamp, and the dark close
  // round the plinth and under the claw's pads, where the desk sees less of the room
  float lit = shadow;
  float occ = 1.0;
  if(uPropsOn > 0.5){
    lit *= mapShadow(uShadowA, uShadowALVP, vW) * mapShadow(uShadowB, uShadowBLVP, vW);
    vec2 pd = vW.xz - uPlinth.xy;
    float pc = cos(uPlinth.z), ps = sin(uPlinth.z);
    float pe = length(vec2(pc * pd.x - ps * pd.y, ps * pd.x + pc * pd.y) / uPlinthR);   // 1 at the plinth's edge
    occ *= 1.0 - 0.55 * smoothstep(1.2, 0.97, pe);
    for(int i = 0; i < 3; i++) occ *= 1.0 - 0.5 * smoothstep(1.7, 0.3, length(vW.xz - uPads[i]));
  }
  vec3 F0 = mix(vec3(0.04), vec3(0.62, 0.46, 0.2), tool);
  // (the shadows keep a little fill light for the diffuse; a highlight is the lamp's own
  // image, and whatever stands in the way hides it outright)
  // (held to the light, the lamp is a lightbox behind the paper: no image of it on the desk)
  vec3 col = base * (0.12 * occ + 1.5 * max(dot(N, L), 0.0) * pool * lit) * uLampCol
           + gloss(N, L, V, F0, rough) * pool * lit * lit * lit * uLampCol * (uMode == 2 ? 0.0 : 1.0)
           + F0 * room(reflect(-V, N), rough, L, uLampCol) * occ;
#else
  // green leather: a pebbled grain in a pool of lamplight
  vec2 p = vW.xz * 0.9;
  float g = noise(p * 3.0) * 0.6 + noise(p * 9.0) * 0.3 + noise(p * 27.0) * 0.1;
  vec3 N = normalize(vec3((noise(p * 9.0 + 3.1) - 0.5) * 0.35, 1.0, (noise(p * 9.0 + 7.7) - 0.5) * 0.35));
  vec3 base = vec3(0.045, 0.085, 0.066) * (0.75 + 0.45 * g);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 24.0) * 0.12;
  vec3 col = base * (0.12 + 1.5 * max(dot(N, L), 0.0) * pool * shadow) * uLampCol + spec * pool * shadow * uLampCol;
#endif
  if(uMode == 3) col *= vec3(0.3, 0.2, 0.75) * 0.6;
  if(uMode == 2) col *= 0.3;
#ifdef NIGHT
  // the desk runs back into the dark of the room (the colour the room is cleared to)
  o = vec4(mix(vec3(0.0016, 0.003, 0.009), col, smoothstep(300.0, 70.0, length(vW.xz))), 1.0);
#else
  o = vec4(col * smoothstep(300.0, 70.0, length(vW.xz)), 1.0);
#endif
}`;

// ── the spyglass on the night desk: turned brass and leather ─────────────────
export const SPY_VS = HEAD + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUv;      // round the tube (0..1), along it (world units)
layout(location=3) in float aPart;
uniform mat4 uVP, uModel;
out vec3 vW, vN, vM, vMN;
out vec2 vUv;
flat out int vPart;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz; vN = mat3(uModel) * aNrm; vM = aPos; vMN = aNrm; vUv = aUv;
  vPart = int(aPart + 0.5);
  gl_Position = uVP * w;
}`;
export const SPY_FS = HEAD + NOISE + `
in vec3 vW, vN, vM, vMN;
in vec2 vUv;
flat in int vPart;
uniform sampler2D uLeatherS;
uniform highp sampler2D uShadow;
uniform mat4 uShadowLVP;
uniform float uLeatherOn, uRadius;
uniform mat4 uModel, uNoteInv;
uniform vec2 uNoteSize;
uniform vec3 uLamp, uLampCol, uEye;
uniform int uMode;
out vec4 o;
` + SHEET_SHADOW + GLOSS + MAP_SHADOW + `
void main(){
  vec3 N = normalize(vN);
  mat3 R = mat3(uModel);
  vec3 axis = normalize(R * vec3(1.0, 0.0, 0.0));
  vec3 radial = normalize(R * vec3(0.0, vM.y - uRadius + 1e-4, vM.z));
  vec3 around = normalize(cross(axis, radial));
  float side = 1.0 - abs(dot(N, axis));             // 1 on the tube, 0 on the rings' faces
  // brass, tarnished unevenly along and round the tube
  float t = noise(vec2(vUv.y * 0.3, vUv.x * 5.0)) * 0.6 + noise(vec2(vUv.y * 1.6, vUv.x * 21.0)) * 0.4;
  vec3 alb = mix(vec3(0.80, 0.60, 0.28), vec3(0.46, 0.31, 0.12), smoothstep(0.32, 0.78, t));
  float metal = 1.0, rough = mix(0.16, 0.34, t);
  if(vPart == 1){
    // ribbed for the fingers: the ribs fade out before they are finer than a pixel
    float f = vUv.x * 48.0, fw = fwidth(f);
    N = normalize(N + around * sin(f * 6.28318) * 0.32 * side * smoothstep(0.45, 0.2, fw));
    rough += 0.06;
  } else if(vPart == 2){                              // leather, dark brown, the desk's own grain
    vec3 ls = uLeatherOn > 0.5 ? texture(uLeatherS, vec2(vUv.x * 12.75, vUv.y) / 60.0).rgb : vec3(0.5, 0.5, 0.55);
    vec2 ln = (ls.rg * 2.0 - 1.0) * 1.4;
    N = normalize(N * sqrt(max(0.0, 1.0 - dot(ln, ln))) + around * ln.x - axis * ln.y);
    alb = vec3(0.03, 0.017, 0.011) * (0.75 + 0.5 * (1.0 - ls.b));
    metal = 0.0; rough = mix(0.38, 0.72, ls.b);
  } else if(vPart == 3){                              // the object glass
    alb = vec3(0.003, 0.003, 0.005); metal = 0.0; rough = 0.05;
  } else {                                            // blackened inside
    alb = vec3(0.01); metal = 0.0; rough = 0.6;
  }
  vec3 L = normalize(uLamp - vW);
  float d = length(uLamp - vW);
  float pool = 1.6 / (1.0 + 0.0006 * d * d);
  vec3 V = normalize(uEye - vW);
  float lit = sheetShadow(vW, L) * mapShadow(uShadow, uShadowLVP, vW + normalize(vN) * 0.05);
  vec3 F0 = mix(vec3(0.04), alb, metal);
  if(vPart == 3) F0 = vec3(0.035, 0.022, 0.06);       // a bloomed lens reflects violet
  float nv = max(dot(N, V), 0.0);
  vec3 Fr = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(1.0 - nv, 5.0);
  vec3 col = (gloss(N, L, V, F0, rough) * lit * lit + alb * (1.5 - 1.2 * metal) * max(dot(N, L), 0.0)) * pool * lit * uLampCol
           + Fr * room(reflect(-V, N), rough, L, uLampCol)
           + alb * (1.0 - metal) * 0.12 * uLampCol;
  if(uMode == 3) col *= vec3(0.3, 0.2, 0.75) * 0.6;
  if(uMode == 2) col *= 0.3;
  o = vec4(mix(vec3(0.0016, 0.003, 0.009), col, smoothstep(300.0, 70.0, length(vW.xz))), 1.0);
}`;

// ── the stands: turned brass, a chain, a plinth of French-polished mahogany ───
export const PROP_FS = HEAD + NOISE + `
in vec3 vW, vN, vM, vMN;
in vec2 vUv;
flat in int vPart;
uniform sampler2D uWood;
uniform highp sampler2D uShadow;
uniform mat4 uShadowLVP, uNoteInv;
uniform float uWoodOn;
uniform vec2 uNoteSize;
uniform vec3 uLamp, uLampCol, uEye;
uniform int uMode;
out vec4 o;
` + SHEET_SHADOW + GLOSS + MAP_SHADOW + `
void main(){
  vec3 N = normalize(vN);
  // brass, kept polished: a faint warmth of tarnish drifting over it
  float t = noise(vM.xz * 0.33 + vM.y * 0.21) * 0.6 + noise(vM.xy * 1.4 + vM.z * 0.9) * 0.4;
  vec3 alb = mix(vec3(0.84, 0.64, 0.30), vec3(0.58, 0.40, 0.16), smoothstep(0.4, 0.85, t));
  float metal = 1.0, rough = mix(0.2, 0.32, t);
  if(vPart == 1) rough += 0.08;                       // milled
  if(vPart == 6){ alb *= 0.9; rough = mix(0.26, 0.38, t); }  // the chain: handled, a little duller
  if(vPart == 5){
    // mahogany: the desk's own photographed grain, run the way a turner's would, darker
    // and redder, under a French polish that holds a sharp image of the lamp
    vec3 w = abs(normalize(vMN)); w /= w.x + w.y + w.z;
    vec3 g = uWoodOn > 0.5
      ? texture(uWood, vM.zy / 90.0 + 0.21).rgb * w.x + texture(uWood, vM.xz / 90.0 + 0.53).rgb * w.y + texture(uWood, vM.xy / 90.0 + 0.77).rgb * w.z
      : vec3(0.45, 0.25, 0.16);
    alb = pow(g, vec3(2.2)) * vec3(0.72, 0.42, 0.34);
    metal = 0.0; rough = 0.1;
  }
  vec3 L = normalize(uLamp - vW);
  float d = length(uLamp - vW);
  float pool = 1.6 / (1.0 + 0.0006 * d * d);
  vec3 V = normalize(uEye - vW);
  float lit = sheetShadow(vW, L) * mapShadow(uShadow, uShadowLVP, vW + N * 0.05);
  vec3 F0 = mix(vec3(0.04), alb, metal);
  float nv = max(dot(N, V), 0.0);
  vec3 Fr = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(1.0 - nv, 5.0);
  vec3 col = (gloss(N, L, V, F0, rough) * lit * lit + alb * (1.5 - 1.2 * metal) * max(dot(N, L), 0.0)) * pool * lit * uLampCol
           + Fr * room(reflect(-V, N), rough, L, uLampCol)
           + alb * (1.0 - metal) * 0.12 * uLampCol;
  if(uMode == 3) col *= vec3(0.3, 0.2, 0.75) * 0.6;
  if(uMode == 2) col *= 0.3;
  o = vec4(mix(vec3(0.0016, 0.003, 0.009), col, smoothstep(300.0, 70.0, length(vW.xz))), 1.0);
}`;

// ── the astrolabe on the night desk: brass, in 3D ────────────────────────────
// Its mesh is light (the parts' outlines, extruded); its top faces wear maps rendered
// top-down from the detailed model: colour, and the normal and roughness of every
// engraved line, bevel, scratch and patch of tarnish.
export const ASTRO_VS = HEAD + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
uniform mat4 uVP, uModel;
out vec3 vW, vN, vMN;
out vec2 vUv;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz; vN = mat3(uModel) * aNrm; vMN = aNrm;
  vUv = aPos.xz / 48.0 + 0.5;
  gl_Position = uVP * w;
}`;
export const ASTRO_FS = HEAD + `
in vec3 vW, vN, vMN;
in vec2 vUv;
uniform sampler2D uAstroA, uAstroS;
uniform highp sampler2D uAstroShadow;
uniform mat4 uAstroLVP, uModel, uNoteInv;
uniform vec2 uNoteSize;
uniform vec3 uLamp, uLampCol, uEye;
uniform int uMode;
out vec4 o;
` + SHEET_SHADOW + GLOSS + MAP_SHADOW + `
void main(){
  vec3 gN = normalize(vN);
  vec4 A = texture(uAstroA, vUv);
  vec3 S = texture(uAstroS, vUv).rgb;
  vec2 nxy = S.rg * 2.0 - 1.0;
  vec3 tN = normalize(mat3(uModel) * vec3(nxy.x, sqrt(max(0.0, 1.0 - dot(nxy, nxy))), -nxy.y));
  float top = smoothstep(0.55, 0.9, normalize(vMN).y);   // the maps hold what faces out of its face
  vec3 N = normalize(mix(gN, tN, top));
  // a wall has no view from above: it takes the brass round about it (a coarse level of the
  // map, over its coverage), not the rim's last texels drawn down its face
  vec4 Am = textureLod(uAstroA, vUv, 4.0);
  vec3 alb = pow(mix(Am.rgb / max(Am.a, 0.05), A.rgb, top), vec3(2.2));
  float metal = smoothstep(0.02, 0.05, dot(alb, vec3(0.3, 0.59, 0.11)));   // brass, or the black filling its lines
  float rough = mix(0.4, S.b, top);
  vec3 L = normalize(uLamp - vW);
  float d = length(uLamp - vW);
  float pool = 1.6 / (1.0 + 0.0006 * d * d);
  vec3 V = normalize(uEye - vW);
  float lit = sheetShadow(vW, L) * mapShadow(uAstroShadow, uAstroLVP, vW + gN * 0.06);
  vec3 F0 = mix(vec3(0.04), alb, metal);
  float nv = max(dot(N, V), 0.0);
  vec3 Fr = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(1.0 - nv, 5.0);
  // old brass is not a mirror: its tarnish scatters a little of the lamp's light every way
  vec3 col = (gloss(N, L, V, F0, rough) * lit * lit + alb * (1.5 - 1.2 * metal) * max(dot(N, L), 0.0)) * pool * lit * uLampCol
           + Fr * room(reflect(-V, N), rough, L, uLampCol)
           + alb * (1.0 - metal) * 0.12 * uLampCol;
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
