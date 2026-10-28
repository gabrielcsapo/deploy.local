#!/bin/zsh
# Rebuild the v2 design from source: boards, canvas layout, and PNG renders.
#   design/v2/build.sh            boards + layout + every PNG
#   design/v2/build.sh Live Inbox boards + layout, PNGs for the named boards only
# Needs uv (Python 3.13) and Google Chrome. Output goes to design/v2/canvas/.
set -e
V=${0:A:h}
cd $V
MODS=$(ls tools/b_*.py | xargs -n1 basename | sed 's/\.py$//' | paste -sd, -)
PY=(uv run --no-project --python 3.13 python)
$PY tools/tokens_css.py ds/project/tokens.json tokens.css
$PY tools/build.py canvas $MODS none 2>/dev/null || true   # writes boards and sizes.json; 'none' skips build.py's slow renderer
[ -f canvas/sizes.json ] || { echo "build failed"; exit 1; }
$PY tools/relayout.py canvas/project/canvas.json canvas/project/canvas.json
# Web boards render at 1440 and 700; iPhone boards at 390.
specs=$(python3 - "$@" <<'PY'
import json, sys
s = json.load(open('canvas/sizes.json')); want = set(sys.argv[1:])
for f, (pg, t, w, h) in sorted(s.items()):
    if want and f[:-8] not in want: continue
    for ww in ([w] if pg == 'phone' or w != 1440 else [w, 700]):
        print(f'{f}:{ww}:{h}')
PY
)
mkdir -p canvas/png
[ $# -eq 0 ] && rm -f canvas/png/*.png(N)
echo $specs | xargs -n 12 zsh tools/render.sh $V/canvas
echo "$(ls canvas/project/*.dc.html | wc -l | tr -d ' ') boards, $(ls canvas/png | wc -l | tr -d ' ') renders"
