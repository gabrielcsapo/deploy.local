#!/usr/bin/env python3
"""Make one fresh project per run: half set up with `deploy design init` (arm A), half empty (arm B).
Writes the key (default ~/.ab-key.json) (run -> brief, arm) and /tmp/ab/runs/<run>/prompt.txt."""
import json, os, random, re, shutil, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/ab'
# The key says which run had the pipeline; keep it out of the folder the designers and judges can read.
KEY = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser('~/.ab-key.json')
PER_ARM = 2
briefs = json.load(open(os.environ.get('BRIEFS') or os.path.join(HERE, 'briefs.json')))
kit = {'art': 'art', 'model': 'model', 'ui': 'app'}
env_notes = ("Environment: a Linux machine with no network access to package registries or CDNs. "
             "Python 3 with PIL, Node 22 and git are installed. Blender's Python module bpy is installed (python3 -c 'import bpy'). "
             "A headless Chromium is at /tmp/chromium if you want to look at a page. ")
deliver_b = {
  'art': "Deliver each of the 4 assets as its own SVG in out/sprites/ (one SVG unit per pixel, viewBox 0 0 W H, a <rect> per pixel or run of pixels, no blur or gradients).",
  'model': "Deliver the model as out/model.glb (metres, Z up in Blender terms, standing on the ground at the origin), flat colours as materials.",
  'ui': "Deliver the screen as out/screen.html, a self-contained HTML page (no external files or fonts) that renders the screen at 390 x 844 CSS pixels from the top-left corner.",
}
deliver_a = {
  'art': "Deliver the 4 assets as this project's design work: committed boards under design/.",
  'model': "Deliver the model as this project's design work: a committed board under design/ and its model under design/models/.",
  'ui': "Deliver the screen as this project's design work: a committed board under design/.",
}
def sh(cmd, cwd):
    subprocess.run(cmd, cwd=cwd, shell=True, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def main():
    if os.path.exists(ROOT + '/runs'): shutil.rmtree(ROOT + '/runs')
    runs = []
    for b in briefs:
        for arm in 'AB':
            for n in range(1, PER_ARM + 1): runs.append({'brief': b['id'], 'kind': b['kind'], 'arm': arm, 'n': n})
    random.seed(20261128); random.shuffle(runs)
    key = {}
    for i, r in enumerate(runs, 1):
        rid = f'r{i:02d}'
        b = next(x for x in briefs if x['id'] == r['brief'])
        slug = re.sub(r'[^a-z]', '', b['title'].lower().split()[0]) or 'proj'
        base = f'{ROOT}/runs/{rid}'; proj = f'{base}/{slug}'
        os.makedirs(base)
        sh('git init -q --bare origin.git', base)
        sh(f'git clone -q origin.git {slug}', base)
        sh(f'git config user.email designer@example.com && git config user.name Designer && echo "# {b["title"]}" > README.md && git add . && git commit -qm init && git push -q origin HEAD:main', proj)
        if r['arm'] == 'A':
            sh(f'DEPLOY_CHROMIUM=/tmp/chromium node /home/user/deploy.local/bin/deploy.js design init --kind {kit[r["kind"]]}', proj)
            sh('git add -A && git commit -qm "Design system" && git push -q origin HEAD:main', proj)
        sh('git checkout -qb work', proj)
        if r['arm'] == 'A':
            how = ("This project's design work uses the `deploy design` command (it is on PATH as `deploy`). "
                   "Start by reading design/README.md and follow it. " + deliver_a[r['kind']])
        else:
            how = deliver_b[r['kind']] + " Commit your work."
        prompt = (f"You are a designer. Here is your brief.\n\n{b['brief']}\n\n"
                  f"Your project is the git repository at {proj} (on branch `work`). Work only inside that folder; do not read or change anything outside it except running the tools named here. "
                  f"{how}\n\n{env_notes}\n\n"
                  "Do the whole job yourself, to the standard you would hand to the game or app team. "
                  "When you are done, reply in under 150 words: what you made, the file paths, and anything that got in your way, confused you or wasted your time.")
        open(f'{base}/prompt.txt', 'w').write(prompt)
        key[rid] = {**r, 'proj': proj}
    json.dump(key, open(KEY, 'w'), indent=1)
    for rid, r in key.items(): print(rid, r['brief'], r['arm'], r['proj'])
main()
