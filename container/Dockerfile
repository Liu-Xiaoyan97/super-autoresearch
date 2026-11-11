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

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_REGISTRY=${NPM_REGISTRY} \
    PI_CODING_AGENT_DIR=/root/.pi/agent \
    PI_PROVIDER=opencode-go \
    PI_MODEL=deepseek-v4.1-flash

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq ripgrep \
      python3 python3-venv make \
 && rm -rf /var/lib/apt/lists/*

# Pi ships platform binaries through npm; --ignore-scripts matches the official
# container recipe and avoids running arbitrary package lifecycle scripts.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} \
 && pi --version

WORKDIR /workspace/RSI

# Keep the container alive; `kiri exec` / `kiri compose exec` runs the actual work.
ENTRYPOINT ["/bin/bash"]
CMD ["-lc", "while sleep 3600; do :; done"]
