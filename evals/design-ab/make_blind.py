#!/usr/bin/env python3
"""Copy the renders into blind folders: per judge and brief, candidates under shuffled letters.
Usage: make_blind.py <key.json> <render dir> <blind dir> <secret map out> [judges=2]"""
import json, os, random, shutil, sys
key = json.load(open(sys.argv[1])); RENDER, BLIND, SECRET = sys.argv[2:5]
JUDGES = int(sys.argv[5]) if len(sys.argv) > 5 else 2
if os.path.exists(BLIND): shutil.rmtree(BLIND)
rng = random.Random(4417); secret = {}
briefs = sorted({r['brief'] for r in key.values()})
for j in range(1, JUDGES + 1):
    for b in briefs:
        rids = sorted(k for k, r in key.items() if r['brief'] == b); rng.shuffle(rids)
        kind = key[rids[0]]['kind']
        d = os.path.join(BLIND, f'{kind}-judge{j}', b); os.makedirs(d)
        for letter, rid in zip('PQRS', rids):
            shutil.copy(os.path.join(RENDER, b, f'{rid}.png'), os.path.join(d, f'{letter}.png'))
            secret[f'{kind}-judge{j}/{b}/{letter}'] = rid
json.dump(secret, open(SECRET, 'w'), indent=1)
print(len(secret), 'images')

# One prompt per judge, from judge_prompt.md and the briefs.
HERE = os.path.dirname(os.path.abspath(__file__))
all_briefs = {b['id']: b for b in json.load(open(os.environ.get('BRIEFS') or os.path.join(HERE, 'briefs.json')))}
notes = {
    'art': "Each picture shows one candidate's four sprites: in play at 4x on the brief's background, the ground tile repeated 3 x 3, and a close-up at 8x on a checkerboard. Every candidate is shown the same way.",
    'model': "Each picture shows one candidate's 3D model rendered the same way from five sides (orthographic: front, side, three-quarter, top and underneath), a tiny far-away view, and its measured triangles and size against the brief's limits.",
    'ui': "Each picture is one candidate's phone screen, captured the same way at 390 x 844 points (shown at 2x).",
}
template = open(os.path.join(HERE, 'judge_prompt.md')).read()
for folder in sorted(os.listdir(BLIND)):
    kind = folder.split('-judge')[0]; parts = []
    for b in sorted(os.listdir(os.path.join(BLIND, folder))):
        d = os.path.join(BLIND, folder, b)
        if not os.path.isdir(d): continue
        parts.append(f"Brief {b}: {all_briefs[b]['brief']}\nCandidates: " + ', '.join(f'{d}/{x}.png' for x in 'PQRS'))
    text = template.replace('{{KIND_NOTE}}', notes[kind]).replace('{{BRIEFS}}', '\n\n'.join(parts))
    open(os.path.join(BLIND, folder, 'prompt.txt'), 'w').write(text)
