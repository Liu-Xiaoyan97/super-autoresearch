#!/usr/bin/env bash
# Copy the host's full Pi auth.json into the container agent directory.
#
#   ./container/sync-auth.sh
#   PI_AUTH_FILE=/path/auth.json ./container/sync-auth.sh
#
# The file contains API keys and OAuth tokens. It stays gitignored and is
# written with mode 600. Pi sessions read it at startup; start a new session
# (or restart the container) after copying.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${PI_AUTH_FILE:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json}"
DST="$ROOT/container/pi-home/auth.json"

if [[ ! -f "$SRC" ]]; then
  echo "error: $SRC not found" >&2
  exit 1
fi

mkdir -p "$(dirname "$DST")"
cp -p "$SRC" "$DST"
chmod 600 "$DST"

python3 - "$DST" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
print(f"wrote {path} (mode 600)")
print("providers:", ", ".join(sorted(data)) or "(none)")
print("types:", ", ".join(f"{k}={v.get('type')}" for k, v in sorted(data.items())))
PY

echo "Open a new Pi session (or restart the container) to use the updated auth."
