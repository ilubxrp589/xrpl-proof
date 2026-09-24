# Pack the night desk's maps into proof/assets/desk/, as the page loads them.
#
#   python3 pack.py textures          the photographed wood and leather, fetched from Poly Haven
#                                     (CC0): Wood Table 001 and Leather Red 03, 2K
#   python3 pack.py astrolabe <dir>   the astrolabe, from astrolabe.py's output in <dir>
#                                     (astro-albedo.png, astro-surface.png, astrolabe.bin)
#
# Colour maps stay colour (JPEG, WebP). Maps that hold numbers (normal x, y and roughness)
# go into JPEG without chroma subsampling, which would otherwise smear one channel into
# another. Needs Pillow built with WebP.
import os, shutil, sys, urllib.request
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'proof', 'assets', 'desk')
BASE = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k'


def fetch(asset, kind):
    name = f'{asset}_{kind}_2k.jpg'
    if not os.path.exists(name):
        urllib.request.urlretrieve(f'{BASE}/{asset}/{name}', name)
    return name


def surface(normal, rough, size, out, quality):
    """normal x, y (OpenGL convention) in R, G; roughness in B"""
    n = Image.open(normal).convert('RGB')
    r = Image.open(rough).convert('L')
    if n.size[0] != size:
        n = n.resize((size, size), Image.LANCZOS)
        r = r.resize((size, size), Image.LANCZOS)
    nr, ng, _ = n.split()
    Image.merge('RGB', (nr, ng, r)).save(out, quality=quality, subsampling=0, optimize=True)


def textures():
    # the desk: 1.5 m of varnished wood; the blotter: leather, its own colour replaced by the page
    Image.open(fetch('wood_table_001', 'diff')).convert('RGB').save(os.path.join(OUT, 'wood.jpg'), quality=82, optimize=True)
    surface(fetch('wood_table_001', 'nor_gl'), fetch('wood_table_001', 'rough'), 1024, os.path.join(OUT, 'wood-surface.jpg'), 90)
    surface(fetch('leather_red_03', 'nor_gl'), fetch('leather_red_03', 'rough'), 1024, os.path.join(OUT, 'leather-surface.jpg'), 90)


def astrolabe(src):
    # colour, and its outline in alpha (the page blurs it for the dark under the rim)
    Image.open(os.path.join(src, 'astro-albedo.png')).convert('RGBA').save(
        os.path.join(OUT, 'astrolabe.webp'), quality=90, alpha_quality=100, method=6)
    Image.open(os.path.join(src, 'astro-surface.png')).convert('RGB').save(
        os.path.join(OUT, 'astrolabe-surface.jpg'), quality=92, subsampling=0, optimize=True)
    shutil.copy(os.path.join(src, 'astrolabe.bin'), os.path.join(OUT, 'astrolabe.bin'))


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    if sys.argv[1:2] == ['textures']:
        textures()
    elif sys.argv[1:2] == ['astrolabe'] and len(sys.argv) > 2:
        astrolabe(sys.argv[2])
    else:
        sys.exit(__doc__ or 'usage: pack.py textures | pack.py astrolabe <dir>')
    for f in sorted(os.listdir(OUT)):
        print(f, os.path.getsize(os.path.join(OUT, f)))
