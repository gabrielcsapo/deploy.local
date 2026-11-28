#!/usr/bin/env python3
"""Render every model run the same way: four views from bin/design-blender.py on one sheet, plus a
far-away thumbnail and the measured size and triangles. Usage: render_models.py <key.json> <out dir>"""
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, '..', '..', 'bin', 'design-blender.py')
key = json.load(open(sys.argv[1])); OUT = sys.argv[2]
briefs = {b['id']: b for b in json.load(open(os.environ.get('BRIEFS') or os.path.join(HERE, 'briefs.json')))}
def glb_of(r):
    if r['arm'] == 'B': return os.path.join(r['proj'], 'out', 'model.glb')
    d = os.path.join(r['proj'], 'output', 'design', 'models')
    return os.path.join(d, next(f for f in sorted(os.listdir(d)) if f.endswith('.glb')))
def font(n):
    try: return ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', n)
    except Exception: return ImageFont.load_default()
def one(item):
    rid, r = item
    b = briefs[r['brief']]; work = os.path.join(OUT, '.work', rid)
    subprocess.run(['python3', '-I', RUNNER, '--', '--model', glb_of(r), '--out', work, '--box', b['box'],
                    '--size', '480', '--samples', '32'], check=True, capture_output=True)
    stats = json.load(open(os.path.join(work, 'stats.json')))
    S = 480; sheet = Image.new('RGB', (S * 2 + 30, S * 2 + 200), (226, 228, 232)); d = ImageDraw.Draw(sheet)
    for i, v in enumerate(['front', 'side', 'three-quarter', 'top']):
        im = Image.open(os.path.join(work, f'{v}.png')).convert('RGBA')
        bg = Image.new('RGBA', im.size, (226, 228, 232, 255)); bg.alpha_composite(im)
        x, y = 10 + (i % 2) * (S + 10), 10 + (i // 2) * (S + 10)
        sheet.paste(bg.convert('RGB'), (x, y)); d.text((x + 8, y + 6), v, fill=(60, 60, 70), font=font(16))
    far = Image.open(os.path.join(work, 'three-quarter.png')).convert('RGBA')
    sky = Image.new('RGBA', far.size, (150, 160, 175, 255)); sky.alpha_composite(far)
    sky = sky.resize((48, 48), Image.LANCZOS).convert('RGB')
    y0 = S * 2 + 30
    sheet.paste(sky, (10, y0)); d.text((66, y0 + 14), 'far away (about 48 px tall)', fill=(60, 60, 70), font=font(15))
    lo, hi = stats['bounds']['min'], stats['bounds']['max']
    size = 'x'.join(f'{hi[i] - lo[i]:.2f}' for i in range(3))
    d.text((10, y0 + 70), f"measured: {stats['tris']} triangles, {size} m (w x d x h), lowest point z={lo[2]:.2f} m", fill=(20, 20, 30), font=font(17))
    d.text((10, y0 + 100), f"brief: at most {b['tris']} triangles, fits in {b['box']} m", fill=(20, 20, 30), font=font(17))
    os.makedirs(os.path.join(OUT, r['brief']), exist_ok=True)
    sheet.save(os.path.join(OUT, r['brief'], f'{rid}.png'))
    return rid, stats['tris'], size
runs = [(k, v) for k, v in sorted(key.items()) if v['kind'] == 'model']
with ThreadPoolExecutor(3) as ex:
    for res in ex.map(one, runs): print(*res)
