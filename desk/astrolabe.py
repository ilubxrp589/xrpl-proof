# A brass astrolabe for the Proof page's desk, built procedurally.
#   1. The detailed model (bevelled, every tick and numeral) is rendered top-down as
#      texture maps: colour (+ coverage), and surface (normal x, y, roughness).
#   2. A light version of the same parts (no engraving, fewer segments) is written out
#      as a mesh, so the page can draw it in 3D: real walls and rims under the lamp,
#      its top faces wearing the detailed maps.
# Run: CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=0 blender -b --python astrolabe.py
import bpy, math, os, random, struct

OUT = os.path.expanduser('~/astro/')
os.makedirs(OUT, exist_ok=True)
RES = int(os.environ.get('RES', '2048'))
SAMPLES = int(os.environ.get('SAMPLES', '128'))
TAU = math.pi * 2

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
for kind in ('OPTIX', 'CUDA'):
    try:
        prefs.compute_device_type = kind
        prefs.get_devices()
        if any(d.type == kind for d in prefs.devices):
            break
    except Exception:
        pass
for d in prefs.devices:
    d.use = d.type in ('OPTIX', 'CUDA')
scene.cycles.device = 'GPU'
print('devices:', [(d.name, d.type, d.use) for d in prefs.devices])
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = False
scene.render.film_transparent = True
scene.render.resolution_x = scene.render.resolution_y = RES
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '16'


