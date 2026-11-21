#!/bin/bash
set -euo pipefail
umask 077
IRIVA_ROOT="${IRIVA_ROOT:-$HOME/.local/share/iriva-bot}"
IRIVA_NODE="$HOME/.local/bin/node"
cd "$IRIVA_ROOT"
exec "$IRIVA_NODE" --env-file=.env dist/src/main.js
