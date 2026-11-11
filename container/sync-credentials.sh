#!/usr/bin/env bash
# Copy this machine's opencode-go credential into the container environment.
#
#   ./container/sync-credentials.sh                 # read ~/.pi/agent/auth.json
#   PI_AUTH_FILE=/path/auth.json ./container/sync-credentials.sh
#   OPENCODE_API_KEY=sk-... ./container/sync-credentials.sh
#
# Writes container/.env (mode 600), which compose injects as OPENCODE_API_KEY.
# The key is never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/container/.env"
AUTH="${PI_AUTH_FILE:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json}"
MODEL="${RSI_MODEL:-deepseek-v4.1-flash}"
THINKING="${PI_REASONING_LEVEL:-high}"

python3 - "$AUTH" "$OUT" "$MODEL" "$THINKING" <<'PY'
import json, os, stat, sys
from urllib.parse import urlsplit, urlunsplit

auth_path, out_path, model, thinking = sys.argv[1:5]
key = os.environ.get("OPENCODE_API_KEY", "").strip()
source = "environment"
if not key:
    if not os.path.exists(auth_path):
        sys.exit(f"error: {auth_path} does not exist; set OPENCODE_API_KEY instead")
    data = json.load(open(auth_path))
    entry = data.get("opencode-go") or data.get("opencode") or {}
    key = str(entry.get("key") or "").strip()
    source = auth_path
if not key:
    sys.exit("error: no opencode-go key found; set OPENCODE_API_KEY instead")
if not key.startswith(("sk-", "opencode-")) and len(key) < 16:
    sys.exit("error: the copied credential does not look like an API key")

def container_proxy(value: str) -> str:
    """Rewrite a host-loopback proxy so the container can reach it."""
    if not value:
        return ""
    parts = urlsplit(value if "://" in value else f"http://{value}")
    host = parts.hostname or ""
    if host in {"127.0.0.1", "localhost", "::1"}:
        netloc = f"host.docker.internal:{parts.port or 7890}"
        parts = parts._replace(netloc=netloc)
    return urlunsplit(parts)

http_proxy = container_proxy(
    os.environ.get("CONTAINER_HTTP_PROXY")
    or os.environ.get("HTTP_PROXY")
    or os.environ.get("http_proxy")
    or ""
)
https_proxy = container_proxy(
    os.environ.get("CONTAINER_HTTPS_PROXY")
    or os.environ.get("HTTPS_PROXY")
    or os.environ.get("https_proxy")
    or http_proxy
)
no_proxy = os.environ.get(
    "CONTAINER_NO_PROXY", "localhost,127.0.0.1,.local,host.kiri.internal"
)

with open(out_path, "w", encoding="utf-8") as handle:
    handle.write(
        f"OPENCODE_API_KEY={key}\n"
        "PI_PROVIDER=opencode-go\n"
        f"PI_MODEL={model}\n"
        f"PI_REASONING_LEVEL={thinking}\n"
        f"CONTAINER_HTTP_PROXY={http_proxy}\n"
        f"CONTAINER_HTTPS_PROXY={https_proxy}\n"
        f"CONTAINER_NO_PROXY={no_proxy}\n"
    )
os.chmod(out_path, stat.S_IRUSR | stat.S_IWUSR)
print(f"wrote {out_path} (mode 600)")
print(f"source: {source}")
print(f"model: opencode-go/{model}  thinking: {thinking}")
PY
