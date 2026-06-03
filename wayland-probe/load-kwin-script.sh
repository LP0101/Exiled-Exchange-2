#!/usr/bin/env bash
set -euo pipefail
SCRIPT="$(realpath "$(dirname "$0")/kwin-poe-tracker.js")"

qdbus_cmd=""
for cand in qdbus6 qdbus-qt6 qdbus; do
  if command -v "$cand" >/dev/null 2>&1; then
    qdbus_cmd="$cand"
    break
  fi
done
if [ -z "$qdbus_cmd" ]; then
  echo "No qdbus binary found (tried qdbus6, qdbus-qt6, qdbus). Install qt6-tools or kf6-tools." >&2
  exit 1
fi

echo "Using $qdbus_cmd"
echo "Loading $SCRIPT"
ID=$("$qdbus_cmd" org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "$SCRIPT")
echo "Script id=$ID"
"$qdbus_cmd" org.kde.KWin "/Scripting/Script$ID" org.kde.kwin.Script.run
echo "Started."
echo
echo "Tail with:"
echo "  journalctl --user -f --output=cat | grep '\[EE2\]'"
echo
echo "Unload with:"
echo "  $(dirname "$0")/unload-kwin-script.sh"
echo "$ID" > "$(dirname "$0")/.kwin-script-id"