def build(lo):
    """Every part, as a list of objects tagged 'brass' or 'niello'. lo: the mesh for the
    page (fewer segments, no engraving, no bevels); otherwise the model for the maps."""
    random.seed(1787)
    objs = []
    seg = (lambda n: max(24, n // 4)) if lo else (lambda n: n)

    def mesh_obj(name, verts, faces, kind):
        me = bpy.data.meshes.new(name)
        me.from_pydata(verts, [], faces)
        me.update()
        ob = bpy.data.objects.new(name, me)
        scene.collection.objects.link(ob)
        ob['kind'] = kind
        objs.append(ob)
        return ob

    def annulus(name, r0, r1, z0, z1, kind, n=256, cx=0.0, cy=0.0):
        n = seg(n)
        v, f = [], []
        for i in range(n):
            a = TAU * i / n
            c, s = math.cos(a), math.sin(a)
            v += [(cx + c * r1, cy + s * r1, z0), (cx + c * r1, cy + s * r1, z1), (cx + c * r0, cy + s * r0, z1), (cx + c * r0, cy + s * r0, z0)]
        for i in range(n):
            a, b = 4 * i, 4 * ((i + 1) % n)
            f += [(a, b, b + 1, a + 1), (a + 1, b + 1, b + 2, a + 2), (a + 2, b + 2, b + 3, a + 3), (a + 3, b + 3, b, a)]
        return mesh_obj(name, v, f, kind)

    def disc(name, r, z0, z1, kind, n=256, cx=0.0, cy=0.0):
        n = seg(n)
        v = [(cx, cy, z0), (cx, cy, z1)]
        f = []
        for i in range(n):
            a = TAU * i / n
            v += [(cx + math.cos(a) * r, cy + math.sin(a) * r, z0), (cx + math.cos(a) * r, cy + math.sin(a) * r, z1)]
        for i in range(n):
            a, b = 2 + 2 * i, 2 + 2 * ((i + 1) % n)
            f += [(1, a + 1, b + 1), (0, b, a), (a, b, b + 1, a + 1)]
        return mesh_obj(name, v, f, kind)

    def prism(name, pts, z0, z1, kind):
        """A flat shape (a list of (x, y) around its outline) given a thickness."""
        n = len(pts)
        v = [(x, y, z0) for x, y in pts] + [(x, y, z1) for x, y in pts]
        f = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
        for i in range(n):
            j = (i + 1) % n
            f.append((i, j, n + j, n + i))
        return mesh_obj(name, v, f, kind)

    def boxes(name, specs, kind):
        """Many small boxes in one mesh: (cx, cy, angle, length, width, z0, z1)."""
        v, f = [], []
        for cx, cy, ang, L, w, z0, z1 in specs:
            c, s = math.cos(ang), math.sin(ang)
            corners = [(-L / 2, -w / 2), (L / 2, -w / 2), (L / 2, w / 2), (-L / 2, w / 2)]
            base = len(v)
            for z in (z0, z1):
                for x, y in corners:
                    v.append((cx + x * c - y * s, cy + x * s + y * c, z))
            f += [(base + 3, base + 2, base + 1, base), (base + 4, base + 5, base + 6, base + 7),
                  (base, base + 1, base + 5, base + 4), (base + 1, base + 2, base + 6, base + 5),
                  (base + 2, base + 3, base + 7, base + 6), (base + 3, base, base + 4, base + 7)]
        return mesh_obj(name, v, f, kind)

    # ── the mater: the body, and its raised limb
    disc('back', 1.0, 0.0, 0.05, 'brass')
    annulus('limb', 0.84, 1.0, 0.05, 0.1, 'brass')
    annulus('limb_lip', 0.995, 1.012, 0.0, 0.085, 'brass', n=320)
    if not lo:
        # the limb's scale: a degree each, longer each five and ten, filled black as engraved lines are
        ticks = []
        for d in range(360):
            a = TAU * d / 360
            L = 0.075 if d % 10 == 0 else 0.05 if d % 5 == 0 else 0.028
            r = 0.985 - L / 2
            ticks.append((math.cos(a) * r, math.sin(a) * r, a, L, 0.0038, 0.1, 0.1035))
        boxes('scale', ticks, 'niello')
        annulus('scale_in', 0.905, 0.909, 0.1, 0.1035, 'niello', n=320)
        annulus('scale_out', 0.866, 0.87, 0.1, 0.1035, 'niello', n=320)
        # the degree numerals, every ten, set round the inner band
        for d in range(0, 360, 10):
            a = TAU * d / 360
            bpy.ops.object.text_add(location=(math.cos(a) * 0.887, math.sin(a) * 0.887, 0.1))
            t = bpy.context.active_object
            t.data.body = str(d)
            t.data.size = 0.028
            t.data.align_x = 'CENTER'; t.data.align_y = 'CENTER'
            t.data.extrude = 0.0015
            t.rotation_euler = (0, 0, a - math.pi / 2)
            bpy.ops.object.convert(target='MESH')
            t['kind'] = 'niello'
            objs.append(t)

    # ── the plate: almucantars (circles of equal altitude, off-centre as the projection sets
    # them), the three tropics, the meridian and horizon lines
    disc('plate', 0.84, 0.05, 0.075, 'brass')
    if not lo:
        for k in range(0, 13):
            alt = k * 7.5 * math.pi / 180
            rr = 0.46 * math.cos(alt) / (1 + math.sin(alt)) * 1.6
            cy = 0.46 * 0.35 * (1 - math.cos(alt)) * 1.4
            if rr < 0.02:
                break
            annulus(f'alm{k}', rr - 0.0018, rr + 0.0018, 0.075, 0.0772, 'niello', n=256, cy=cy)
        for rr in (0.8, 0.52, 0.34):
            annulus(f'trop{rr}', rr - 0.0022, rr + 0.0022, 0.075, 0.0772, 'niello', n=320)
        boxes('lines', [(0, 0, math.pi / 2, 1.6, 0.004, 0.075, 0.0772), (0, 0, 0, 1.6, 0.004, 0.075, 0.0772)], 'niello')

    # ── the rete: the star map's fretwork, turning over the plate
    annulus('rete_rim', 0.78, 0.81, 0.095, 0.115, 'brass', n=320)
    annulus('ecliptic', 0.5, 0.535, 0.095, 0.115, 'brass', n=256, cy=0.26)
    if not lo:
        annulus('ecl_scale', 0.5, 0.503, 0.115, 0.117, 'niello', n=256, cy=0.26)
    boxes('rete_bars', [(0, 0, math.pi / 2, 1.56, 0.03, 0.095, 0.115), (0, -0.36, 0, 1.2, 0.028, 0.095, 0.115)], 'brass')
    # star pointers: flame-shaped blades from the fretwork to a star, each with a boss
    stars = [(-0.55, 0.42), (-0.62, -0.18), (-0.3, -0.62), (0.24, -0.66), (0.6, -0.4), (0.66, 0.12),
             (0.46, 0.55), (0.12, 0.7), (-0.2, 0.28), (0.28, 0.16), (-0.38, -0.3), (0.05, -0.45)]
    for i, (sx, sy) in enumerate(stars):
        d = math.hypot(sx, sy)
        ux, uy = sx / d, sy / d
        base_r = 0.78 if d > 0.5 else d + 0.16
        bx, by = ux * base_r, uy * base_r
        px, py = -uy, ux
        w = 0.03
        pts = []
        for t in [j / 10 for j in range(11)]:
            cx = bx + (sx - bx) * t + px * 0.03 * math.sin(math.pi * t)
            cy = by + (sy - by) * t + py * 0.03 * math.sin(math.pi * t)
            pts.append((cx + px * w * (1 - t), cy + py * w * (1 - t)))
        for t in [j / 10 for j in range(10, -1, -1)]:
            cx = bx + (sx - bx) * t + px * 0.03 * math.sin(math.pi * t)
            cy = by + (sy - by) * t + py * 0.03 * math.sin(math.pi * t)
            pts.append((cx - px * w * (1 - t) * 0.6, cy - py * w * (1 - t) * 0.6))
        # the two passes meet at the tip: drop the repeat, or the outline folds back on itself
        pts = pts[:11] + pts[12:]
        prism(f'pointer{i}', pts, 0.095, 0.112, 'brass')
        disc(f'boss{i}', 0.022, 0.095, 0.118, 'brass', n=32, cx=bx, cy=by)

    # ── the rule across it all, the pin and its horse
    rule = [(-0.97, 0.0), (-0.9, -0.042), (-0.1, -0.05), (0.1, -0.05), (0.9, -0.042), (0.97, 0.0),
            (0.9, 0.042), (0.1, 0.05), (-0.1, 0.05), (-0.9, 0.042)]
    a = 0.58
    prism('rule', [(x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)) for x, y in rule], 0.12, 0.145, 'brass')
    if not lo:
        boxes('rule_fid', [(0, 0, a, 1.9, 0.004, 0.145, 0.147)], 'niello')
    disc('pin', 0.045, 0.0, 0.2, 'brass', n=48)
    disc('pin_cap', 0.06, 0.2, 0.215, 'brass', n=48)
    boxes('horse', [(0.0, 0.0, a + math.pi / 2, 0.16, 0.035, 0.17, 0.205)], 'brass')

    # ── the throne at the top, its shackle, and the ring it hangs by (lying flat on the desk)
    throne = []
    for k in range(33 if not lo else 17):
        t = k / (32 if not lo else 16) * math.pi
        throne.append((math.cos(t) * 0.2, 1.0 + math.sin(t) * 0.17))
    throne = [(-0.2, 0.96)] + throne[::-1] + [(0.2, 0.96)]
    prism('throne', throne, 0.0, 0.07, 'brass')
    annulus('throne_eye', 0.045, 0.075, 0.07, 0.085, 'brass', n=64, cy=1.09)
    if not lo:
        disc('throne_hole', 0.045, 0.07, 0.071, 'niello', n=64, cy=1.09)
    for R, r, y in ((0.12, 0.022, 1.3), (0.2, 0.026, 1.58)):
        bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, location=(0, y, r + 0.004),
                                         major_segments=64 if lo else 96, minor_segments=10 if lo else 24)
        ob = bpy.context.active_object; ob['kind'] = 'brass'; objs.append(ob)

    for ob in objs:
        if ob.type != 'MESH':
            continue
        for p in ob.data.polygons:
            p.use_smooth = True
        if lo:
            # smooth round the curves, sharp where the faces turn a corner
            ob.data.set_sharp_from_angle(angle=math.radians(40))
            continue
        # round every edge: seen from straight above, a bevel is the only relief there is
        thin = max(min(ob.dimensions), 1e-4)
        mod = ob.modifiers.new('bevel', 'BEVEL')
        mod.width = min(0.012, thin * (0.35 if ob['kind'] == 'brass' else 0.25))
        mod.segments = 3
        mod.limit_method = 'ANGLE'
        mod.angle_limit = math.radians(40)
    return objs


