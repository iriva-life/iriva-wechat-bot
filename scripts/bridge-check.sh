#!/usr/bin/env bash
# Read-only; prints environment/version/signature checks, never accounts or chat contents.
set -euo pipefail
app_path="${1:-/Applications/WeChat.app}"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Requires Apple Silicon macOS'; exit 1; }
plist_path="$app_path/Contents/Info.plist"
[[ -f "$plist_path" ]] || { echo 'WeChat app missing'; exit 1; }
version="$(/usr/libexec/PlistBuddy -c 'Print :WeChatBundleVersion' "$plist_path")"
build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist_path")"
printf 'WeChat version=%s build=%s\n' "$version" "$build"
[[ "$version" == 4.1.15.55 && "$build" == 270135 ]] || { echo 'Target version mismatch; stop'; exit 1; }
if /usr/bin/pgrep -x WeChat >/dev/null; then echo 'WeChat running: yes (must quit before installation)'; else echo 'WeChat running: no'; fi
if /usr/bin/codesign --verify --strict "$app_path" >/dev/null 2>&1; then echo 'Bundle signature valid: yes'; else echo 'Bundle signature valid: no'; fi
if /usr/bin/codesign -dv "$app_path" 2>&1 | /usr/bin/grep -q 'Signature=adhoc'; then echo 'Signing mode: ad-hoc'; else echo 'Signing mode: inspect original authority before backup'; fi
if /usr/bin/xcrun --find otool >/dev/null 2>&1; then
  if /usr/bin/otool -L "$app_path/Contents/MacOS/WeChat" | /usr/bin/grep -q FridaGadget; then echo 'Gadget load command: present'; else echo 'Gadget load command: absent'; fi
else echo 'Command Line Tools missing'; fi
[[ ! -e "$app_path/Contents/_MASReceipt/receipt" ]] || echo 'App Store receipt present: install compatibility needs review'
if [[ -w "$app_path" ]]; then echo 'App writable: yes'; else echo 'App writable: no'; fi
echo 'No install, process stop, account lookup, or message send performed.'
