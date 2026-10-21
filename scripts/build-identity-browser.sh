#!/usr/bin/env bash
set -euo pipefail
longball_root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$longball_root/.local/identity/browser-buildx"
longball_ca_secret=()
if [ -n "${CODEX_PROXY_CERT:-}" ]; then
  test -f "$CODEX_PROXY_CERT"
  longball_ca_secret=(--secret "id=proxy_ca,src=$CODEX_PROXY_CERT")
fi
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  BUILDX_CONFIG="$longball_root/.local/identity/browser-buildx" \
  docker --host=unix:///var/run/docker.sock build --progress=plain \
  "${longball_ca_secret[@]}" --tag longball-identity-browser:local \
  --file "$longball_root/infra/identity/browser.Dockerfile" "$longball_root/infra/identity"
