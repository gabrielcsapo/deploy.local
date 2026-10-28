# Lay the canvas out by flow: one page per flow, one row per step,
# the web app, iPhone, desktop app and CLI boards for that step side by side.
import json, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from flows import FLOWS, PLATFORMS
src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src))
sizes = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(out))), 'sizes.json')))
NAMES = dict(PLATFORMS)
old = d['boards']
boards, order = {}, []
notes = {k: v for k, v in d.get('notes', {}).items() if k in ('intro', 'build', 'desktop', 'cli')}
GAP, COL_GAP = 80, 240
def group_w(names):
    return sum(sizes[b + '.dc.html'][2] for b in names) + GAP * (len(names) - 1) if names else 0
for pid, pname, steps in FLOWS:
    # Fixed columns per page, so each platform lines up down the page.
    widths = {k: max(group_w(st.get(k, [])) for _, st in steps) for k, _ in PLATFORMS}
    col_x, cx = {}, 0
    for k, pretty in PLATFORMS:
        if widths[k]:
            col_x[k] = cx
            notes[f'{pid}-col-{k}'] = {'fill': 'purple', 'page': pid, 'w': 260, 'x': cx, 'y': -220, 'text': pretty}
            cx += widths[k] + COL_GAP
    y = 0
    for n, (label, step) in enumerate(steps):
        row_h, where = 0, []
        for key, pretty in PLATFORMS:
            names = step.get(key, [])
            if not names:
                continue
            where.append(pretty)
            x = col_x[key]
            for b in names:
                f = b + '.dc.html'
                _, title, w, h = sizes[f]
                fill = old.get(f, {}).get('expand') == 'fill' or (key == 'web' and w == 1440 and h <= 1100 and pid not in ('overview', 'cli') and not old.get(f))
                boards[f] = {'x': x, 'y': y, 'w': w, 'h': h, 'title': title, 'page': pid, **({'expand': 'fill'} if fill and key == 'web' else {})}
                order.append(f)
                x += w + GAP
                row_h = max(row_h, h)
        gaps = [f'{NAMES[k]}: {"by design, not here" if v == "design" else "later"}' for k, v in step.get('gaps', {}).items()]
        text = f'{label}\n' + ' · '.join(where) + ('\n' + '; '.join(gaps) if gaps else '')
        notes[f'{pid}-{n}'] = {'fill': 'purple', 'page': pid, 'w': 420, 'x': -500, 'y': y, 'text': text}
        y += row_h + 240
# Page-wide notes sit further left so they never cover a row label.
for k, pg in (('intro', 'overview'), ('build', 'overview'), ('desktop', 'start'), ('cli', 'cli')):
    if k in notes:
        notes[k].update({'page': pg, 'x': -1000, 'y': 0 if k != 'build' else 420, 'w': 440})
d['boards'], d['order'], d['notes'] = boards, order, notes
d['pages'] = [{'id': pid, 'name': pname} for pid, pname, _ in FLOWS]
d['launch'] = {'view': 'canvas', 'page': 'overview'}
json.dump(d, open(out, 'w'), indent=1)
print(len(boards), 'boards on', len(d['pages']), 'pages,', len(notes), 'notes')
