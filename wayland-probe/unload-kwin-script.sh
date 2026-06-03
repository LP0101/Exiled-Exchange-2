#!/usr/bin/env bash
set -euo pipefail
ID_FILE="$(dirname "$0")/.kwin-script-id"
qdbus_cmd=""
for cand in qdbus6 qdbus-qt6 qdbus; do
  if command -v "$cand" >/dev/null 2>&1; then
    qdbus_cmd="$cand"
    break
  fi
done
if [ -z "$qdbus_cmd" ]; then
  echo "No qdbus binary found." >&2
  exit 1
fi

if [ ! -f "$ID_FILE" ]; then
  echo "No saved script id (.kwin-script-id missing). Trying unloadScript by path." >&2
  "$qdbus_cmd" org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript \
    "$(realpath "$(dirname "$0")/kwin-poe-tracker.js")" || true
  exit 0
fi

ID="$(cat "$ID_FILE")"
echo "Stopping script id=$ID"
"$qdbus_cmd" org.kde.KWin "/Scripting/Script$ID" org.kde.kwin.Script.stop || true
"$qdbus_cmd" org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript \
  "$(realpath "$(dirname "$0")/kwin-poe-tracker.js")" || true
rm -f "$ID_FILE"
echo "Unloaded."
