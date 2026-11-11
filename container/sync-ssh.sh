#!/usr/bin/env bash
# Copy the host SSH config/key used for the GPU server into container/ssh.
#   ./container/sync-ssh.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="$ROOT/container/ssh"
mkdir -p "$DST"
for file in id_ed25519 id_rsa known_hosts; do
  if [[ -f "$HOME/.ssh/$file" ]]; then cp -p "$HOME/.ssh/$file" "$DST/"; fi
done
cat > "$DST/config" <<'CONFIG'
Host 8818
  HostName 182.96.17.140
  User sl
  Port 8818
  IdentityFile /root/.ssh/id_ed25519
  IdentityFile /root/.ssh/id_rsa
  ProxyCommand socat - proxy:host.docker.internal:%h:%p,proxyport=7890
  StrictHostKeyChecking accept-new
  UserKnownHostsFile /root/.ssh/known_hosts
  ServerAliveInterval 30
  BatchMode yes
CONFIG
chmod 700 "$DST"
chmod 600 "$DST/config" "$DST/id_ed25519" "$DST/id_rsa" 2>/dev/null || true
chmod 644 "$DST/known_hosts" 2>/dev/null || true
echo "wrote $DST (gitignored)"
