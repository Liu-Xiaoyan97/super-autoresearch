#!/usr/bin/env bash
# Container bootstrap: SSH/rsync/socat + SSH key/config.
# Runs at container start and from `./container/up.sh bootstrap`.
# Idempotent; never blocks Pi if apt is unreachable.
set -uo pipefail

APT_PROXY="${CONTAINER_APT_PROXY:-http://host.docker.internal:7890}"
missing=()
for binary in ssh rsync socat; do
  command -v "$binary" >/dev/null 2>&1 || missing+=("$binary")
done

if ((${#missing[@]})); then
  echo "[bootstrap] installing: ${missing[*]}"
  apt-get -o Acquire::http::Proxy="$APT_PROXY" \
          -o Acquire::https::Proxy="$APT_PROXY" update -qq >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get \
    -o Acquire::http::Proxy="$APT_PROXY" \
    -o Acquire::https::Proxy="$APT_PROXY" \
    install -y -qq openssh-client rsync socat >/dev/null 2>&1 \
    || echo "[bootstrap] warning: apt install failed; check CONTAINER_APT_PROXY" >&2
fi

# Compose normally mounts container/ssh at /root/.ssh (read-only). For a
# container created before that mount existed, copy the same files in.
if [[ ! -f /root/.ssh/config && -d /workspace/RSI/container/ssh ]]; then
  mkdir -p /root/.ssh
  cp -a /workspace/RSI/container/ssh/. /root/.ssh/ 2>/dev/null || true
fi
if [[ -d /root/.ssh ]]; then
  chmod 700 /root/.ssh 2>/dev/null || true
  chmod 600 /root/.ssh/config /root/.ssh/id_ed25519 /root/.ssh/id_rsa 2>/dev/null || true
  chmod 644 /root/.ssh/known_hosts 2>/dev/null || true
fi

if command -v ssh >/dev/null 2>&1 && [[ -f /root/.ssh/config ]]; then
  echo "[bootstrap] ssh/rsync/socat ready"
else
  echo "[bootstrap] warning: ssh tooling or /root/.ssh config is incomplete" >&2
fi