# ── materials: one per pass, every one of them emission so the maps come out as data
def mat(name, build):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    build(nt, em)
    return m

def node(nt, kind, **inputs):
    n = nt.nodes.new(kind)
    for k, v in inputs.items():
        n.inputs[k].default_value = v
    return n

def math_node(nt, op, a, b=None, clamp=False):
    n = nt.nodes.new('ShaderNodeMath'); n.operation = op; n.use_clamp = clamp
    for i, x in enumerate((a, b)):
        if x is None:
            continue
        if isinstance(x, (int, float)):
            n.inputs[i].default_value = x
        else:
            nt.links.new(x, n.inputs[i])
    return n.outputs[0]

def coords(nt):
    return nt.nodes.new('ShaderNodeTexCoord').outputs['Object']

def noise(nt, scale, detail=4.0, rough=0.55, vec=None):
    nz = node(nt, 'ShaderNodeTexNoise', Scale=scale, Detail=detail, Roughness=rough)
    nt.links.new(vec if vec is not None else coords(nt), nz.inputs['Vector'])
    return nz.outputs['Fac']

def ramp01(nt, x, lo, hi):
    """smoothstep(lo, hi, x)"""
    r = nt.nodes.new('ShaderNodeMapRange'); r.interpolation_type = 'SMOOTHSTEP'
    r.inputs['From Min'].default_value = lo; r.inputs['From Max'].default_value = hi
    nt.links.new(x, r.inputs['Value'])
    return r.outputs['Result']

