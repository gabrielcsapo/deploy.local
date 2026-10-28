import sys, os, json, importlib, shutil, subprocess
sys.path.insert(0, os.path.dirname(__file__))
from shell import page
OUT = sys.argv[1]; mods = sys.argv[2].split(','); render = sys.argv[3:] 
P = os.path.join(OUT, 'project'); os.makedirs(P, exist_ok=True)
ds = os.path.join(P, 'ds', 'deploy-local'); os.makedirs(os.path.join(ds, 'components'), exist_ok=True)
SC = os.path.dirname(os.path.dirname(__file__))
shutil.copy(os.path.join(SC, 'tokens.css'), os.path.join(ds, 'tokens.css'))
shutil.copy(os.path.join(SC, 'ds/project/components/bundle.css'), os.path.join(ds, 'components/bundle.css'))
shutil.copy(os.path.join(SC, 'ds/project/tokens.json'), os.path.join(ds, 'tokens.json'))
allb = {}
for m in mods:
    allb.update(importlib.import_module(m).B)
sizes = {}
for f, v in allb.items():
    pg, title, root = v[:3]
    w, h = (390, 844) if pg == 'phone' else ((v[3], v[4]) if len(v) > 4 else (1440, 900))
    sizes[f] = (pg, title, w, h)
    open(os.path.join(P, f), 'w').write(page(title, root, w, h))
json.dump(sizes, open(os.path.join(OUT, 'sizes.json'), 'w'), indent=1)
chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
os.makedirs(os.path.join(OUT, 'png'), exist_ok=True)
for f in (allb if render == ['all'] else render):
    pg, title, w, h = sizes[f]
    for ww in ([w] if pg == 'phone' or w != 1440 else [w, 700]):
        png = os.path.join(OUT, 'png', f.replace('.dc.html', f'-{ww}.png'))
        subprocess.run([chrome, '--headless=new', '--disable-gpu', '--hide-scrollbars', f'--window-size={ww},{h}', f'--screenshot={png}', 'file://' + os.path.join(P, f)], capture_output=True)
print(len(allb), 'boards')
