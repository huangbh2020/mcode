#!/bin/bash
# 结构探针:在源截图里量出卡片/面板的真实边框位置。
# 用法: ./probe.sh <src.png|相对html的路径> <axis:v|h> [x0 x1 y0 y1] [th] [ratio]
set -e
B="/Users/maiwy/workspace/cc-gui/docs/推广/p1"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
src="$1"; axis="$2"; x0="${3:-0}"; x1="${4:-0}"; y0="${5:-0}"; y1="${6:-0}"
th="${7:-10}"; ratio="${8:-0.6}"
url="file://$B/html/_probe.html?src=$src&axis=$axis&x0=$x0&x1=$x1&y0=$y0&y1=$y1&th=$th&ratio=$ratio"
"$CHROME" --headless --disable-gpu --allow-file-access-from-files \
  --virtual-time-budget=9000 --dump-dom "$url" 2>/dev/null \
  | python3 -c "
import sys,html,re
s=sys.stdin.read()
m=re.search(r'<pre id=\"o\">(.*?)</pre>', s, re.S)
print(html.unescape(m.group(1)) if m else '(no output)')
"
