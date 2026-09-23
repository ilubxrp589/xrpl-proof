/* Small WebGL2 toolkit: programs, targets, meshes, uniforms. No library. */

export function shader(gl, type, src, name) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)} ${l}`).join('\n');
    throw new Error(`${name}: ${log}\n${lines}`);
  }
  return s;
}

export function program(gl, vs, fs, name = 'program') {
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs, name + '.vs'));
  gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs, name + '.fs'));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name}: ${gl.getProgramInfoLog(p)}`);
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS), loc = {};
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    loc[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, loc, name };
}

/** Set uniforms by name from a plain object; the value's shape picks the call. */
export function uniforms(gl, prog, u) {
  for (const k in u) {
    const l = prog.loc[k];
    if (l === undefined || l === null) continue;
    const v = u[k];
    if (typeof v === 'number') gl.uniform1f(l, v);
    else if (typeof v === 'boolean') gl.uniform1i(l, v ? 1 : 0);
    else if (v && v.tex !== undefined) { gl.activeTexture(gl.TEXTURE0 + v.unit); gl.bindTexture(v.target || gl.TEXTURE_2D, v.tex); gl.uniform1i(l, v.unit); }
    else if (v && v.int !== undefined) gl.uniform1i(l, v.int);
    else if (v && v.vec2 !== undefined) gl.uniform2fv(l, v.vec2);
    else if (v.length === 2) gl.uniform2fv(l, v);
    else if (v.length === 3) gl.uniform3fv(l, v);
    else if (v.length === 4) gl.uniform4fv(l, v);
    else if (v.length === 16) gl.uniformMatrix4fv(l, false, v);
    else if (v.length === 9) gl.uniformMatrix3fv(l, false, v);
    else gl.uniform1fv(l, v);
  }
}

export function texture(gl, w, h, { internal = gl.RGBA8, format = gl.RGBA, type = gl.UNSIGNED_BYTE,
                                    filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE, data = null, mips = false } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  return t;
}

/** A canvas uploaded as a texture; call .update() after drawing into it. */
export function canvasTexture(gl, canvas, { mips = true, aniso = null } = {}) {
  const t = gl.createTexture();
  const obj = {
    tex: t, canvas,
    update(rect, { mip = true } = {}) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (rect && obj.sized) {
        // WebGL2 can lift a sub-rectangle straight out of the canvas
        let [x, y, w, h] = rect.map(Math.round);
        x = Math.max(0, x); y = Math.max(0, y);
        w = Math.min(canvas.width - x, w); h = Math.min(canvas.height - y, h);
        if (w <= 0 || h <= 0) return;
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        obj.sized = true;
      }
      if (mips && mip) gl.generateMipmap(gl.TEXTURE_2D);
    },
    mip() { if (mips) { gl.bindTexture(gl.TEXTURE_2D, t); gl.generateMipmap(gl.TEXTURE_2D); } },
  };
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  obj.update();
  return obj;
}

/** Framebuffer with N colour attachments and an optional depth buffer. */
export function target(gl, w, h, specs, depth = false) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const tex = specs.map((s, i) => {
    const t = texture(gl, w, h, s);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
    return t;
  });
  let rb = null;
  if (depth) {
    rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  }
  gl.drawBuffers(specs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete 0x' + st.toString(16));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    fb, tex, w, h, rb,
    free() { gl.deleteFramebuffer(fb); tex.forEach(t => gl.deleteTexture(t)); if (rb) gl.deleteRenderbuffer(rb); },
  };
}

export function bindTarget(gl, t) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
  gl.viewport(0, 0, t ? t.w : gl.drawingBufferWidth, t ? t.h : gl.drawingBufferHeight);
}

/** Upload attribute arrays; layout maps name → [data, size]. */
export function mesh(gl, attrs, index) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  let loc = 0;
  for (const [data, size] of attrs) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    loc++;
  }
  let count = 0, itype = null;
  if (index) {
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    count = index.length;
    itype = index instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  } else count = attrs[0][0].length / attrs[0][1];
  gl.bindVertexArray(null);
  return {
    vao, count,
    draw(mode = gl.TRIANGLES) {
      gl.bindVertexArray(vao);
      if (itype) gl.drawElements(mode, count, itype, 0); else gl.drawArrays(mode, 0, count);
      gl.bindVertexArray(null);
    },
  };
}

/** A grid in [0,1]², nx × ny cells, as position(uv) only. */
export function grid(nx, ny) {
  const p = [], idx = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) p.push(i / nx, j / ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i;
    idx.push(a, a + 1, a + nx + 2, a, a + nx + 2, a + nx + 1);
  }
  return { uv: new Float32Array(p), idx: new Uint32Array(idx) };
}

// ── matrices (column-major, like GLSL) ───────────────────────────────────────
export const M = {
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  },
  /** Off-centre frustum: the sub-rectangle [x0,x1]×[y0,y1] of NDC of `p`. */
  crop(p, x0, x1, y0, y1) {
    const sx = 2 / (x1 - x0), sy = 2 / (y1 - y0), tx = -(x1 + x0) / (x1 - x0), ty = -(y1 + y0) / (y1 - y0);
    const c = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1];
    return M.mul(c, p);
  },
  lookAt(eye, at, up) {
    const z = norm(sub(eye, at)), x = norm(cross(up, z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  },
  mul(a, b) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
  rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; },
  rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; },
  rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; },
  translate(x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; },
  scale(x, y, z) { return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]; },
  invert(m) {
    const inv = new Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    det = det ? 1 / det : 0;
    return inv.map(x => x * det);
  },
  apply(m, v) {
    const [x, y, z] = v, w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
  },
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
export const V = { sub, dot, cross, norm };
