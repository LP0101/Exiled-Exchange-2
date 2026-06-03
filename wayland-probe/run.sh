#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ELECTRON_OZONE_PLATFORM_HINT=x11 \
XDG_SESSION_TYPE=x11 \
exec ../main/node_modules/.bin/electron .
