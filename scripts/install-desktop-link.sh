#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
target="$root/启动 IRIVA.command"
link="$HOME/Desktop/启动 IRIVA.command"
chmod +x "$target"
if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
  echo "桌面启动入口已存在：$link"
elif [ -e "$link" ] || [ -L "$link" ]; then
  echo "桌面已有同名文件，未覆盖：$link" >&2
  exit 1
else
  ln -s "$target" "$link"
  echo "已创建桌面启动入口：$link"
fi
