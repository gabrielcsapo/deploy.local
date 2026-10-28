#!/bin/zsh
# render.sh OUT "Board.dc.html:W:H" ...   renders each board in parallel with headless Chrome
OUT=$1; shift
for spec in "$@"; do
  f=${spec%%:*}; rest=${spec#*:}; w=${rest%%:*}; h=${rest#*:}
  ( "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --user-data-dir=$(mktemp -d) --window-size=$w,$h --screenshot=$OUT/png/${f%.dc.html}-$w.png file://$OUT/project/$f >/dev/null 2>&1 ) &
done
wait
