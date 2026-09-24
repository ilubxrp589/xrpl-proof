/* The renderer. One frame is:
 *   1. shadow   the temple's depth as seen from the lamp
 *   2. temple   the temple engraved into a G-buffer: line ink, part, depth
 *   3. engrave  contours, sky, glory and each part's ink state → vignette
 *   4. scene    the bench and the sheet, lit by the lamp, into HDR
 *   5. loupe    the same scene through a cropped frustum, when it is out
 *   6. post     bloom, tone map, grain, the loupe's glass
 */
import { program, uniforms, texture, canvasTexture, target, bindTarget, mesh, grid, M, V } from './gl.js';
import * as S from './shaders.js';
import { buildTholos, PART, N_COLS, scopeDir } from './tholos.js';
import { W, H, L } from './note.js';
import { spyglass, SPYGLASS } from './props.js';

const SHEET = [60, 40];                 // world size of the sheet, 3 : 2
const NOTE_POS = [0, 25, 0];
const TILT = -0.22;                     // leaning back, as on a reading stand
const BASE_AT = [0, 21.6, 0];           // where the whole-sheet view looks

export class Renderer {
  /** night: the star atlas plate (dark stock, silver ink, the observatory), compiled in with NIGHT */
  constructor(cv, { night = false } = {}) {
    this.cv = cv; this.night = night;
    const gl = this.gl = cv.getContext('webgl2', { antialias: false, alpha: false, depth: true,
                                                  powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('This page needs WebGL 2.');
    // every target here is half float: either extension makes it renderable
    // (some phones only have the half-float one)
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float'))
      throw new Error('This page needs float render targets (EXT_color_buffer_float).');
    gl.getExtension('OES_texture_float_linear');
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');

    const def = src => (night ? src.replace('#version 300 es\n', '#version 300 es\n#define NIGHT 1\n') : src);
    const P = (vs, fs, name) => program(gl, def(vs), def(fs), name);
    this.pShadow = P(S.SHADOW_VS, S.SHADOW_FS, 'shadow');
    this.pTemple = P(S.TEMPLE_VS, S.TEMPLE_FS, 'temple');
    this.pEngrave = P(S.FULL_VS, S.ENGRAVE_FS, 'engrave');
    this.pNote = P(S.NOTE_VS, S.NOTE_FS, 'note');
    this.pBench = P(S.BENCH_VS, S.BENCH_FS, 'bench');
    this.pBright = P(S.FULL_VS, S.BRIGHT_FS, 'bright');
    this.pBlur = P(S.FULL_VS, S.BLUR_FS, 'blur');
    this.pCompose = P(S.FULL_VS, S.COMPOSE_FS, 'compose');
    if (night) {
      this.pAstro = P(S.ASTRO_VS, S.ASTRO_FS, 'astro');
      this.pSpy = P(S.SPY_VS, S.SPY_FS, 'spyglass');
      const sp = spyglass();
      this.spy = mesh(gl, [[sp.pos, 3], [sp.nrm, 3], [sp.uv, 2], [sp.part, 1]], sp.idx);
    }
    this.emptyVao = gl.createVertexArray();

    // the temple
    const t = buildTholos({ night });
    this.temple = mesh(gl, [[t.pos, 3], [t.nrm, 3], [t.att, 4]], t.idx);
    this.templeBounds = t.bounds;
    const ys = new Float32Array(41 * 2).fill(0);
    const lo = new Array(41).fill(1e9), hi = new Array(41).fill(-1e9);
    for (let i = 0; i < t.att.length; i += 4) {
      const p = t.att[i] | 0, y = t.pos[(i / 4) * 3 + 1];
      if (y < lo[p]) lo[p] = y;
      if (y > hi[p]) hi[p] = y;
    }
    for (let p = 0; p < 41; p++) { ys[p * 2] = lo[p] < 1e8 ? lo[p] : 0; ys[p * 2 + 1] = hi[p] > -1e8 ? hi[p] : 1; }
    this.partY = ys;

    const g = grid(180, 120);
    this.sheet = mesh(gl, [[g.uv, 2]], g.idx);
    const b = grid(1, 1);
    this.bench = mesh(gl, [[b.uv, 2]], b.idx);

    // fixed-size targets. A phone's screen never shows the vignette wider than
    // about 1200 device pixels, even zoomed, so it engraves at that size
    const phone = this.phone = Math.min(screen.width, screen.height) < 600;
    this.shadow = this.depthTarget(phone ? 1024 : 2048);
    this.VW = phone ? 1200 : 1600; this.VH = phone ? 825 : 1100;
    this.gbuf = target(gl, this.VW, this.VH, [
      { internal: gl.RGBA16F, type: gl.HALF_FLOAT, format: gl.RGBA, filter: gl.NEAREST },
      { internal: gl.RGBA16F, type: gl.HALF_FLOAT, format: gl.RGBA, filter: gl.NEAREST }], true);
    this.vig = target(gl, this.VW, this.VH, [{ internal: gl.RGBA8, filter: gl.LINEAR }]);
    this.loupeSize = 640;
    this.loupe = target(gl, this.loupeSize, this.loupeSize, [{ internal: gl.RGBA16F, type: gl.HALF_FLOAT, format: gl.RGBA }], true);
    this.resize();
  }

  /** The night desk: photographed wood and leather, and a brass astrolabe, modelled in
   *  Blender. Its mesh is light; its top faces wear maps rendered from the detailed model
   *  (colour, with its outline in alpha; normal x, y and roughness). Each piece is drawn
   *  once it has arrived; until then the desk is procedural and bare. */
  loadDesk() {
    const gl = this.gl;
    const url = name => new URL(`../assets/desk/${name}`, import.meta.url).href;
    const image = name => {
      const im = new Image();
      im.src = url(name);
      return im.decode().then(() => im);       // decoded off the main thread, before the upload
    };
    const tex = (im, { data = false } = {}) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      // normal and roughness maps are numbers, not colours: no colour management on the way in
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, data ? gl.NONE : gl.BROWSER_DEFAULT_WEBGL);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      gl.generateMipmap(gl.TEXTURE_2D);
      return t;
    };
    Promise.all([image('wood.jpg'), image('wood-surface.jpg'), image('leather-surface.jpg')]).then(([w, ws, ls]) => {
      this.desk = { wood: tex(w), woodS: tex(ws, { data: true }), leatherS: tex(ls, { data: true }) };
    }).catch(() => { /* the procedural desk stays */ });
    if (this.phone) return;                 // the astrolabe lies outside a phone's frame
    Promise.all([fetch(url('astrolabe.bin')).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(r.status))),
                 image('astrolabe.webp'), image('astrolabe-surface.jpg')]).then(([buf, a, sf]) => {
      // ASTR, vertex count, index count, position scale; int16 positions and normals
      // (Blender's axes, z up, in blender units), then the indices
      const h = new Uint32Array(buf, 4, 3), n = h[0], ni = h[1], k = h[2];
      if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'ASTR') throw new Error('not an astrolabe');
      const ip = new Int16Array(buf, 16, n * 3), inr = new Int16Array(buf, 16 + n * 6, n * 3);
      const idx = n < 65536 ? new Uint16Array(buf, 16 + n * 12, ni) : new Uint32Array(buf.slice(16 + n * 12), 0, ni);
      // to the desk: 16 world units to the blender unit, y up, the maps' centre (0, 0.4) at the
      // origin, and a little thinner than modelled (the normals follow the squash)
      const T = 0.75, pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const x = ip[i * 3] / k, y = ip[i * 3 + 1] / k, z = ip[i * 3 + 2] / k;
        pos[i * 3] = x * 16; pos[i * 3 + 1] = z * 16 * T; pos[i * 3 + 2] = -(y - 0.4) * 16;
        const nx = inr[i * 3], ny = inr[i * 3 + 2] / T, nz = -inr[i * 3 + 1], l = Math.hypot(nx, ny, nz) || 1;
        nrm[i * 3] = nx / l; nrm[i * 3 + 1] = ny / l; nrm[i * 3 + 2] = nz / l;
      }
      const ta = tex(a), ts = tex(sf, { data: true });
      for (const t of [ta, ts]) {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      this.astro = { mesh: mesh(gl, [[pos, 3], [nrm, 3]], idx), a: ta, s: ts, shadow: this.depthTarget(1024) };
    }).catch(() => { /* a bare desk */ });
  }

  /** At night the desk holds solid things (the astrolabe's rims, rule and ring), whose
   *  edges would stair-step: the scene is drawn multisampled, then resolved. Large
   *  drawing buffers (high-density screens, already finer than the eye) take fewer
   *  samples or none. */
  multisample(w, h) {
    const gl = this.gl;
    const max = (gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES) || [0])[0] || 0;
    const n = Math.min(max, w * h <= 2.6e6 ? 4 : w * h <= 5e6 ? 2 : 0);
    if (n < 2) return null;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const rb = [[gl.RGBA16F, gl.COLOR_ATTACHMENT0], [gl.DEPTH_COMPONENT24, gl.DEPTH_ATTACHMENT]].map(([f, at]) => {
      const r = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, r);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, n, f, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, at, gl.RENDERBUFFER, r);
      return r;
    });
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const free = () => { gl.deleteFramebuffer(fb); rb.forEach(r => gl.deleteRenderbuffer(r)); };
    if (!ok) { free(); return null; }
    return { fb, w, h, samples: n, free };
  }

  depthTarget(n) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, n, n, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
                          [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w: n, h: n };
  }

  /** Static sheet layers (ImageData / canvases) from note.js. */
  setSheet(st, dyn) {
    const gl = this.gl;
    // the certificate first; the desk's things once it is on the press
    if (this.night && !this.deskAsked) { this.deskAsked = true; this.loadDesk(); }
    const up = (src, mips = true) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      if (mips) gl.generateMipmap(gl.TEXTURE_2D);
      return t;
    };
    for (const k of ['tPlate', 'tFoil', 'tUv', 'tWater', 'tBack']) if (this[k]) gl.deleteTexture(this[k]);
    this.tPlate = up(st.plate); this.tFoil = up(st.foil); this.tUv = up(st.uv);
    this.tWater = up(st.water); this.tBack = up(st.back);
    // a new trust root rebuilds the sheet: free the old per-ledger layers first
    for (const k of ['tDyn', 'tDynUv', 'tBackDyn']) if (this[k]) gl.deleteTexture(this[k].tex);
    this.dyn = dyn;
    this.tDyn = canvasTexture(gl, dyn.c, { aniso: this.aniso });
    this.tDynUv = canvasTexture(gl, dyn.uv, { aniso: this.aniso });
    this.tBackDyn = canvasTexture(gl, dyn.bk, { aniso: this.aniso });
  }

  /** Push whatever the dynamic layers changed since last frame. */
  flush() {
    const d = this.dyn;
    if (!d) return;
    // upload each changed rectangle on its own, then rebuild the mips once
    const push = (tex, rects) => {
      if (!rects.length) return;
      if (rects.some(r => r[2] >= tex.canvas.width && r[3] >= tex.canvas.height)) tex.update();
      else { rects.forEach(r => tex.update(r, { mip: false })); tex.mip(); }
    };
    push(this.tDyn, d.dirty); d.dirty = [];
    if (d.uvDirty) { this.tDynUv.update(); d.uvDirty = false; }
    push(this.tBackDyn, d.bkRects || []); d.bkRects = [];
    if (d.bkDirty) { this.tBackDyn.update(); d.bkDirty = false; }
  }

  resize() {
    const gl = this.gl, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(this.cv.clientWidth * dpr)), h = Math.max(2, Math.round(this.cv.clientHeight * dpr));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.cv.width = w; this.cv.height = h;
    for (const k of ['scene', 'b0', 'b0b', 'b1', 'b1b', 'b2', 'b2b', 'msaa']) if (this[k]) this[k].free();
    const hf = { internal: gl.RGBA16F, type: gl.HALF_FLOAT, format: gl.RGBA };
    this.scene = target(gl, w, h, [hf], true);
    this.msaa = this.night && !this.phone ? this.multisample(w, h) : null;
    const mk = s => target(gl, Math.max(2, (w / s) | 0), Math.max(2, (h / s) | 0), [hf]);
    this.b0 = mk(2); this.b0b = mk(2); this.b1 = mk(4); this.b1b = mk(4); this.b2 = mk(8); this.b2b = mk(8);
    this.layout();
  }

  /** How the whole-sheet view frames the sheet. In a wide window it sits a
   *  little high, clear of the footer, pulled back on narrower ones. In a
   *  tall one, a phone held upright, it fills the width at the top and the
   *  page's words go underneath: a lens shift moves the picture up, so the
   *  camera, and with it every zoom and pan, still centres on the sheet. */
  layout() {
    const cw = this.w / this.dpr, ch = this.h / this.dpr, aspect = cw / ch;
    const flat = { flip: 0, tiltX: 0, tiltY: 0, lift: 0, zoom: 1, pan: [0, 0, 0] };
    this.stacked = aspect < 1;
    this.fit = Math.max(1, 1.62 / aspect); this.shift = 0;
    if (this.stacked) {
      const top = 62;
      for (let pass = 0; pass < 3; pass++) {
        // the bottom edge, the widest, just inside the screen
        let lo = 0.3, hi = 12;
        for (let k = 0; k < 40; k++) {
          this.fit = (lo + hi) / 2;
          if (this.toScreen(flat, W, H)[0] > cw * 0.985) lo = this.fit; else hi = this.fit;
        }
        // the top edge just under the title
        lo = -1.8; hi = 1.8;
        for (let k = 0; k < 40; k++) {
          this.shift = (lo + hi) / 2;
          if (this.toScreen(flat, W / 2, 0)[1] > top) lo = this.shift; else hi = this.shift;
        }
      }
    }
    this.sheetBottom = this.toScreen(flat, W / 2, H)[1];
    const root = document.documentElement;
    root.style.setProperty('--sheet-bottom', `${Math.round(this.sheetBottom)}px`);
    root.classList.toggle('stacked', this.stacked);
  }

  /** Where the sheet sits, and how it faces. */
  noteModel(st) {
    const flip = st.flip * Math.PI;
    return M.mul(M.translate(...NOTE_POS),
      M.mul(M.rotY(st.tiltY + flip), M.mul(M.rotX(TILT + st.tiltX), M.translate(0, 0, st.lift || 0))));
  }

  /** The whole-sheet view, and the zoomed one: the camera keeps its direction
   *  and moves toward `at` by the zoom factor; `pan` slides `at` over the sheet. */
  camera(st) {
    const aspect = this.w / this.h;
    // pulled back on narrow windows so the whole sheet stays in view (layout())
    const fit = this.fit || Math.max(1, 1.62 / aspect);
    // framed to leave the footer its band: the sheet sits a little high
    const eye0 = [st.camX || 0, 32.5 + (st.camY || 0), 102 * fit];
    const z = st.zoom || 1, pan = st.pan || [0, 0, 0];
    const at = [BASE_AT[0] + pan[0], BASE_AT[1] + pan[1], BASE_AT[2] + pan[2]];
    const eye = [at[0] + (eye0[0] - BASE_AT[0]) / z, at[1] + (eye0[1] - BASE_AT[1]) / z, at[2] + (eye0[2] - BASE_AT[2]) / z];
    const view = M.lookAt(eye, at, [0, 1, 0]);
    let proj = M.perspective(0.56, aspect, 0.5, 800);
    // lens shifts: the stacked layout's, and any the tour asks for (st.lens, in
    // NDC). They slide the picture without moving the camera
    const lens = st.lens || [0, 0], sx = lens[0], sy = (this.shift || 0) + lens[1];
    if (sx || sy) proj = M.crop(proj, -1 - sx, 1 - sx, -1 - sy, 1 - sy);
    return { eye, at, view, proj, vp: M.mul(proj, view) };
  }

  /** Where a pointer position (CSS px) meets the sheet: world point and sheet uv. */
  sheetHit(st, px, py, cam = this.camera(st)) {
    const nm = this.noteModel(st);
    const inv = M.invert(cam.vp);
    const x = px * this.dpr / this.w * 2 - 1, y = 1 - py * this.dpr / this.h * 2;
    const near = M.apply(inv, [x, y, -1]), far = M.apply(inv, [x, y, 1]);
    const ni = M.invert(nm);
    const la = M.apply(ni, near), lb = M.apply(ni, far);
    const t = la[2] / (la[2] - lb[2]);
    const local = [la[0] + (lb[0] - la[0]) * t, la[1] + (lb[1] - la[1]) * t, 0];
    return { t, local, world: M.apply(nm, local), uv: [local[0] / SHEET[0] + 0.5, 0.5 - local[1] / SHEET[1]] };
  }

  /** A point of the sheet, in sheet pixels, placed in the world. */
  sheetPoint(st, x, y) {
    return M.apply(this.noteModel(st), [(x / W - 0.5) * SHEET[0], (0.5 - y / H) * SHEET[1], 0]);
  }

  /** Where a point of the sheet (sheet pixels) lands on screen, in CSS px. */
  toScreen(st, x, y, cam = this.camera(st)) {
    const c = M.apply(cam.vp, this.sheetPoint(st, x, y));
    return [(c[0] * 0.5 + 0.5) * this.w / this.dpr, (0.5 - c[1] * 0.5) * this.h / this.dpr];
  }

  /** Keep a pan inside the sheet: its reach grows with the zoom, and is zero
   *  at the whole-sheet view, so zooming out always returns home exactly. */
  clampPan(st, pan, z) {
    const R = this.noteModel({ ...st, flip: 0, tiltX: 0, tiltY: 0, lift: 0 });
    const ax = [R[0], R[1], R[2]], ay = [R[4], R[5], R[6]];           // the sheet's own axes
    const k = Math.max(0, 1 - 1 / z);
    const px = Math.max(-SHEET[0] / 2 * k, Math.min(SHEET[0] / 2 * k, V.dot(pan, ax)));
    const py = Math.max(-SHEET[1] / 2 * k, Math.min(SHEET[1] / 2 * k, V.dot(pan, ay)));
    return [ax[0] * px + ay[0] * py, ax[1] * px + ay[1] * py, ax[2] * px + ay[2] * py];
  }

  /** The part of the vignette on screen, in its texture uv (y up), square in
   *  vignette units so the engraving target keeps square pixels. When zoomed,
   *  only this part is engraved, at screen resolution: the lines stay sharp. */
  vignetteCrop(st, cam) {
    if ((st.zoom || 1) < 1.02) return [0, 0, 1, 1];
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    const cw = this.w / this.dpr, ch = this.h / this.dpr;
    for (const [sx, sy] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]) {
      const h = this.sheetHit(st, sx * cw, sy * ch, cam);
      if (!(h.t > 0) || !Number.isFinite(h.uv[0]) || !Number.isFinite(h.uv[1])) return [0, 0, 1, 1];
      const vu = (h.uv[0] - L.vignette.x / W) / (L.vignette.w / W);
      const vv = 1 - (h.uv[1] - L.vignette.y / H) / (L.vignette.h / H);
      x0 = Math.min(x0, vu); x1 = Math.max(x1, vu); y0 = Math.min(y0, vv); y1 = Math.max(y1, vv);
    }
    const s = Math.max(x1 - x0, y1 - y0) * 1.08;
    if (s >= 1) return [0, 0, 1, 1];
    let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    cx = Math.min(1 - s / 2, Math.max(s / 2, cx)); cy = Math.min(1 - s / 2, Math.max(s / 2, cy));
    return [cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2];
  }

  /** The screen-space line spacing the engraving should hold. */
  vignettePixels(st, cam) {
    const m = this.noteModel(st);
    const x0 = L.vignette.x / W - 0.5, x1 = (L.vignette.x + L.vignette.w) / W - 0.5;
    const a = M.apply(cam.vp, M.apply(m, [x0 * SHEET[0], 0, 0])), b = M.apply(cam.vp, M.apply(m, [x1 * SHEET[0], 0, 0]));
    return Math.max(80, Math.abs(b[0] - a[0]) * 0.5 * this.w);
  }

  frame(st) {
    const gl = this.gl;
    this.resize();
    this.flush();
    const cam = this.camera(st);
    const nm = this.noteModel(st);

    // ── lamp: follows the pointer; each light mode moves it
    const nx = st.mouse[0], ny = st.mouse[1];
    // the lamp belongs to the room, not the sheet: place it against the
    // unturned sheet, so turning it over brings the back into the light
    const lampFrame = this.noteModel({ ...st, flip: 0 });
    const toWorld = p => M.apply(lampFrame, p);
    let lampLocal;
    if (st.mode === 1) lampLocal = [nx * 60, ny * 30, 5];                    // raking: grazing
    else if (st.mode === 2) lampLocal = [nx * 18, ny * 12, -45];             // behind the sheet
    else lampLocal = [nx * 52 - 6, 16 + ny * 24, 40];                        // daylight / ultraviolet: low enough to model the ink
    const lamp = toWorld(lampLocal);
    const lampCol = st.mode === 3 ? [0.4, 0.28, 1.1] : this.night ? [1.22, 1.14, 1.02] : [1.28, 1.16, 0.98];

    // ── temple: sway, lit from where the lamp is relative to the sheet
    const tb = this.templeBounds;
    const tModel = M.rotY(st.templeYaw);
    const tAt = [0, 11.5, 0];
    const tEye = [0, 11.5 + 72 * Math.sin(0.2), 72 * Math.cos(0.2)];
    const tView = M.lookAt(tEye, tAt, [0, 1, 0]);
    const tProj = M.perspective(0.44, this.VW / this.VH, 20, 160);
    const crop = this.lastCrop = this.vignetteCrop(st, cam);
    const tVPfull = M.mul(tProj, tView);
    const tVP = M.mul(M.crop(tProj, crop[0] * 2 - 1, crop[2] * 2 - 1, crop[1] * 2 - 1, crop[3] * 2 - 1), tView);
    const Ld = V.norm([lampLocal[0], lampLocal[1] + 12, Math.max(lampLocal[2], 8) * 0.8]);
    const lightDir = st.mode === 2 ? V.norm([0.3, 0.6, -0.8]) : Ld;
    const lEye = [tAt[0] + lightDir[0] * 90, tAt[1] + lightDir[1] * 90, tAt[2] + lightDir[2] * 90];
    const lView = M.lookAt(lEye, tAt, Math.abs(lightDir[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0]);
    const R = tb.r * 1.25;
    const lProj = [1 / R, 0, 0, 0, 0, 1 / R, 0, 0, 0, 0, -2 / 100, 0, 0, 0, -180 / 100, 1];   // ortho, near 40, far 140
    const lVP = M.mul(lProj, lView);

    gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    // 1. shadow
    bindTarget(gl, this.shadow);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.pShadow.p);
    uniforms(gl, this.pShadow, { uLightVP: lVP, uModel: tModel });
    this.temple.draw();

    // 2. temple G-buffer
    // line spacing is set at the whole-sheet view and then held to the paper:
    // zooming in enlarges the same lines, as a print does under a glass
    const cam1 = this.camera({ ...st, zoom: 1, pan: [0, 0, 0] });
    const cropW = crop[2] - crop[0];
    const spacing = Math.max(3.2, (this.VW / this.vignettePixels(st, cam1)) * 2.3) / cropW;
    bindTarget(gl, this.gbuf);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.pTemple.p);
    uniforms(gl, this.pTemple, {
      uVP: tVP, uModel: tModel, uLightVP: lVP, uLight: lightDir, uEye: tEye,
      uShadowDepth: { tex: this.shadow.tex, unit: 0 }, uSpacing: spacing, uFar: 160,
      uDepthFade: [58, 88], uPartY: { vec2: this.partY },
    });
    this.temple.draw();

    // 3. engrave
    gl.disable(gl.DEPTH_TEST);
    bindTarget(gl, this.vig);
    gl.useProgram(this.pEngrave.p);
    let dome = M.apply(tVPfull, M.apply(tModel, [0, tb.yDome + 9, 0]));
    if (this.night) {
      // the star the telescope looks at: carry the tube's line on past its mouth, in the picture
      const d = scopeDir(), a = tb.scopeAt, pt = k => M.apply(tVPfull, M.apply(tModel, [a[0] + d[0] * k, a[1] + d[1] * k, a[2] + d[2] * k]));
      const tip = pt(14.3), on = pt(17.3);
      const asp = this.VW / this.VH, dx = (on[0] - tip[0]) * asp, dy = on[1] - tip[1], l = Math.hypot(dx, dy) || 1;
      dome = [Math.min(0.88, Math.max(-0.88, tip[0] + dx / l * 0.42 / asp)), Math.min(0.9, tip[1] + dy / l * 0.42), 0];
    }
    uniforms(gl, this.pEngrave, {
      uG0: { tex: this.gbuf.tex[0], unit: 0 }, uG1: { tex: this.gbuf.tex[1], unit: 1 },
      uInk: st.ink, uGlory: st.glory,
      uDomeTop: [dome[0] * 0.5 + 0.5, dome[1] * 0.5 + 0.5],
      uTime: st.time, uSpacing: spacing, uRes: [this.VW, this.VH],
      uCrop: crop, uContour: Math.min(4, 1 / cropW),
    });
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 3b. the astrolabe on the night desk: where it lies, and its depth seen from the lamp
    const as = this.night && this.astro;
    let aModel, aInv, aLVP;
    if (as) {
      // left of the sheet, its ring and shackle trailing back behind the sheet's edge
      aModel = M.mul(M.translate(-59.93, 0, -49.62), M.rotY(-0.5));
      aInv = M.invert(aModel);
      const c = M.apply(aModel, [0, 1.5, 6.4]), dist = Math.hypot(lamp[0] - c[0], lamp[1] - c[1], lamp[2] - c[2]);
      const lv = M.lookAt(lamp, c, [0, 1, 0]);
      aLVP = M.mul(M.perspective(2 * Math.atan(31 / dist), 1, Math.max(1, dist - 40), dist + 40), lv);
      gl.enable(gl.DEPTH_TEST);
      bindTarget(gl, as.shadow);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.pShadow.p);
      uniforms(gl, this.pShadow, { uLightVP: aLVP, uModel: aModel });
      as.mesh.draw();
    }

    // the spyglass: right of the sheet, lying back from its object glass
    let sModel, spyA, spyB;
    if (this.night && !this.phone) {
      const A = [88, -70], dx = -42, dz = 30.4, l = Math.hypot(dx, dz), dir = [dx / l, dz / l];
      sModel = M.mul(M.translate(A[0], 0, A[1]), M.rotY(Math.atan2(-dir[1], dir[0])));
      const r = SPYGLASS.radius, len = SPYGLASS.length;
      spyA = [A[0], r, A[1], r];
      spyB = [A[0] + dir[0] * len, r, A[1] + dir[1] * len, 1];
    }

    // 4. scene
    const drawScene = (vp, eye) => {
      gl.enable(gl.DEPTH_TEST);
      if (this.night) gl.clearColor(0.0016, 0.003, 0.009, 1); else gl.clearColor(0.004, 0.006, 0.005, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.pBench.p);
      uniforms(gl, this.pBench, {
        uVP: vp, uSize: 700, uLamp: lamp, uLampCol: lampCol, uEye: eye,
        uNoteInv: M.invert(nm), uNoteSize: SHEET, uMode: { int: st.mode },
        ...(this.night ? {
          uDeskOn: this.desk ? 1 : 0,
          uWood: { tex: this.desk ? this.desk.wood : this.tPlate, unit: 9 },
          uWoodS: { tex: this.desk ? this.desk.woodS : this.tPlate, unit: 10 },
          uLeatherS: { tex: this.desk ? this.desk.leatherS : this.tPlate, unit: 11 },
          uAstroOn: as ? 1 : 0,
          uAstroA: { tex: as ? as.a : this.tPlate, unit: 12 },
          uAstroShadow: { tex: as ? as.shadow.tex : this.shadow.tex, unit: 13 },
          ...(as ? { uAstroLVP: aLVP, uAstroInv: aInv } : {}),
          uSpyA: spyA || [0, 0, 0, 1], uSpyB: spyB || [0, 0, 0, 0],
        } : {}),
      });
      this.bench.draw();
      if (as) {
        gl.useProgram(this.pAstro.p);
        uniforms(gl, this.pAstro, {
          uVP: vp, uModel: aModel, uAstroLVP: aLVP, uLamp: lamp, uLampCol: lampCol, uEye: eye,
          uNoteInv: M.invert(nm), uNoteSize: SHEET, uMode: { int: st.mode },
          uAstroA: { tex: as.a, unit: 9 }, uAstroS: { tex: as.s, unit: 10 }, uAstroShadow: { tex: as.shadow.tex, unit: 11 },
        });
        as.mesh.draw();
      }
      if (sModel) {
        gl.useProgram(this.pSpy.p);
        uniforms(gl, this.pSpy, {
          uVP: vp, uModel: sModel, uRadius: SPYGLASS.radius, uLamp: lamp, uLampCol: lampCol, uEye: eye,
          uNoteInv: M.invert(nm), uNoteSize: SHEET, uMode: { int: st.mode },
          uLeatherS: { tex: this.desk ? this.desk.leatherS : this.tPlate, unit: 9 }, uLeatherOn: this.desk ? 1 : 0,
        });
        this.spy.draw();
      }
      gl.useProgram(this.pNote.p);
      uniforms(gl, this.pNote, {
        uVP: vp, uModel: nm, uSize: SHEET, uTime: st.time, uCurl: 0.05,
        uPlate: { tex: this.tPlate, unit: 0 }, uFoil: { tex: this.tFoil, unit: 1 }, uUvt: { tex: this.tUv, unit: 2 },
        uWater: { tex: this.tWater, unit: 3 }, uDyn: { tex: this.tDyn.tex, unit: 4 }, uDynUv: { tex: this.tDynUv.tex, unit: 5 },
        uVig: { tex: this.vig.tex[0], unit: 6 }, uBack: { tex: this.tBack, unit: 7 }, uBackDyn: { tex: this.tBackDyn.tex, unit: 8 },
        uVigRect: [L.vignette.x / W, L.vignette.y / H, L.vignette.w / W, L.vignette.h / H], uVigCrop: crop,
        uSeal: [L.seal.cx / W, L.seal.cy / H, L.seal.r / W], uAspect: W / H,
        uEye: eye, uLamp: lamp, uLampCol: lampCol, uMode: { int: st.mode },
        uQuorum: st.quorum, uFade: 1, uTexel: [1 / W, 1 / H],
      });
      this.sheet.draw();
    };
    bindTarget(gl, this.msaa || this.scene);
    drawScene(cam.vp, cam.eye);
    if (this.msaa) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaa.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.scene.fb);
      gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }

    // 5. loupe: the same scene through a small window around the pointer
    const zoom = st.loupeZoom || 3.2, loupeR = (st.loupeR || 150) * this.dpr;
    if (st.loupe) {
      const mx = st.px[0] * this.dpr / this.w * 2 - 1, my = 1 - st.px[1] * this.dpr / this.h * 2;
      const rx = loupeR / zoom / (this.w / 2), ry = loupeR / zoom / (this.h / 2);
      const lp = M.crop(cam.proj, mx - rx, mx + rx, my - ry, my + ry);
      bindTarget(gl, this.loupe);
      drawScene(M.mul(lp, cam.view), cam.eye);
    }

    // 6. post
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.emptyVao);
    const pass = (prog, dst, u) => { bindTarget(gl, dst); gl.useProgram(prog.p); uniforms(gl, prog, u); gl.drawArrays(gl.TRIANGLES, 0, 3); };
    pass(this.pBright, this.b0, { uSrc: { tex: this.scene.tex[0], unit: 0 }, uThresh: 1.5 });
    const blur = (a, b) => {
      pass(this.pBlur, b, { uSrc: { tex: a.tex[0], unit: 0 }, uDir: [1 / a.w, 0] });
      pass(this.pBlur, a, { uSrc: { tex: b.tex[0], unit: 0 }, uDir: [0, 1 / a.h] });
    };
    blur(this.b0, this.b0b);
    pass(this.pBlur, this.b1, { uSrc: { tex: this.b0.tex[0], unit: 0 }, uDir: [0, 0] });
    blur(this.b1, this.b1b);
    pass(this.pBlur, this.b2, { uSrc: { tex: this.b1.tex[0], unit: 0 }, uDir: [0, 0] });
    blur(this.b2, this.b2b);
    bindTarget(gl, null);
    gl.useProgram(this.pCompose.p);
    uniforms(gl, this.pCompose, {
      uScene: { tex: this.scene.tex[0], unit: 0 }, uBloom0: { tex: this.b0.tex[0], unit: 1 },
      uBloom1: { tex: this.b1.tex[0], unit: 2 }, uBloom2: { tex: this.b2.tex[0], unit: 3 },
      uLoupe: { tex: this.loupe.tex[0], unit: 4 }, uRes: [this.w, this.h],
      uMouse: [st.px[0] * this.dpr, this.h - st.px[1] * this.dpr], uLoupeOn: st.loupe ? 1 : 0, uLoupeR: loupeR,
      uTime: st.time, uExposure: st.mode === 3 ? 1.25 : 1.0,
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    return { nm, cam };
  }

  /** Test hook: the engraved vignette as last rendered (RGBA8, bottom-up rows). */
  readVignette() {
    const gl = this.gl, data = new Uint8Array(this.VW * this.VH * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.vig.fb);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, this.VW, this.VH, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    return { w: this.VW, h: this.VH, data };
  }
}

export { SHEET, PART, N_COLS, BASE_AT };
