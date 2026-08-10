#!/usr/bin/env bash
# 从 resources/icon.png 生成 icon.icns（仅 macOS，依赖 sips + iconutil）；512/1024 档由 256 放大，略糊属预期。
# 用法：在项目根目录执行  bash scripts/generate-icns.sh
set -euo pipefail

SRC="resources/icon.png"
OUT="resources/icon.icns"

if [[ ! -f "$SRC" ]]; then
  echo "找不到 $SRC" >&2
  exit 1
fi
if ! command -v sips >/dev/null 2>&1 || ! command -v iconutil >/dev/null 2>&1; then
  echo "需要 macOS 自带的 sips 与 iconutil（本脚本只能在 macOS 上跑）" >&2
  exit 1
fi

TMP="$(mktemp -d)/icon.iconset"
mkdir -p "$TMP"

# icns 规范档位：base 与 @2x（@2x = base*2）
gen() { # $1=base
  local b="$1" d=$(( $1 * 2 ))
  sips -z "$b" "$b" "$SRC" --out "$TMP/icon_${b}x${b}.png"     >/dev/null
  sips -z "$d" "$d" "$SRC" --out "$TMP/icon_${b}x${b}@2x.png"  >/dev/null
}
for b in 16 32 128 256 512; do gen "$b"; done

iconutil -c icns "$TMP" -o "$OUT"
echo "已生成 $OUT"
