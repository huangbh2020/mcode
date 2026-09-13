#!/bin/bash
# 放大查看成图局部: ./zoom.sh <png> <x> <y> <w> <h> [zoom] [srcScale]
#
# 成图默认是 2 倍输出(2160 宽),所以坐标按 1080 宽的 CSS 像素给,
# 工具自动换算到 2x 像素。源图是 1x 时(比如坐标网格图)传 srcScale=1。
set -e
B="/Users/maiwy/workspace/cc-gui/docs/推广/p1"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
png="$1"; x="$2"; y="$3"; w="$4"; h="$5"; z="${6:-2}"; ss="${7:-2}"

x2=$(node -e "console.log($x*$ss)"); y2=$(node -e "console.log($y*$ss)")
w2=$(node -e "console.log($w*$ss)"); h2=$(node -e "console.log($h*$ss)")
name=$(basename "$png" .png)
url="file://$B/html/_zoom.html#$png@$x2,$y2,$w2,$h2,$z"
"$CHROME" --headless --disable-gpu --hide-scrollbars --allow-file-access-from-files \
  --window-size="$w2,$h2" --force-device-scale-factor="$ss" --virtual-time-budget=6000 \
  --screenshot="$B/out/_zoom-$name.png" "$url" 2>/dev/null
echo "✓ out/_zoom-$name.png  (源 ${w}x${h} @${z}x)"
