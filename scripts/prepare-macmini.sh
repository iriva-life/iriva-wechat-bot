#!/bin/bash
# Updates code only; never changes WeChat or activates services.
set -euo pipefail
IRIVA_SOURCE="$(cd "$(dirname "$0")/.." && pwd)"
IRIVA_SSH_HOST="${1:-macmini}"
cd "$IRIVA_SOURCE"
npm run check
rsync -az --exclude=node_modules --exclude=vendor --exclude=.env --exclude=data \
  --exclude=config/local.json --exclude=.git ./ "$IRIVA_SSH_HOST:/Users/ender/.local/share/iriva-bot/"
if ! ssh "$IRIVA_SSH_HOST" 'export PATH="/Users/ender/.local/bin:$PATH"; export HTTPS_PROXY=http://127.0.0.1:7897; export HTTP_PROXY=http://127.0.0.1:7897; export NO_PROXY=localhost,127.0.0.1,::1; cd /Users/ender/.local/share/iriva-bot && npm ci --ignore-scripts --fetch-timeout=20000 --fetch-retries=1'; then
  IRIVA_LOCAL_PLATFORM="$(node -p 'process.platform+":"+process.arch')"
  IRIVA_REMOTE_PLATFORM="$(ssh "$IRIVA_SSH_HOST" '/Users/ender/.local/bin/node -p '\''process.platform+":"+process.arch'\''')"
  test "$IRIVA_LOCAL_PLATFORM" = "$IRIVA_REMOTE_PLATFORM" || { echo 'Offline dependencies require matching OS/CPU'; exit 1; }
  echo 'Registry unavailable; copying locally validated dependencies for the matching OS/CPU.'
  rsync -az node_modules/ "$IRIVA_SSH_HOST:/Users/ender/.local/share/iriva-bot/node_modules/"
fi
ssh "$IRIVA_SSH_HOST" 'export PATH="/Users/ender/.local/bin:$PATH"; cd /Users/ender/.local/share/iriva-bot && npm ls --depth=0 && npm run check'