def mix_rgb(nt, f, a, b):
    m = nt.nodes.new('ShaderNodeMix'); m.data_type = 'RGBA'
    nt.links.new(f, m.inputs['Factor'])
    for sock, v in (('A', a), ('B', b)):
        if isinstance(v, tuple):
            m.inputs[sock].default_value = v
        else:
            nt.links.new(v, m.inputs[sock])
    return m.outputs['Result']

def ao(nt, dist=0.05):
    a = node(nt, 'ShaderNodeAmbientOcclusion', Distance=dist)
    a.samples = 16
    return a.outputs['AO']

def edge(nt):
    """1 on the rounded rims, 0 on open faces: where the bevelled normal leaves the face's own."""
    bv = nt.nodes.new('ShaderNodeBevel'); bv.samples = 8; bv.inputs['Radius'].default_value = 0.008
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    d = nt.nodes.new('ShaderNodeVectorMath'); d.operation = 'DOT_PRODUCT'
    nt.links.new(bv.outputs['Normal'], d.inputs[0]); nt.links.new(geo.outputs['Normal'], d.inputs[1])
    return ramp01(nt, math_node(nt, 'SUBTRACT', 1.0, d.outputs['Value']), 0.004, 0.05)

def scratches(nt):
    """Fine hairline scratches from years of handling, in patches: 0..1."""
    total = None
    for i, (ang, sc, patch) in enumerate(((0.3, 9.0, 2.1), (1.9, 7.0, 2.7), (2.6, 11.0, 1.7))):
        mp = nt.nodes.new('ShaderNodeMapping')
        mp.inputs['Rotation'].default_value = (0, 0, ang)
        mp.inputs['Scale'].default_value = (1.0, 34.0, 1.0)
        nt.links.new(coords(nt), mp.inputs['Vector'])
        vo = nt.nodes.new('ShaderNodeTexVoronoi'); vo.feature = 'DISTANCE_TO_EDGE'
        vo.inputs['Scale'].default_value = sc; vo.inputs['Randomness'].default_value = 1.0
        nt.links.new(mp.outputs['Vector'], vo.inputs['Vector'])
        line = ramp01(nt, math_node(nt, 'SUBTRACT', 0.03, vo.outputs['Distance']), 0.0, 0.03)
        mask = ramp01(nt, noise(nt, patch, 2.0), 0.5, 0.62)
        s = math_node(nt, 'MULTIPLY', line, mask)
        total = s if total is None else math_node(nt, 'MAXIMUM', total, s)
    return total

