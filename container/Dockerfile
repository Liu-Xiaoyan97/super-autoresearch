# pi-agent container for the RSI extension.
#
# Built with Kiri (Docker-compatible) on macOS:
#   ./container/up.sh build
#   ./container/up.sh run
#
# The base image is pulled through a Docker Hub mirror; the build itself runs in
# Kiri's BuildKit. Override BASE_IMAGE (for example node:24-bookworm-slim, when
# it is already present locally) or PI_VERSION to pin another release.
ARG BASE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim
FROM ${BASE_IMAGE}

ARG PI_VERSION=1.5.2
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PYRIGHT_VERSION=1.1.414
ARG RUFF_VERSION=0.17.3
ARG PYTEST_VERSION=9.2.0
ARG RUST_VERSION=1.99.0
ARG GO_VERSION=1.27.2
ARG GOPLS_VERSION=v0.24.0
# Optional build-time apt/npm proxy, e.g. http://host.docker.internal:7890
ARG APT_PROXY
ARG NPM_PROXY

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_REGISTRY=${NPM_REGISTRY} \
    PI_CODING_AGENT_DIR=/root/.pi/agent \
    PI_PROVIDER=opencode-go \
    PI_MODEL=deepseek-v4.1-flash \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    GOTOOLCHAIN=local \
    GOPATH=/root/go \
    GOBIN=/usr/local/bin \
    PATH=/opt/rsi-tools/bin:/usr/local/cargo/bin:/usr/local/go/bin:/root/go/bin:$PATH

# `bash -lc` resets PATH from /etc/profile; keep the embedded toolchain visible
# in the same login-shell mode used by the container and Pi.
RUN printf '%s\n' 'export PATH=/opt/rsi-tools/bin:/usr/local/cargo/bin:/usr/local/go/bin:/root/go/bin:$PATH' > /etc/profile.d/rsi-tools.sh \
 && chmod 0644 /etc/profile.d/rsi-tools.sh

RUN if [ -n "$APT_PROXY" ]; then \
      printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' "$APT_PROXY" "$APT_PROXY" > /etc/apt/apt.conf.d/01proxy; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq ripgrep openssh-client rsync socat \
      python3 python3-venv python3-matplotlib make \
      build-essential pkg-config xz-utils \
 && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/01proxy

# Python check tools live in a disposable venv, never in Debian's managed
# interpreter. The target's own environment remains responsible for its
# training/evaluation packages.
RUN python3 -m venv /opt/rsi-tools \
 && proxy_arg=""; if [ -n "${NPM_PROXY}" ]; then proxy_arg="--proxy ${NPM_PROXY}"; fi; \
    /opt/rsi-tools/bin/python -m pip install --no-cache-dir ${proxy_arg} \
      "ruff==${RUFF_VERSION}" "pytest==${PYTEST_VERSION}"

# Pyright supplies both `pyright` (typecheck CLI) and `pyright-langserver` (LSP).
RUN NPM_CONFIG_PROXY=${NPM_PROXY} NPM_CONFIG_HTTPS_PROXY=${NPM_PROXY} \
    npm install -g --ignore-scripts "pyright@${PYRIGHT_VERSION}"

# Rust compiler, clippy, rustfmt and rust-analyzer. Keep the actual installed
# toolchain; runtime rustup proxies could try to download another toolchain.
RUN export HTTPS_PROXY="${NPM_PROXY}" HTTP_PROXY="${NPM_PROXY}"; \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" \
          --component rust-analyzer --component clippy --component rustfmt \
 && rustc --version && cargo --version && rust-analyzer --version

# Go SDK and the Go language server. GOTOOLCHAIN=local prevents a target
# go.mod from silently downloading a different toolchain; GOPROXY may be
# overridden by the target adapter only after dependencies are prepared.
RUN arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) goarch=amd64 ;; \
      aarch64|arm64) goarch=arm64 ;; \
      *) echo "unsupported build architecture: $arch" >&2; exit 1 ;; \
    esac; \
    export HTTPS_PROXY="${NPM_PROXY}" HTTP_PROXY="${NPM_PROXY}"; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${goarch}.tar.gz" \
      | tar -C /usr/local -xz; \
    GOTOOLCHAIN=local CGO_ENABLED=0 go install "golang.org/x/tools/gopls@${GOPLS_VERSION}"; \
    go version && gopls version

# Pi ships platform binaries through npm; --ignore-scripts matches the official
# container recipe and avoids running arbitrary package lifecycle scripts.
RUN NPM_CONFIG_PROXY=${NPM_PROXY} NPM_CONFIG_HTTPS_PROXY=${NPM_PROXY} \
    npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} \
 && pi --version

WORKDIR /workspace/RSI

# Keep the container alive; `kiri exec` / `kiri compose exec` runs the actual work.
ENTRYPOINT ["/bin/bash"]
CMD ["-lc", "while sleep 3600; do :; done"]
