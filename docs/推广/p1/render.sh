#!/bin/bash
# 渲染 docs/推广/p1/html/*.html → docs/推广/p1/out/*.png
#
# 用法:  ./render.sh [前缀]        渲染全部,或只渲染匹配前缀的 html
# 高度:  默认读 html 里的 <meta name="page-height" content="N">;
#        没有该 meta 时自动量取 body 实际高度(长图 A/B 用得上)。
# 尺寸:  固定 1080 宽,2 倍输出(实际 2160 宽),小红书压图后依然锐利。
set -e
B="/Users/maiwy/workspace/cc-gui/docs/推广/p1"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p "$B/out"

shopt -s nullglob
targets=("$B"/html/*.html)
[ -n "$1" ] && targets=("$B"/html/"$1"*.html)

for f in "${targets[@]}"; do
  name=$(basename "$f" .html)
  case "$name" in _*) continue;; esac          # 跳过 _preview / _zoom 等工具页
  out="$B/out/$name.png"

  # ── 定高:meta 优先,否则量 body ────────────────────────────────
  h=$(node /tmp/au_measure.js "$f")
  size="1080,$h"

  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size="$size" \
    --virtual-time-budget=15000 \
    --screenshot="$out" "file://$f" 2>/dev/null

  # 复核:有 meta 时如果实际高度对不上,说明内容溢出了,直接报出来
  real=$(sips -g pixelHeight "$out" | awk '/pixelHeight/{print $2/2}')
  warn=""
  [ "$real" != "$h" ] && warn="  ⚠ 期望 $h 实际 $real(内容可能溢出)"
  printf "✓ %-14s %sx%s@2x%s\n" "$name.png" "1080" "$h" "$warn"
done