def brass_albedo(nt, em):
    # linear reflectance: polished brass, tarnished brass, and the dark patina that
    # collects in corners; worn bright at the rims and along the scratches
    tarnish = ramp01(nt, noise(nt, 3.2, 8.0, 0.62), 0.36, 0.7)
    base = mix_rgb(nt, tarnish, (0.80, 0.60, 0.28, 1), (0.46, 0.31, 0.12, 1))
    mottle = ramp01(nt, noise(nt, 26.0, 6.0), 0.3, 0.8)
    base = mix_rgb(nt, math_node(nt, 'MULTIPLY', mottle, 0.25), base, (0.36, 0.24, 0.09, 1))
    cav = math_node(nt, 'SUBTRACT', 1.0, ao(nt, 0.04))
    base = mix_rgb(nt, ramp01(nt, cav, 0.05, 0.7), base, (0.10, 0.065, 0.025, 1))
    # a little verdigris deep in the corners
    vg = math_node(nt, 'MULTIPLY', ramp01(nt, cav, 0.45, 0.9), ramp01(nt, noise(nt, 14.0), 0.55, 0.7))
    base = mix_rgb(nt, math_node(nt, 'MULTIPLY', vg, 0.6), base, (0.12, 0.2, 0.14, 1))
    base = mix_rgb(nt, math_node(nt, 'MULTIPLY', edge(nt), 0.75), base, (0.93, 0.76, 0.42, 1))
    base = mix_rgb(nt, math_node(nt, 'MULTIPLY', scratches(nt), 0.5), base, (0.9, 0.72, 0.4, 1))
    nt.links.new(base, em.inputs['Color'])

def niello_albedo(nt, em):
    em.inputs['Color'].default_value = (0.018, 0.016, 0.014, 1)

def brass_surface(nt, em):
    # R, G: the normal (x, y), with a soft hammered unevenness and the scratches cut in;
    # B: roughness, glossier where it is polished, duller where tarnished or handled
    hammer = noise(nt, 70.0, 6.0)
    sc = scratches(nt)
    h = math_node(nt, 'SUBTRACT', math_node(nt, 'MULTIPLY', hammer, 1.0), math_node(nt, 'MULTIPLY', sc, 0.5))
    bump = node(nt, 'ShaderNodeBump', Strength=0.14, Distance=0.003)
    nt.links.new(h, bump.inputs['Height'])
    sep = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(bump.outputs['Normal'], sep.inputs[0])
    tarnish = ramp01(nt, noise(nt, 3.2, 8.0, 0.62), 0.36, 0.7)
    smudge = ramp01(nt, noise(nt, 7.0, 3.0), 0.55, 0.75)
    r = math_node(nt, 'ADD', 0.24, math_node(nt, 'MULTIPLY', tarnish, 0.22))
    r = math_node(nt, 'ADD', r, math_node(nt, 'MULTIPLY', smudge, 0.16))
    r = math_node(nt, 'ADD', r, math_node(nt, 'MULTIPLY', sc, 0.18))
    r = math_node(nt, 'SUBTRACT', r, math_node(nt, 'MULTIPLY', edge(nt), 0.12))
    r = math_node(nt, 'ADD', r, math_node(nt, 'MULTIPLY', noise(nt, 40.0, 4.0), 0.08), clamp=True)
    comb = nt.nodes.new('ShaderNodeCombineColor')
    for i, x in enumerate((sep.outputs['X'], sep.outputs['Y'])):
        nt.links.new(math_node(nt, 'ADD', math_node(nt, 'MULTIPLY', x, 0.5), 0.5), comb.inputs[i])
    nt.links.new(r, comb.inputs[2])
    nt.links.new(comb.outputs['Color'], em.inputs['Color'])

