#!/usr/bin/env bash
# Container bootstrap: SSH/rsync/socat + SSH key/config.
# Runs at container start and from `./container/up.sh bootstrap`.
# Idempotent; verifies the image-provided deterministic-code toolchain.
set -uo pipefail

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

# Keep declared Pi packages available after a container/image rebuild. The
# package directory is a bind-mounted agent home, but a fresh host may not have
# the npm install yet; settings.json still declares the package.
if command -v pi >/dev/null 2>&1; then
  if [[ ! -d /root/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question ]]; then
    if ! pi install npm:@juicesharp/rpiv-ask-user-question; then
      echo "[bootstrap] warning: could not install @juicesharp/rpiv-ask-user-question; check npm/proxy" >&2
    fi
  fi
fi


# Open-box deterministic-code toolchain verification. These binaries are
# installed by container/Dockerfile; startup must never silently install them.
missing_tools=()
for tool in ssh rsync socat python3 pyright pyright-langserver ruff pytest rustc cargo rust-analyzer go gopls; do
  command -v "$tool" >/dev/null 2>&1 || missing_tools+=("$tool")
done
if ((${#missing_tools[@]})); then
  echo "[bootstrap] missing deterministic-code tools: ${missing_tools[*]}" >&2
  exit 1
fi
echo "[bootstrap] deterministic Python/Rust/Go toolchain ready"
