#!/bin/bash
# Finder entry point; follow the Desktop symlink back to the project root.
set -u
umask 077
entry="${BASH_SOURCE[0]}"
while [ -L "$entry" ]; do
  base="$(cd "$(dirname "$entry")" && pwd)"
  entry="$(readlink "$entry")"
  [[ "$entry" = /* ]] || entry="$base/$entry"
done
cd "$(dirname "$entry")" || exit 1
iriva_node="$HOME/.local/bin/node"
if [ ! -x "$iriva_node" ] || [ ! -f dist/scripts/desktop-launcher.js ] || [ ! -f .env ]; then
  echo '尚未完成部署：需要 Node、构建产物和本机 .env。请看根目录 MACMINI.md。'
  result=1
else
  "$iriva_node" --env-file=.env dist/scripts/desktop-launcher.js "$@"
  result=$?
fi
echo
if [ "$result" -ne 0 ]; then echo '启动未完成，以上提示需要处理。'; fi
if [ -t 0 ]; then read -r -p '按回车关闭此窗口…' _; fi
exit "$result"