def niello_surface(nt, em):
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(geo.outputs['Normal'], sep.inputs[0])
    comb = nt.nodes.new('ShaderNodeCombineColor')
    for i, x in enumerate((sep.outputs['X'], sep.outputs['Y'])):
        nt.links.new(math_node(nt, 'ADD', math_node(nt, 'MULTIPLY', x, 0.5), 0.5), comb.inputs[i])
    comb.inputs[2].default_value = 0.72
    nt.links.new(comb.outputs['Color'], em.inputs['Color'])

def coverage(nt, em):
    em.inputs['Color'].default_value = (1, 1, 1, 1)

M = {
    'albedo': {'brass': mat('brass_albedo', brass_albedo), 'niello': mat('niello_albedo', niello_albedo)},
    'surface': {'brass': mat('brass_surface', brass_surface), 'niello': mat('niello_surface', niello_surface)},
}

# ── the maps: a camera looking straight down on the detailed model
cam_data = bpy.data.cameras.new('cam'); cam_data.type = 'ORTHO'; cam_data.ortho_scale = 3.0
cam = bpy.data.objects.new('cam', cam_data); scene.collection.objects.link(cam)
cam.location = (0, 0.4, 5); cam.rotation_euler = (0, 0, 0)
scene.camera = cam
world = bpy.data.worlds.new('w'); scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.0

hi = build(False)
if os.environ.get('MAPS', '1') == '1':
    for name, view in (('albedo', 'Standard'), ('surface', 'Raw')):
        scene.view_settings.view_transform = view
        for ob in hi:
            ob.data.materials.clear()
            ob.data.materials.append(M[name][ob['kind']])
        scene.render.filepath = OUT + f'astro-{name}.png'
        bpy.ops.render.render(write_still=True)
        print('rendered', name)

# ── the mesh: the light model, triangulated, as positions + normals + indices
for ob in hi:
    bpy.data.objects.remove(ob, do_unlink=True)
lo = build(True)
deps = bpy.context.evaluated_depsgraph_get()
P, N, I, seen = [], [], [], {}
for ob in lo:
    ev = ob.evaluated_get(deps)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    cn = me.corner_normals
    mw = ob.matrix_world
    mn = mw.to_3x3().inverted().transposed()
    for tri in me.loop_triangles:
        for li in tri.loops:
            p = mw @ me.vertices[me.loops[li].vertex_index].co
            n = (mn @ cn[li].vector).normalized()
            k = (round(p.x, 5), round(p.y, 5), round(p.z, 5), round(n.x, 3), round(n.y, 3), round(n.z, 3))
            i = seen.get(k)
            if i is None:
                i = seen[k] = len(P)
                P.append(p); N.append(n)
            I.append(i)
    ev.to_mesh_clear()
# int16 throughout: positions over +-2 blender units, normals over +-1
with open(OUT + 'astrolabe.bin', 'wb') as f:
    f.write(b'ASTR' + struct.pack('<III', len(P), len(I), 16384))
    f.write(struct.pack(f'<{3 * len(P)}h', *[max(-32767, min(32767, round(c * 16384))) for p in P for c in p]))
    f.write(struct.pack(f'<{3 * len(N)}h', *[max(-32767, min(32767, round(c * 32767))) for n in N for c in n]))
    f.write(struct.pack(f'<{len(I)}{"H" if len(P) < 65536 else "I"}', *I))
print('mesh', len(P), 'vertices', len(I) // 3, 'triangles')
print('mapping: centre (0, 0.4), size 3.0 blender units; radius 1.0 is the limb')
