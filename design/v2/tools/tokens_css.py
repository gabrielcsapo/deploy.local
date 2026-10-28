# Compile tokens.json into tokens.css the way the design-system page does.
import json, sys
t = json.load(open(sys.argv[1]))
themes = [th['id'] for th in t['color']['themes']]
first = themes[0]
def per(tokens, theme):
    out = []
    for tk in tokens:
        v = tk['value']
        v = v if isinstance(v, str) else v.get(theme, v.get(first))
        out.append(f'  --{tk["name"]}: {v};')
    return '\n'.join(out)
css = [f'/* {t["name"]} — generated from tokens.json */']
css.append(f':root, [data-theme="{first}"] {{\n{per(t["color"]["tokens"], first)}\n{per(t.get("shadow", {}).get("tokens", []), first)}\n}}')
for th in themes[1:]:
    css.append(f'[data-theme="{th}"] {{\n{per(t["color"]["tokens"], th)}\n{per(t.get("shadow", {}).get("tokens", []), th)}\n}}')
flat = []
for fam in ('spacing', 'radius', 'size'):
    flat += [f'  --{tk["name"]}: {tk["value"]};' for tk in t.get(fam, {}).get('tokens', [])]
flat += [f'  --font-{k}: {v};' for k, v in t['type']['families'].items()]
css.append(':root {\n' + '\n'.join(flat) + '\n}')
open(sys.argv[2], 'w').write('\n'.join(css) + '\n')
