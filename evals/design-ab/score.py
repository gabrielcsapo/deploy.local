#!/usr/bin/env python3
"""Unblind the judges' rankings and count pipeline (A) vs no pipeline (B).
Every A run is compared with every B run on the same brief (4 pairs a brief). A pair counts as a
win only when both judges put A above B, a loss when both put B above A, and split otherwise.
Usage: score.py <key.json> <blind map> <judgements dir>"""
import json, os, sys
from collections import defaultdict
key = json.load(open(sys.argv[1])); blind = json.load(open(sys.argv[2])); JD = sys.argv[3]
rank = defaultdict(dict)      # (judge tag, brief) -> rid -> position
scores = defaultdict(list)    # rid -> list of score dicts
flaws = defaultdict(list)
for f in sorted(os.listdir(JD)):
    if not f.endswith('.json'): continue
    tag = f[:-5]; data = json.load(open(os.path.join(JD, f)))['briefs']
    for b, v in data.items():
        for pos, letter in enumerate(v['ranking']):
            rank[(tag, b)][blind[f'{tag}/{b}/{letter}']] = pos
        for letter, s in v['scores'].items():
            rid = blind[f'{tag}/{b}/{letter}']
            scores[rid].append(s); flaws[rid].append(s['flaw'])
out = {'kinds': {}, 'runs': {}}
for kind in sorted({r['kind'] for r in key.values()}):
    w = l = sp = 0; per_brief = {}
    for b in sorted({r['brief'] for r in key.values() if r['kind'] == kind}):
        A = [k for k, r in key.items() if r['brief'] == b and r['arm'] == 'A']
        B = [k for k, r in key.items() if r['brief'] == b and r['arm'] == 'B']
        judges = [t for (t, bb) in rank if bb == b]
        bw = bl = bs = 0
        for a in A:
            for x in B:
                votes = [rank[(t, b)][a] < rank[(t, b)][x] for t in judges]
                if all(votes): bw += 1
                elif not any(votes): bl += 1
                else: bs += 1
        per_brief[b] = (bw, bl, bs); w += bw; l += bl; sp += bs
    mean = {}
    for arm in 'AB':
        vals = [s for k, r in key.items() if r['kind'] == kind and r['arm'] == arm for s in scores[k]]
        mean[arm] = {c: round(sum(v[c] for v in vals) / len(vals), 2) for c in ['fulfils', 'reads', 'craft', 'ready']}
    # Each judge on its own (judge1 is Sonnet, judge2 Opus): pairs where it put A above B.
    by_judge = {}
    for b in sorted({r['brief'] for r in key.values() if r['kind'] == kind}):
        A = [k for k, r in key.items() if r['brief'] == b and r['arm'] == 'A']
        B = [k for k, r in key.items() if r['brief'] == b and r['arm'] == 'B']
        for (t, bb) in rank:
            if bb != b: continue
            j = t.split('-')[-1]; got = by_judge.setdefault(j, [0, 0])
            for a in A:
                for x in B:
                    got[0 if rank[(t, b)][a] < rank[(t, b)][x] else 1] += 1
    print(f"   by judge (A above B, B above A): {by_judge}")
    out['kinds'][kind] = {'by_judge': by_judge, 'pipeline_wins': w, 'pipeline_losses': l, 'split': sp, 'per_brief': per_brief, 'mean_scores': mean}
    print(f"{kind}: pipeline won {w}, lost {l}, split {sp} of {w + l + sp} pairs  per brief {per_brief}")
    print(f"   mean scores A(pipeline) {mean['A']}  B(none) {mean['B']}")
for k, r in sorted(key.items()):
    pos = [p[k] for (t, b), p in rank.items() if k in p]
    out['runs'][k] = {'brief': r['brief'], 'arm': r['arm'], 'positions': pos, 'flaws': flaws[k]}
    print(k, r['brief'], r['arm'], 'ranks', [p + 1 for p in pos])
json.dump(out, open(os.path.join(JD, 'results.json'), 'w'), indent=1)
